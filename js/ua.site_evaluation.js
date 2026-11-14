(() => {
  'use strict';

  const UA = window.UA = window.UA || {};
  const maxYears = 3;
  const openTrafficViews = new WeakMap();

  function secureSource(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048;
    } catch {
      return false;
    }
  }

  function isImplementation(event) {
    if (!event || !['in-service', 'implemented'].includes(event.kind) || !secureSource(event.url)
        || !['month', 'day'].includes(event.precision) || typeof event.date !== 'string') return false;
    const day = event.precision === 'month' ? event.date + '-01' : event.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const time = new Date(day + 'T00:00:00Z');
    return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === day && time <= new Date();
  }

  function keyFor(ctx, selection) {
    const {south, west, north, east} = selection.bounds;
    return [ctx.CITY_RAW, selection.site?.id || 'area', selection.site?.revision || '', south, west, north, east].join('|');
  }

  function localEvent(ctx, selection) {
    const search = new URLSearchParams(window.location.search);
    if (search.get('siteEvalPlace') !== keyFor(ctx, selection)) return null;
    const event = {kind: 'in-service', date: search.get('siteEvalMonth'), precision: 'month',
      url: search.get('siteEvalSource'), label: 'Vom Nutzer angegebener Umsetzungsbeleg'};
    return isImplementation(event) ? event : null;
  }

  function targetPoints(ctx, selection, points) {
    const query = {...selection.query, fromYear: null, toYear: null};
    const population = query.mapFilters ? points.filter(point => {
      const mask = UA.maskFromProps(point.props);
      return mask && UA.matchesNonInvolvementFilters(ctx, point.props) && UA.matchesInvolvementFilter(ctx, mask);
    }) : points;
    const filtered = UA.SiteDiscovery.filterPoints(population, query);
    return selection.pattern?.key
      ? UA.SiteDiscovery.patternForPoints(filtered, selection.pattern.key)?.points || []
      : filtered;
  }

  function period(points, years) {
    const included = new Set(years);
    const rows = points.filter(point => included.has(UA.SiteDiscovery.yearOf(point)));
    return {years, count: rows.length, severe: rows.filter(p => ['1','2'].includes(String(p.props.ukategorie))).length};
  }

  function separate(a, b) {
    return a.north < b.south || a.south > b.north || a.east < b.west || a.west > b.east;
  }

  function contextualPeers(ctx, selection, before, after) {
    const index = ctx.reviewNetworkResult;
    if (!selection.site || index?.network.revision !== selection.site.revision) return [];
    const site = index.network.sites.get(selection.site.id);
    if (!site) return [];
    const middle = b => [(b.north + b.south) / 2, (b.east + b.west) / 2];
    const [lat, lon] = middle(site.bounds);
    const scale = Math.cos(lat * Math.PI / 180);
    const peers = [];
    // Select on geography and site type before looking at crash counts, including zero-case peers.
    for (const peer of index.network.sites.values()) {
      if (peer.kind !== site.kind || !separate(site.bounds, peer.bounds) || peer.changes?.length) continue;
      const [y, x] = middle(peer.bounds);
      const metres = Math.hypot(y - lat, (x - lon) * scale) * 111195;
      if (metres <= 1000) peers.push({peer, metres});
    }
    return peers.sort((a,b) => a.metres - b.metres || a.peer.id.localeCompare(b.peer.id)).slice(0, 5).map(({peer, metres}) => {
      const points = targetPoints(ctx, selection, index.bySite.get(peer.id) || []);
      return {id:peer.id, label:peer.label, distance: Math.round(metres), before:period(points,before), after:period(points,after)};
    });
  }

  function measuredTraffic(points, before, after) {
    const available = new Set([...before,...after]);
    const seen = new Set();
    const rows = [];
    for (const point of points) {
      const p = point.props;
      const o = p?.traffic_evidence?.observation;
      if (!o || p.traffic_measurement_type !== 'count' || !available.has(o.year)
          || !UA.trafficProvider?.hasUsableTypedEvidence(p, {mode:o.mode})) continue;
      const key = JSON.stringify([o.sourceId,o.observationId]);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({year:o.year, value:o.value, unit:o.unit, period:o.period, direction:o.direction,
        source:o.sourceId, id:o.observationId, side:before.includes(o.year) ? 'vorher' : 'nachher'});
    }
    return rows.sort((a,b) => a.year - b.year || a.id.localeCompare(b.id));
  }

  function stationResults(node, ctx, selection, before, after) {
    node.replaceChildren();
    const read = UA.HannoverLayers?.stationReadings;
    if (!read) return;
    const rows = [];
    for (const [side, period] of [['vorher', before], ['nachher', after]]) {
      for (const year of period.years) {
        const readings = read(ctx, selection.bounds, {fromYear: year, toYear: year});
        for (const reading of readings) rows.push({ side, reading });
      }
    }
    if (!rows.length) return;
    const details = element('details'), list = element('ul');
    details.append(element('summary', 'Radzählungen an VMZ-Stationen im Rechteck'), list);
    for (const {side, reading} of rows) {
      const row = element('li', side + ' · ');
      const link = element('a', reading.name);
      link.href = reading.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link, ' · ' + reading.text);
      list.append(row);
    }
    details.append(element('p', 'Der Messwert gilt am Zählpunkt. Angezeigt werden die letzten verfügbaren Tages- und Monatswerte je Station und Kalenderjahr aus der lokal geladenen Datei. Die Abdeckung kann unvollständig sein.'));
    node.append(details);
  }

  function refreshTraffic(ctx) {
    const view = openTrafficViews.get(ctx);
    if (!view) return;
    if (view.node.isConnected) view.update();
    else openTrafficViews.delete(ctx);
  }

  function completeSelection(ctx, selection) {
    const coverage = ctx.accidentDataCoverage;
    return selection.complete && !selection.networkStatus && coverage?.complete === true
      && coverage.city === ctx.CITY_RAW;
  }

  function releasedYears(ctx, release) {
    if (ctx.accidentDataCoverage.provider !== 'static' || release?.schemaVersion !== 1
        || release.contract !== 'unfallwerkbank-accident-data-release/v1' || !Array.isArray(release.cities)) return null;
    const slug = UA.normKey(ctx.CITY_RAW);
    const city = release.cities.find(row => row?.slug === slug);
    if (!Array.isArray(city?.years) || !city.byYear || !Array.isArray(ctx.allPts)) return null;
    const loaded = new Map();
    for (const point of ctx.allPts) {
      const year = UA.SiteDiscovery.yearOf(point);
      loaded.set(year, (loaded.get(year) || 0) + 1);
    }
    const currentYear = new Date().getUTCFullYear();
    return new Set(city.years.filter(year => Number.isInteger(year) && year < currentYear
      && Number.isInteger(city.byYear[year]) && city.byYear[year] === (loaded.get(year) || 0)));
  }

  function evaluate({ctx, selection, implementation, release}) {
    if (!isImplementation(implementation)) return {status:'no-date'};
    if (!completeSelection(ctx, selection)) return {status:'incomplete'};
    const available = releasedYears(ctx, release);
    if (!available) return {status:'unverified-years'};
    const year = Number(implementation.date.slice(0,4));
    const before = [], after = [];
    for (let offset = 1; offset <= maxYears && available.has(year-offset) && available.has(year+offset); offset++) {
      before.unshift(year-offset);
      after.push(year+offset);
    }
    if (!before.length) return {status:'waiting', beforeNeeded:year-1, afterNeeded:year+1};
    const siteResult = ctx.reviewNetworkResult;
    if (selection.site && (siteResult?.network?.revision !== selection.site.revision
        || !siteResult.network.sites.has(selection.site.id))) return {status:'incomplete'};
    const all = selection.site ? siteResult.bySite.get(selection.site.id) || [] : selection.areaPoints;
    if (!Array.isArray(all)) return {status:'incomplete'};
    const points = targetPoints(ctx, selection, all);
    return {status:'observed', before:period(points,before), after:period(points,after),
      reference:contextualPeers(ctx,selection,before,after), traffic:measuredTraffic(all,before,after)};
  }

  function element(tag, value) {
    const node = document.createElement(tag);
    if (value != null) node.textContent = value;
    return node;
  }

  function periodLabel(years) {
    return years.length === 1 ? String(years[0]) : years[0] + '–' + years[years.length-1];
  }

  function results(box, result, selection, ctx) {
    if (result.status === 'incomplete') {
      box.append(element('p','Für diesen Vergleich werden der vollständige Stadtdatensatz und die gewählte Ortszuordnung benötigt.'));
      return;
    }
    if (result.status === 'unverified-years') {
      box.append(element('p','Wirkung offen. Für diesen Datenbestand fehlt der Nachweis der Jahresabdeckung. Der Vergleich benötigt veröffentlichte Jahreszahlen für die gewählte Stadt.'));
      return;
    }
    if (result.status === 'waiting') {
      box.append(element('p','Wirkung offen. Für den ersten Vergleich werden die vollständigen Unfalljahrgänge '
        + result.beforeNeeded + ' und ' + result.afterNeeded + ' benötigt.'));
      return;
    }
    box.append(element('p',(selection.pattern?.label || 'Unfälle nach den gewählten Suchkriterien')
      + ' · Vergleich abgeschlossener Kalenderjahre ohne das Jahr der Inbetriebnahme. Die stadtweiten Fallzahlen der verwendeten Jahre stimmen mit der veröffentlichten Unfallatlas-Lieferung überein. Die Jahre des Suchfilters gelten nur für die Stellensuche.'));
    const table = element('table');
    table.append(element('caption','Unfälle im gewählten Gebiet oder am Netzobjekt'));
    const header = table.createTHead().insertRow();
    for (const label of ['Zeitraum','Unfälle','Davon mit schweren oder tödlichen Folgen']) header.append(element('th',label));
    const body = table.createTBody();
    for (const [label, p] of [['Vorher',result.before],['Nachher',result.after]]) {
      const row = body.insertRow();
      row.append(element('th',label + ' ' + periodLabel(p.years)), element('td',p.count), element('td',p.severe));
    }
    box.append(table);
    if (result.reference.length) {
      const details = element('details'), list = element('ul');
      details.append(element('summary','Vergleich mit benachbarten Netzstellen'),list);
      for (const peer of result.reference) list.append(element('li',peer.label + ' (' + peer.distance + ' m): '
        + peer.before.count + ' vorher, ' + peer.after.count + ' nachher.'));
      details.append(element('p','Bis zu fünf nächstgelegene Stellen desselben Typs im Umkreis von 1 km ohne hinterlegte Änderungen. Ob sie unbehandelt blieben und ähnlich stark befahren sind, ist offen.'));
      box.append(details);
    } else box.append(element('p','Für diesen Ort sind keine vergleichbaren Netzstellen im Auswertungsbereich verfügbar.'));
    if (result.traffic.length) {
      const traffic = element('details'), list = element('ul');
      traffic.append(element('summary','Zugeordnete Verkehrszählungen vorher und nachher'),list);
      for (const row of result.traffic) list.append(element('li',[row.side,row.period,row.direction,
        Number(row.value).toLocaleString('de-DE') + ' ' + row.unit,row.source,row.id].filter(Boolean).join(' · ')));
      box.append(traffic);
    } else box.append(element('p','Für diese Vergleichszeiträume sind hier keine geprüften Verkehrszählungen zugeordnet.'));
    if (UA.HannoverLayers?.stationReadings) {
      const node = element('div');
      box.append(node);
      const update = () => stationResults(node, ctx, selection, result.before, result.after);
      openTrafficViews.set(ctx, {node, update});
      update();
    }
    box.append(element('p','Wirkung offen. Fallzahlen können zufällig schwanken, besonders nach einer auffälligen Häufung. Verkehrsmengen, weitere Umbauten und das örtliche Unfallgeschehen gehören zur fachlichen Prüfung.'));
  }

  function inputRow(form, title, type, initial) {
    const label = element('label',title + ' ');
    const input = element('input');
    input.type = type;
    input.required = true;
    input.value = initial || '';
    label.append(input);
    form.append(label);
    return input;
  }

  function render(container, {ctx,selection,implementation}) {
    if (!container || !selection?.bounds) return;
    const documented = isImplementation(implementation) ? implementation : null;
    const userEvent = localEvent(ctx,selection);
    const active = documented || userEvent;
    const box = element('details');
    box.className = 'site-evaluation';
    box.append(element('summary','Wirkungskontrolle'));
    container.append(box);
    if (active) {
      const link = element('a',active.label || 'Umsetzungsbeleg');
      link.href = active.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const info = element('p','In Betrieb seit ' + active.date + ' · ');
      info.append(link);
      box.append(info);
      const output = element('div');
      box.append(output);
      let checking = false;
      const display = async () => {
        if (!box.open || checking) return;
        const city = ctx.CITY_RAW, points = ctx.allPts;
        let release = null;
        if (completeSelection(ctx, selection) && ctx.accidentDataCoverage.provider === 'static') {
          checking = true;
          output.textContent = 'Jahresabdeckung wird geprüft …';
          try {
            release = await UA.DataResources?.fetchJson('accidentRelease', {}, {optional:true});
          } catch { /* Unavailable release evidence leaves the comparison open. */ }
          checking = false;
          if (!box.isConnected || ctx.CITY_RAW !== city || ctx.allPts !== points) return;
        }
        const result = evaluate({ctx, selection, implementation:active, release});
        if (release || result.status !== 'unverified-years' || ctx.accidentDataCoverage?.provider !== 'static') {
          box.removeEventListener('toggle', display);
        }
        output.replaceChildren();
        results(output, result, selection, ctx);
      };
      box.addEventListener('toggle', display);
    } else box.append(element('p','Wirkung offen. Für diesen Ort fehlt ein belegter Zeitpunkt der Inbetriebnahme.'));
    if (documented) return;
    const form = element('form');
    const month = inputRow(form,'Monat der tatsächlichen Inbetriebnahme','month',userEvent?.date);
    month.max = new Date().toISOString().slice(0,7);
    const source = inputRow(form,'Link zum Umsetzungsbeleg','url',userEvent?.url);
    const save = element('button','Mit diesem Beleg vergleichen');
    save.type = 'submit';
    const feedback = element('p');
    feedback.setAttribute('role','status');
    form.append(save,feedback);
    const refresh = updates => {
      UA.setQS(updates);
      box.remove();
      render(container,{ctx,selection,implementation});
      const current = container.querySelector('.site-evaluation');
      if (current) { current.open = true; current.querySelector('summary')?.focus(); }
    };
    form.addEventListener('submit', e => {
      e.preventDefault();
      const entry = {kind:'in-service',precision:'month',date:month.value,url:source.value.trim()};
      if (!isImplementation(entry)) {feedback.textContent = 'Bitte einen vergangenen oder aktuellen Monat und eine vollständige HTTPS-Quellenadresse angeben.'; return;}
      refresh({siteEvalPlace:keyFor(ctx,selection),siteEvalMonth:entry.date,siteEvalSource:entry.url});
    });
    if (userEvent) {
      const remove = element('button','Eigenen Beleg entfernen');
      remove.type = 'button';
      remove.addEventListener('click',() => refresh({siteEvalPlace:null,siteEvalMonth:null,siteEvalSource:null}));
      form.append(remove);
    }
    box.append(form);
  }

  UA.SiteEvaluation = Object.freeze({evaluate, render, isImplementation, refreshTraffic});
})();
