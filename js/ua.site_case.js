(() => {
  'use strict';
  const UA = window.UA = window.UA || {};
  const stage = {
    'police-analysis': 'Polizeiliche Auswertung',
    'council-decision': 'Beschluss',
    'administrative-commitment': 'Zusage der Verwaltung',
    'implementation-status': 'Auskunft zum Umsetzungsstand',
  };

  function element(parent, tag, content) {
    const node = document.createElement(tag);
    if (content) node.textContent = content;
    parent.append(node);
    return node;
  }

  function webUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function source(parent, label, value) {
    const url = webUrl(value);
    const node = element(parent, url ? 'a' : 'span', label);
    if (url) Object.assign(node, { href: url, target: '_blank', rel: 'noopener noreferrer' });
    return node;
  }

  function dateLabel(date) {
    const [year, month, day] = String(date || '').split('-');
    return (day ? day + '.' : '') + (month ? month + '.' : '') + year;
  }

  function permalink(ctx, selection) {
    const url = new URL(window.location.href);
    const p = url.searchParams;
    const { bounds, query = {}, pattern, site, focus } = selection;
    p.set('city', ctx.CITY_RAW);
    for (const key of ['south','west','north','east']) {
      p.set('sel' + key[0].toUpperCase() + key.slice(1), bounds[key]);
    }
    // Preserve the originally shared network revision when its data are temporarily unavailable.
    const ref = site || focus?.site;
    const fields = {
      find: 1, siteFocus: focus?.key || pattern?.key || 'all',
      siteFrom: query.fromYear, siteTo: query.toYear, siteSeverity: query.severity, siteType: query.type,
      siteInvolvement: query.involvement, siteMapFilters: query.mapFilters ? 1 : null,
      siteNetworkId: ref?.id, siteNetworkRev: ref?.revision, export: null,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) p.delete(key);
      else p.set(key, value);
    }
    return url.href;
  }

  function action(parent, label, run) {
    const node = element(parent, 'button', label);
    node.type = 'button';
    node.className = 'smallBtn';
    node.addEventListener('click', run);
    return node;
  }

  function addResearch(root, ctx, bounds) {
    const city = ctx.CITY_RAW;
    const details = element(root, 'details');
    details.className = 'site-case-ris';
    element(details, 'summary', 'Ratsvorgänge im Auswahlbereich');
    const note = element(details, 'p');
    const list = element(details, 'ul');
    const status = element(details, 'p');
    status.setAttribute('role','status');
    const next = action(details, 'Weitere Ortsbezüge laden', load);
    next.hidden = true;

    const records = new Set();
    let snapshot, features, offset = 0, page = 0, busy = false;
    const active = () => root.isConnected && ctx.CITY_RAW === city;

    function appendRecord(record, link) {
      if (!record || records.has(record.id)) return;
      records.add(record.id);
      const row = element(list, 'li');
      source(row, record.title || record.number, record.url);
      const meta = [record.number, record.date && dateLabel(record.date), record.type, record.gremium,
        UA.RisSources?.sourceLabel(record)];
      if (meta.some(Boolean)) element(row, 'p', meta.filter(Boolean).join(' · '));
      const quality = { official: 'Amtlich verortet', derived: 'Abgeleiteter Ortsbezug', mixed: 'Gemischter Ortsbezug' }[link.accuracy];
      if (quality || link.label) element(row, 'p', [quality,link.label].filter(Boolean).join(' · '));
      if (webUrl(record.originalPdfUrl)) source(row, 'Original-PDF', record.originalPdfUrl);
      if (UA.RisDetails?.open) {
        const button = action(row, 'Beratungsverlauf', () => UA.RisDetails.open(ctx, record.id, { section: 'history', trigger: button }));
      }
      if (UA.PoliticalContext?.addReferences) {
        const adopt = action(row, 'Für Bericht übernehmen', async () => {
          if (adopt.disabled || !active()) return;
          adopt.disabled = true;
          try {
            await UA.PoliticalContext.addReferences(ctx, [record]);
            if (active()) status.textContent = 'Vorgang für den Bericht übernommen.';
          } catch (error) {
            if (active()) status.textContent = error?.message || 'Übernahme fehlgeschlagen.';
          } finally { adopt.disabled = false; }
        });
      }
    }

    async function load() {
      if (busy || !active()) return;
      busy = true;
      next.disabled = true;
      next.hidden = true;
      status.textContent = 'Ortsbezüge werden geladen …';
      try {
        if (!snapshot) {
          const rect = [bounds.west, bounds.south, bounds.east, bounds.north];
          snapshot = await UA.RisCatalogue.loadMap(city, {bounds:rect, zoom:18});
          if (!active()) return;
          if (snapshot.overview) {
            status.textContent = 'Für diesen Ausschnitt sind nur Übersichtszellen verfügbar. Einen kleineren Bereich markieren, um einzelne Vorgänge zu prüfen.';
            return;
          }
          features = snapshot.features.features.filter(f => !f.properties.overview && UA.RisLayer.intersects(f.geometry, rect));
          const coverage = UA.RisCatalogue.snapshotStatus?.(snapshot.manifest);
          note.textContent = [
            'Die verknüpfte Geometrie berührt den Auswahlbereich. Ein Straßenverlauf kann weit darüber hinausreichen. Den Bezug dieses Vorgangs zur konkreten Stelle im Original prüfen.',
            snapshot.manifest.generatedAt && 'Katalogstand ' + dateLabel(snapshot.manifest.generatedAt.slice(0,10)) + '.',
            coverage?.complete === false && 'Der veröffentlichte Ratsbestand ist unvollständig.',
            ...(coverage?.warnings || []),
          ].filter(Boolean).join(' ');
        }
        // One partition page per interaction bounds the amount of data requested, also for long city-wide streets.
        if (snapshot.partitioned && offset < features.length) {
          const feature = features[offset].properties;
          const result = await UA.RisCatalogue.loadFeatureRecords(city, feature.geometryId, page, {snapshot:snapshot.manifest});
          if (!active()) return;
          const byId = new Map(result.records.map(record => [record.id, record]));
          for (const link of result.links) appendRecord(byId.get(link.recordId), link);
          if (result.complete === false) throw new Error('Ein Teil der verknüpften Vorgänge fehlt im Datenstand.');
          if (result.nextPage == null) { offset++; page = 0; } else page = result.nextPage;
        } else if (!snapshot.partitioned) {
          const byId = new Map(snapshot.records.map(record => [record.id, record]));
          for (const feature of features) appendRecord(byId.get(feature.properties.recordId), feature.properties);
          offset = features.length;
        }
        next.hidden = offset >= features.length;
        next.textContent = 'Weitere Ortsbezüge laden';
        if (records.size === 0) {
          status.textContent = 'Im abgefragten Katalogausschnitt liegen bislang keine einzelnen Vorgänge mit Kartenbezug vor.';
        } else {
          status.textContent = records.size === 1 ? 'Ein Vorgang angezeigt.'
            : records.size.toLocaleString('de-DE') + ' verschiedene Vorgänge angezeigt.';
        }
      } catch (error) {
        if (!active()) return;
        status.textContent = error?.message || 'Die Ratsvorgänge konnten nicht geladen werden.';
        next.hidden = false;
        next.textContent = 'Ortsbezüge erneut laden';
        if (error?.code === 'RIS_SNAPSHOT_REFERENCE_MISMATCH') {
          snapshot = null;
          offset = page = 0;
          records.clear();
          list.replaceChildren();
        }
      } finally { busy = false; next.disabled = false; }
    }
    let requested = false;
    details.addEventListener('toggle', () => {
      if (details.open && !requested) { requested = true; load(); }
    });
  }

  function render(container, {ctx, selection}) {
    container.replaceChildren();
    const root = element(container, 'section');
    root.className = 'site-case';
    element(root,'h5','Fall und weiteres Vorgehen');
    const copyLink = element(root,'a','Link zu diesem Fall');
    const updateLink = () => { copyLink.href = permalink(ctx,selection); };
    updateLink();
    for (const event of ['focus','click','contextmenu','pointerdown']) copyLink.addEventListener(event,updateLink);

    const authority = element(root,'p');
    authority.textContent = 'Politisch zuständiges Gremium für den Auswahlbereich offen.';
    const slug = UA.normKey?.(ctx.CITY_RAW) || String(ctx.CITY_RAW).toLowerCase();
    if (UA.DistrictBoundaries?.resolveCommittee) {
      UA.DistrictBoundaries.resolveCommittee(slug,selection.bounds).then(match => {
        if (!root.isConnected || !match?.gremium) return;
        authority.textContent = 'Örtliches Gremium: ' + match.gremium + '. ';
        if (match.source) source(authority,'Bezirksgrenzen',match.source.url);
      }).catch(() => {});
    }
    const history = (selection.changes || []).filter(item => item.label && item.date && webUrl(item.url))
      .slice().sort((a,b)=>a.date.localeCompare(b.date));
    const last = history.at(-1);
    const implementations = UA.SiteEvaluation?.isImplementation ? history.filter(UA.SiteEvaluation.isImplementation) : [];
    const implementation = implementations.at(-1) || null;
    const decision = history.filter(e => e.kind === 'council-decision').at(-1);
    if (last) {
      const timeline = element(root,'details');
      element(timeline,'summary', decision ? 'Beschlüsse und Umsetzungsstand' : 'Dokumentierte Änderungen');
      const entries = element(timeline,'ol');
      for (const change of history) {
        const item = element(entries,'li');
        const role = implementations.includes(change) ? 'Inbetriebnahme' : stage[change.kind] || 'Dokumentierte Änderung';
        element(item,'strong',role + ' · ' + dateLabel(change.date) + ' ');
        source(item,change.label,change.url);
        if (change.attachment?.label && webUrl(change.attachment.url)) {
          item.append(' · ');
          source(item,change.attachment.label,change.attachment.url);
        }
      }
      element(root,'p','Letzter datierter Beleg (' + dateLabel(last.date) + '): ' + last.label);
    }
    if (decision) {
      const relatedCompletion = decision.number && implementations.some(change =>
        change.decisionNumber === decision.number && change.date >= decision.date.slice(0, change.date.length));
      if (!relatedCompletion) {
        element(root, 'p', 'Aktuellen Umsetzungsstand zu ' + (decision.number || 'diesem Beschluss')
          + ' erfragen. Für erledigte Schritte das Inbetriebnahmedatum und für ausstehende Schritte den Zeitplan anfordern.');
      }
    }
    if (implementation) {
      element(root, 'p', 'Für die dokumentierte Inbetriebnahme das betroffene Unfallmuster vor und nach der Änderung untersuchen.');
    } else if (!decision) {
      element(root, 'p', 'In den Ratsvorgängen den Beratungsstand und mögliche frühere Maßnahmen prüfen.');
    }
    const finding = selection.pattern && history.slice().reverse().find(change =>
      change.conflictHypothesis?.patternKey === selection.pattern.key && change.conflictHypothesis?.check);
    if (finding) {
      const check = element(root, 'details');
      element(check, 'summary', 'Prüfauftrag zum Unfallmuster');
      element(check, 'p', finding.conflictHypothesis.mechanism);
      element(check, 'p', finding.conflictHypothesis.check);
      source(check, finding.attachment?.label || finding.number || 'Grundlage',
        webUrl(finding.attachment?.url) || finding.url);
    }
    if (UA.RisCatalogue?.loadMap && UA.RisLayer?.intersects) addResearch(root, ctx, selection.bounds);
    if (UA.SiteEvaluation?.render) UA.SiteEvaluation.render(element(root,'div'), {ctx,selection,implementation});
  }

  UA.SiteCase = Object.freeze({ render, permalink });
})();
