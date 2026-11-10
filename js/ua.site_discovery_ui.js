(() => {
  'use strict';

  const UA = window.UA = window.UA || {};
  const panels = new WeakMap();
  const listPage = 12;
  const clusterLimits = { paddingMeters: 16, maxSpanMeters: 320 };
  const allQuery = Object.freeze({ fromYear: null, toYear: null, severity: 'all', type: 'all', involvement: 'all' });
  const typeLabels = {
    1: 'Fahrunfall', 2: 'Abbiegeunfall', 3: 'Einbiegen / Kreuzen', 4: 'Überschreiten',
    5: 'Ruhender Verkehr', 6: 'Längsverkehr', 7: 'Sonstiger Unfall',
  };
  const severityLabels = {
    1: 'Mit Getöteten', 2: 'Mit Schwerverletzten', 3: 'Mit Leichtverletzten',
  };
  const kindLabels = { site: 'Dokumentierter Ort', segment: 'Straßenabschnitt', cell: 'Suchzelle' };
  const number = new Intl.NumberFormat('de-DE');
  const sameBounds = (a, b) => !!a && !!b && ['south', 'west', 'north', 'east'].every(k => a[k] === b[k]);

  function areaBounds(ctx) {
    const b = ctx.selectionBounds;
    return b && { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, action) {
    const node = el('button', 'btn', label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function setFocus(ctx, focus) {
    if (UA.setDiscoveryFocus) UA.setDiscoveryFocus(ctx, focus);
    else if (focus) ctx.discoveryFocus = focus;
    else delete ctx.discoveryFocus;
  }

  function resetDetail(ctx, state) {
    if (state?.markerLayer) ctx.map.removeLayer(state.markerLayer);
    if (!state) return;
    state.markerLayer = null;
    state.detail.replaceChildren();
    state.detail.hidden = true;
    state.selection = null;
    state.rows.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
  }

  function selectionChanged(ctx) {
    const state = panels.get(ctx);
    const bounds = areaBounds(ctx);
    const cityChanged = state && state.city !== ctx.CITY_RAW;
    if (ctx.discoveryFocus && (cityChanged || !sameBounds(ctx.discoveryFocus.bounds, bounds))) setFocus(ctx, null);
    if (state && (cityChanged || (state.selection && !sameBounds(state.selection.bounds, bounds)))) resetDetail(ctx, state);
  }

  function pointsInArea(ctx, bounds) {
    return (ctx.allPts || []).filter(p => p.lat >= bounds.south && p.lat <= bounds.north
      && p.lon >= bounds.west && p.lon <= bounds.east);
  }

  function countText(count, singular, plural) {
    return number.format(count) + ' ' + (count === 1 ? singular : plural);
  }

  function sourceDate(date, precision) {
    if (!date) return 'Datum nicht angegeben';
    const [year, month, day] = String(date).split('-');
    const value = day ? day + '.' + month + '.' + year : month ? month + '.' + year : year;
    if (precision === 'documented-by') return 'dokumentiert bis ' + value;
    return value;
  }

  function sourceLink(label, url) {
    const text = el('span', '', label);
    try {
      const href = new URL(url);
      if (!['https:', 'http:'].includes(href.protocol)) return text;
      const link = el('a', '', label);
      link.href = href.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    } catch (_) {
      return text;
    }
  }

  function fitOptions(ctx) {
    const box = ctx.ui?.panelEl?.getBoundingClientRect();
    const dockedAtBottom = ctx.ui?.panelEl && getComputedStyle(ctx.ui.panelEl).position === 'fixed';
    const mapSize = ctx.map.getSize?.();
    return {
      animate: false, maxZoom: 18,
      paddingTopLeft: [dockedAtBottom ? 24 : 24 + Math.min(box?.width || 0, (mapSize?.x || 0) * 0.65), 24],
      paddingBottomRight: [48, dockedAtBottom ? 24 + Math.min(box?.height || 0, (mapSize?.y || 0) * 0.7) : 24],
    };
  }

  function showPanel(ctx, state, { fromMap = false } = {}) {
    const opening = state.panel.hidden;
    if (window.matchMedia?.(UA.COMPACT_MAP_QUERY)?.matches) {
      UA.PoliticalContext?.collapseWorkspace?.(ctx);
      UA.closeMapControls?.(ctx);
    }
    if (fromMap) UA.revealAnalysisPanel?.(ctx);
    state.panel.hidden = false;
    state.trigger.setAttribute('aria-expanded', 'true');
    dataChanged(ctx, opening);
  }

  function caseLabel(point, index) {
    const props = point.props || {};
    const type = props.utyp1 ?? props.UTYP1 ?? props.accidentType;
    const severity = props.ukategorie ?? props.UKATEGORIE ?? props.severity;
    const month = Number(props.umonat ?? props.UMONAT ?? props.month);
    const year = UA.SiteDiscovery.yearOf(point);
    const date = year && month >= 1 && month <= 12 ? String(month).padStart(2, '0') + '/' + year : year;
    return [
      'Fall ' + (index + 1), date || 'Jahr unbekannt',
      typeLabels[type] || 'Unfalltyp unbekannt', severityLabels[severity] || 'Schwere unbekannt',
    ].join(' · ');
  }

  function addCaseMarkers(ctx, state, selection, list, listDetails, status) {
    const locationGroups = new Map();
    const focused = new Set(selection.pattern?.points || []);
    const { yearOf } = UA.SiteDiscovery;
    const rows = selection.points
      .slice().sort((a, b) => yearOf(b) - yearOf(a))
      .map((point, index) => {
        const label = caseLabel(point, index);
        const row = el('li');
        const isFocus = focused.has(point);
        const link = button(label + (isFocus ? ' · Schwerpunkt' : ''), () => {
          list.querySelector('[aria-current]')?.removeAttribute('aria-current');
          link.setAttribute('aria-current', 'true');
          status.textContent = label + ' auf der Karte ausgewählt.';
          const marker = locationGroups.get(coordinates).marker;
          if (marker) {
            ctx.map.fitBounds(window.L.latLngBounds([point.lat, point.lon], [point.lat, point.lon]), fitOptions(ctx));
            marker.openTooltip();
          }
        });
        link.dataset.discoveryCase = String(index + 1);
        if (isFocus) row.className = 'site-discovery-focus-case';
        row.append(link);
        const coordinates = point.lat + ',' + point.lon;
        if (!locationGroups.has(coordinates)) locationGroups.set(coordinates, { point, rows: [] });
        locationGroups.get(coordinates).rows.push({ link, isFocus, label });
        return row;
      });
    list.append(...rows);
    if (!ctx.map.addLayer || !window.L?.layerGroup || !locationGroups.size) return;
    const paneName = 'uaDiscoveryCases';
    const pane = ctx.map.getPane?.(paneName) || ctx.map.createPane?.(paneName);
    if (pane) pane.style.zIndex = '620';
    const markers = [];
    for (const group of locationGroups.values()) {
      const { point } = group;
      const target = group.rows.find(row => row.isFocus) || group.rows[0];
      const marker = window.L.circleMarker([point.lat, point.lon], {
        radius: target.isFocus ? 7 : 5,
        color: target.isFocus ? '#861878' : '#114780',
        fillColor: '#fff', fillOpacity: 0.8, opacity: 1, weight: target.isFocus ? 3 : 2,
        ...(pane ? { pane: paneName } : {}),
        bubblingMouseEvents: false,
      });
      group.marker = marker;
      marker.bindTooltip(el('span', '', group.rows.length > 1
        ? countText(group.rows.length, 'Fall an diesem Kartenpunkt', 'Fälle an diesem Kartenpunkt')
        : target.label));
      marker.on('click', () => {
        showPanel(ctx, state, { fromMap: true });
        listDetails.open = true;
        list.querySelector('[aria-current]')?.removeAttribute('aria-current');
        target.link.setAttribute('aria-current', 'true');
        target.link.focus({ preventScroll: true });
        target.link.scrollIntoView?.({ block: 'nearest' });
        status.textContent = group.rows.map(row => row.label.split(' · ')[0]).join(', ') + ' an diesem Kartenpunkt.';
      });
      markers.push(marker);
    }
    state.markerLayer = window.L.layerGroup(markers);
    ctx.map.addLayer(state.markerLayer);
  }

  function appendFacilities(ctx, state, selection) {
    if (!UA.FacilityContext?.load) return;
    const city = ctx.CITY_RAW;
    Promise.resolve(UA.FacilityContext.load(city, selection.bounds, ctx.poiData)).then(result => {
      if (city !== ctx.CITY_RAW || state.selection !== selection || !result?.facilities?.length) return;
      const section = el('details');
      section.append(el('summary', '', 'Schulen und Kitas im Umfeld'));
      const list = el('ul');
      for (const facility of result.facilities) {
        const item = el('li');
        item.append(el('strong', '', facility.name), el('span', '', ' · ' + facility.relation),
          el('p', '', facility.reason));
        const sources = [facility.source, facility.locationSource, ...(facility.planSources || [])];
        const shown = new Set();
        for (const source of sources) {
          if (!source?.url || shown.has(source.url)) continue;
          shown.add(source.url);
          const link = el('span', 'site-discovery-source');
          link.append(sourceLink(source.label || 'Quelle', source.url));
          if (source.date) link.append(' · ' + sourceDate(source.date, source.precision));
          item.append(link);
        }
        list.append(item);
      }
      section.append(list);
      state.detail.append(section);
    }).catch(() => {});
  }

  function renderHistory(container, changes) {
    container.replaceChildren();
    if (!changes.length) return;
    const history = el('ul', 'site-discovery-history');
    for (const change of changes) {
      const item = el('li');
      item.append(sourceLink(change.label, change.url), ' · ' + sourceDate(change.date, change.precision));
      history.append(item);
    }
    const details = el('details');
    details.append(el('summary', '', 'Dokumentierte Änderungen'), history);
    container.append(details);
  }

  function exposureText(points) {
    const modes = { motor_vehicle: 'Kfz', bicycle: 'Rad', pedestrian: 'Fuß' };
    const counts = new Set();
    const models = new Set();
    let proxy = false;
    for (const { props } of points) {
      proxy ||= props?.traffic_measurement_type === 'proxy';
      const mode = props?.traffic_evidence?.observation?.mode;
      if (!Object.hasOwn(modes, mode) || !UA.trafficProvider?.hasUsableTypedEvidence(props, { mode })) continue;
      (props.traffic_measurement_type === 'count' ? counts : models).add(modes[mode]);
    }
    const parts = [counts.size ? `Zugeordnete Zählwerte für ${[...counts].join(', ')}.` : 'Keine zugeordneten Verkehrszählwerte.'];
    if (models.size) parts.push(`Verkehrsmodell für ${[...models].join(', ')}.`);
    if (proxy) parts.push('OSM-Straßenklassen dienen der Einordnung.');
    return parts.join(' ');
  }

  function showSelection(ctx, state, selection) {
    resetDetail(ctx, state);
    state.selection = selection;
    const { label, total, points, pattern, changes, visibleCount, complete } = selection;
    const heading = el('h4', '', label);
    heading.tabIndex = -1;
    const criteria = selection.query.mapFilters ? 'Such- und Kartenfiltern der Musterkarte' : 'Suchkriterien';
    const scope = el('p', '', countText(points.length, 'Fall nach ' + criteria, 'Fälle nach ' + criteria)
      + ' · ' + (complete
        ? countText(total, 'Fall insgesamt im Rechteck', 'Fälle insgesamt im Rechteck')
        : countText(total, 'geladener Fall im Rechteck', 'geladene Fälle im Rechteck')));
    state.heading = heading;
    state.detail.append(heading, scope);
    if (visibleCount != null) {
      state.detail.append(el('p', '', countText(visibleCount, 'sichtbarer Clusterfall', 'sichtbare Clusterfälle')
        + ' · Rechteck mit 16 m Rand um die Originalkoordinaten.'));
    }
    if (pattern) {
      const patternLabel = selection.query.mapFilters ? 'Ausgewähltes Muster' : 'Wiederkehrendes Muster';
      state.detail.append(el('p', 'site-discovery-pattern', patternLabel + ' · ' + pattern.label
        + ' · ' + countText(pattern.points.length, 'Fall', 'Fälle')
        + ' · ' + countText(pattern.recentPoints.length, 'Fall', 'Fälle') + ' im jüngsten Jahr dieses Musters (' + pattern.recentYear + ')'
        + '. Violette Ringe kennzeichnen die Musterfälle.'));
    } else {
      state.detail.append(el('p', '', 'Für diese Auswahl ist kein wiederkehrendes Muster mit mindestens drei Fällen aus zwei Jahren belegt.'));
    }
    state.detail.append(el('p', 'site-discovery-note', exposureText(selection.areaPoints)));

    state.history = el('div');
    renderHistory(state.history, changes);
    state.detail.append(state.history);

    const listDetails = el('details', 'site-discovery-case-list');
    listDetails.open = true;
    const list = el('ol');
    const status = el('p', 'site-discovery-case-status');
    status.setAttribute('role', 'status');
    listDetails.append(el('summary', '', 'Einzelfälle auf der Karte'), status, list);
    state.detail.append(listDetails);
    state.detail.hidden = false;
    addCaseMarkers(ctx, state, selection, list, listDetails, status);
    appendFacilities(ctx, state, selection);
    const fieldCheck = el('details');
    fieldCheck.append(el('summary', '', 'Vor Ort prüfen'), el('p', '',
      'Querungen und Signalphasen beobachten. Wartezeiten, vermiedene Querungen, Umwege und Beinahekonflikte erfassen. Verkehrsmengen nach Verkehrsart, Richtung und Tageszeit erheben.'));
    state.detail.append(fieldCheck);
    return heading;
  }

  function buildSelection(ctx, { bounds, query, key, label, changes = [], visibleCount, useExactKey = false }) {
    const all = pointsInArea(ctx, bounds);
    const population = query.mapFilters ? all.filter(point => {
      const mask = UA.maskFromProps(point.props);
      return mask > 0 && UA.matchesNonInvolvementFilters(ctx, point.props) && UA.matchesInvolvementFilter(ctx, mask);
    }) : all;
    const points = UA.SiteDiscovery.filterPoints(population, query);
    const pattern = useExactKey && !key ? null : UA.SiteDiscovery.patternForPoints(points, key || undefined);
    return {
      bounds, query, label, changes, visibleCount, points, pattern, areaPoints: all, total: all.length,
      complete: ctx.accidentDataCoverage?.complete === true,
    };
  }

  function selectCandidate(ctx, state, row, event) {
    const selection = buildSelection(ctx, {
      bounds: row.bounds, query: state.query, label: row.label, changes: row.changes,
    });
    if (!UA.setSelectionArea(ctx, row.bounds, { fit: fitOptions(ctx) })) return;
    setFocus(ctx, { bounds: row.bounds, query: state.query, key: selection.pattern?.key || null });
    const heading = showSelection(ctx, state, { ...selection, id: row.id });
    event.currentTarget.setAttribute('aria-pressed', 'true');
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'nearest' });
  }

  function selectCluster(ctx, markers) {
    const points = markers.map(marker => {
      const latLng = marker._preSpiderfyLatlng || marker.getLatLng?.();
      return latLng && { lat: latLng.lat, lon: latLng.lng };
    }).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    const bounds = UA.SiteDiscovery.boundsForPoints(points, clusterLimits);
    if (!bounds || !UA.setSelectionArea(ctx, bounds)) {
      return { ok: false, message: 'Dieser Cluster ist für eine lokale Markierung zu groß. Bitte näher heranzoomen.' };
    }

    const selection = buildSelection(ctx, {
      bounds, query: { ...allQuery }, label: 'Markierter Clusterbereich', visibleCount: points.length,
    });
    setFocus(ctx, { bounds, query: selection.query, key: selection.pattern?.key || null });
    ctx.map.closePopup?.();
    const state = panels.get(ctx);
    if (state) {
      showPanel(ctx, state, { fromMap: true });
      const heading = showSelection(ctx, state, selection);
      heading.focus({ preventScroll: true });
      heading.scrollIntoView?.({ block: 'nearest' });
    }
    return { ok: true, bounds };
  }

  function renderRows(ctx, state) {
    const activeCandidate = state.rows.contains(document.activeElement)
      ? document.activeElement.dataset.discoveryCandidate
      : null;
    state.rows.replaceChildren();
    const rows = [...state.candidates];
    if (state.sort.value === 'severe') rows.sort((a, b) => b.severeCount - a.severeCount || b.count - a.count);
    if (state.sort.value === 'pattern') rows.sort((a, b) => (b.pattern?.points.length || 0) - (a.pattern?.points.length || 0) || b.count - a.count);
    for (const row of rows.slice(0, state.limit)) {
      const action = button(row.label, event => selectCandidate(ctx, state, row, event));
      action.classList.add('site-discovery-result');
      action.dataset.discoveryCandidate = row.id;
      action.disabled = !row.bounds;
      action.setAttribute('aria-pressed', String(row.id === state.selection?.id));
      action.append(el('span', '', (kindLabels[row.kind] || 'Prüfbereich') + ' · '
        + countText(row.count, 'Fall', 'Fälle') + ' · ' + number.format(row.severeCount) + ' mit Getöteten oder Schwerverletzten'));
      const item = el('li');
      item.append(action);
      state.rows.append(item);
      if (row.id === activeCandidate) action.focus({ preventScroll: true });
    }
    state.status.textContent = countText(rows.length, 'Prüfbereich', 'Prüfbereiche')
      + (rows.length ? ' · ' + Math.min(state.limit, rows.length) + ' angezeigt' : ' mit den gewählten Kriterien');
    state.more.hidden = state.limit >= rows.length;
  }

  function refreshCandidates(ctx, state) {
    if (state.query.fromYear && state.query.toYear && state.query.fromYear > state.query.toYear) {
      state.candidates = [];
      renderRows(ctx, state);
      state.status.textContent = 'Das Startjahr muss vor oder im Endjahr liegen.';
      return;
    }
    state.candidates = UA.SiteDiscovery.candidates(ctx.allPts || [], state.query, state.sites || []);
    renderRows(ctx, state);
  }

  function dataChanged(ctx, opening = false) {
    const state = panels.get(ctx);
    if (!state) return;
    if (state.city !== ctx.CITY_RAW) {
      selectionChanged(ctx);
      state.city = ctx.CITY_RAW;
      state.points = null;
      state.sites = null;
      state.siteRequest = null;
    }
    const visible = !state.panel.hidden;
    if (!visible && !state.selection) return;
    const coverage = ctx.accidentDataCoverage;
    const scope = coverage?.complete === true
      ? 'Vollständiger verfügbarer Stadtdatensatz. Fälle mit Personenschaden.'
      : 'Stadtdatensatz unvollständig. Die gesamte Liste bezieht sich nur auf die geladenen Unfalldaten.';
    if (state.coverage.textContent !== scope) state.coverage.textContent = scope;
    const selection = state.selection;
    const pointsChanged = state.points !== ctx.allPts;
    const mapChanged = state.mapPoints !== ctx.filteredAll;
    if (selection && (pointsChanged || (selection.query.mapFilters && mapChanged))) {
      showSelection(ctx, state, { ...selection, ...buildSelection(ctx, {
        ...selection, key: ctx.discoveryFocus?.key, useExactKey: true,
      }) });
    }
    state.mapPoints = ctx.filteredAll;
    if (pointsChanged) {
      state.points = ctx.allPts;
      refreshYearControls(ctx, state);
    }
    if (!visible) return;
    if (opening || pointsChanged) refreshCandidates(ctx, state);
    if (!state.siteRequest) {
      const requested = Promise.resolve(UA.SiteDiscovery.loadSites(ctx.CITY_RAW));
      state.siteRequest = requested;
      requested.then(sites => {
        if (state.siteRequest !== requested || state.city !== ctx.CITY_RAW) return;
        state.sites = sites;
        const site = sites.find(item => sameBounds(item.bounds, state.selection?.bounds));
        if (site && state.selection.shared) {
          state.selection.label = site.label;
          state.selection.changes = site.changes;
          state.heading.textContent = site.label;
          renderHistory(state.history, site.changes);
        }
        if (!state.panel.hidden) refreshCandidates(ctx, state);
      }).catch(() => {});
    }
  }

  function setSelectOptions(select, choices) {
    select.replaceChildren(...choices.map(([value, title]) => {
      const option = el('option', '', title);
      option.value = value;
      return option;
    }));
  }

  function refreshYearControls(ctx, state) {
    const years = new Set((ctx.allPts || []).map(UA.SiteDiscovery.yearOf).filter(Boolean));
    const { fromYear, toYear } = state.query;
    if (fromYear) years.add(fromYear);
    if (toYear) years.add(toYear);
    const options = [['', 'Alle'], ...[...years].sort((a, b) => a - b).map(year => [year, year])];
    setSelectOptions(state.fromYearSelect, options);
    setSelectOptions(state.toYearSelect, options);
    state.fromYearSelect.value = fromYear || '';
    state.toYearSelect.value = toYear || '';
  }

  function selectControl(id, label, choices) {
    const wrapper = el('label', '', label);
    const select = el('select');
    select.id = id;
    setSelectOptions(select, choices);
    wrapper.append(select);
    return { wrapper, select };
  }

  function bind(ctx) {
    const trigger = document.getElementById('btnDiscover');
    if (!trigger || !UA.SiteDiscovery || panels.has(ctx)) return;
    const panel = el('section', 'site-discovery-panel');
    panel.id = 'siteDiscoveryPanel';
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'siteDiscoveryTitle');
    trigger.setAttribute('aria-controls', panel.id);
    trigger.setAttribute('aria-expanded', 'false');

    const close = () => {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    };
    const head = el('div', 'site-discovery-heading');
    const title = el('h3', '', 'Prüfbereiche finden');
    title.id = 'siteDiscoveryTitle';
    title.tabIndex = -1;
    head.append(title, button('Schließen', close));

    const grid = el('div', 'site-discovery-criteria');
    const from = selectControl('siteDiscoveryFromYear', 'Von Jahr', []);
    const to = selectControl('siteDiscoveryToYear', 'Bis Jahr', []);
    const severity = selectControl('siteDiscoverySeverity', 'Unfallschwere', [
      ['all', 'Alle'], ['serious', 'Getötete oder Schwerverletzte'], ...Object.entries(severityLabels),
    ]);
    const type = selectControl('siteDiscoveryType', 'Unfalltyp', [
      ['all', 'Alle'], ['turning', 'Abbiegen / Einbiegen / Kreuzen'], ...Object.entries(typeLabels),
    ]);
    const involvement = selectControl('siteDiscoveryInvolvement', 'Beteiligung', [
      ['all', 'Alle'], ['bike-foot', 'Rad oder Fuß'], ['bike', 'Rad'], ['foot', 'Fuß'], ['car', 'Pkw'], ['heavy', 'Güter-Kfz'],
    ]);
    const sort = selectControl('siteDiscoverySort', 'Sortierung', [
      ['count', 'Fallzahl'], ['severe', 'Getötete oder Schwerverletzte'], ['pattern', 'Wiederkehrendes Muster'],
    ]);
    grid.append(from.wrapper, to.wrapper, severity.wrapper, type.wrapper, involvement.wrapper, sort.wrapper);
    const coverage = el('p', 'site-discovery-coverage');
    const status = el('p', 'site-discovery-status');
    status.setAttribute('role', 'status');
    const detail = el('div', 'site-discovery-detail');
    detail.hidden = true;
    const rows = el('ol', 'site-discovery-results');
    rows.setAttribute('aria-label', 'Gefundene Prüfbereiche');
    const more = button('Weitere Prüfbereiche', () => {
      const previous = state.limit;
      state.limit += listPage;
      renderRows(ctx, state);
      state.rows.children[previous]?.querySelector('button')?.focus();
    });
    more.hidden = true;
    panel.append(head, coverage, el('p', 'site-discovery-note',
      'Die Liste zeigt Fallzahlen. Verkehrsmengen und amtlich festgelegte Unfallhäufungsstellen sind gesondert zu prüfen. Die Kartenfilter bleiben separat.'),
      grid, detail, status, rows, more);
    (trigger.closest('.taskActions') || trigger).after(panel);

    const savedQuery = ctx.discoveryFocus?.query || allQuery;
    const { mapFilters: _mapFilters, ...query } = savedQuery;
    severity.select.value = query.severity;
    type.select.value = query.type;
    involvement.select.value = query.involvement || 'all';
    const state = {
      panel, trigger, coverage, status, rows, more, detail, sort: sort.select,
      fromYearSelect: from.select, toYearSelect: to.select,
      limit: listPage, query, city: ctx.CITY_RAW, candidates: [], points: ctx.allPts, mapPoints: ctx.filteredAll,
    };
    panels.set(ctx, state);
    refreshYearControls(ctx, state);
    for (const control of [from, to, severity, type, involvement]) {
      control.select.addEventListener('change', () => {
        state.query = {
          fromYear: Number(from.select.value) || null, toYear: Number(to.select.value) || null,
          severity: severity.select.value, type: type.select.value,
          involvement: involvement.select.value,
        };
        setFocus(ctx, null);
        resetDetail(ctx, state);
        state.limit = listPage;
        refreshCandidates(ctx, state);
      });
    }
    sort.select.addEventListener('change', () => {
      state.limit = listPage;
      renderRows(ctx, state);
    });
    trigger.addEventListener('click', () => {
      if (!panel.hidden) { close(); return; }
      showPanel(ctx, state);
      title.focus();
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    });

    if (ctx.discoveryFocus && sameBounds(ctx.discoveryFocus.bounds, areaBounds(ctx))) {
      const { bounds, key } = ctx.discoveryFocus;
      showSelection(ctx, state, {
        ...buildSelection(ctx, { bounds, query: savedQuery, key, useExactKey: true, label: 'Geteilter Prüfbereich' }),
        shared: true,
      });
      if (!UA.qBool?.('export', false)) showPanel(ctx, state, { fromMap: true });
    }
  }

  UA.SiteDiscoveryUI = Object.freeze({ bind, selectCluster, selectionChanged, dataChanged });
})();
