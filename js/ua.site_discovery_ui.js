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
  const kindLabels = {
    site: 'Dokumentierter Ort', segment: 'Straßenabschnitt', cell: 'Suchzelle', junction: 'Knotenpunkt', crossing: 'Querung',
  };
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
    state.activeCase = null;
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

  function addSelectionLayer(ctx, state, selection, list, status, previousPoint) {
    const locationGroups = new Map();
    const focused = new Set(selection.pattern?.points || []);
    const { yearOf } = UA.SiteDiscovery;
    const selectCase = entry => {
      state.activeCase?.link.removeAttribute('aria-current');
      state.activeCase = entry;
      entry.link.setAttribute('aria-current', 'true');
      status.textContent = entry.label + ' auf der Karte ausgewählt.';
    };
    const rows = selection.points
      .slice().sort((a, b) => yearOf(b) - yearOf(a))
      .map((point, index) => {
        const label = caseLabel(point, index);
        const row = el('li');
        const isFocus = focused.has(point);
        const link = button(label + (isFocus ? ' · Schwerpunkt' : ''), () => {
          selectCase(entry);
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
        const entry = { point, link, isFocus, label };
        locationGroups.get(coordinates).rows.push(entry);
        // Reloaded tiles reuse the feature properties even when point wrappers change.
        if (previousPoint && point.props === previousPoint.props && point.lat === previousPoint.lat && point.lon === previousPoint.lon) {
          selectCase(entry);
        }
        return row;
      });
    list.append(...rows);
    const coordinates = selection.coordinates;
    if (!ctx.map.addLayer || !window.L?.layerGroup || (!locationGroups.size && !coordinates?.length)) return;
    const paneName = 'uaDiscoveryCases';
    const pane = ctx.map.getPane?.(paneName) || ctx.map.createPane?.(paneName);
    if (pane) pane.style.zIndex = '620';
    const layers = [];
    if (coordinates?.length) {
      const latLngs = [];
      for (let i = 0; i < coordinates.length; i += 2) latLngs.push([coordinates[i], coordinates[i + 1]]);
      const style = { color: '#0a7368', weight: 3, interactive: false, ...(pane ? { pane: paneName } : {}) };
      const geometry = selection.kind === 'segment' ? window.L.polyline(latLngs, style)
        : window.L.circleMarker(latLngs[0], { ...style, radius: 10, fill: false });
      layers.push(geometry);
    }
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
        selectCase(target);
        status.textContent = group.rows.map(row => row.label.split(' · ')[0]).join(', ') + ' an diesem Kartenpunkt.';
        showPanel(ctx, state, { fromMap: true });
        const link = state.activeCase?.link;
        if (link) link.closest('details').open = true;
        (link || state.heading).focus({ preventScroll: true });
        link?.scrollIntoView?.({ block: 'nearest' });
      });
      layers.push(marker);
    }
    state.markerLayer = window.L.layerGroup(layers);
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

  function exposureText(points, query) {
    const modes = { motor_vehicle: 'Kfz', bicycle: 'Rad', pedestrian: 'Fuß' };
    const counts = new Set();
    const models = new Set();
    const observations = new Map();
    let proxy = false;
    for (const { props } of points) {
      proxy ||= props?.traffic_measurement_type === 'proxy';
      const mode = props?.traffic_evidence?.observation?.mode;
      if (!Object.hasOwn(modes, mode) || !UA.trafficProvider?.hasUsableTypedEvidence(props, { mode })) continue;
      const observation = props.traffic_evidence.observation;
      if (observation.year < (query.fromYear ?? 0) || observation.year > (query.toYear ?? Infinity)) continue;
      const measured = props.traffic_measurement_type === 'count';
      (measured ? counts : models).add(modes[mode]);
      const id = JSON.stringify([observation.sourceId, observation.observationId]);
      observations.set(id, [measured ? 'Messwert' : 'Modellwert', modes[mode], observation.year, observation.period,
        number.format(observation.value) + ' ' + observation.unit, observation.direction, observation.sourceId].filter(Boolean).join(' · '));
    }
    const parts = [counts.size ? `Zugeordnete Zählwerte für ${[...counts].join(', ')}.` : 'Keine zugeordneten Verkehrszählwerte.'];
    if (models.size) parts.push(`Verkehrsmodell für ${[...models].join(', ')}.`);
    if (proxy) parts.push('OSM-Straßenklassen dienen der Einordnung.');
    parts.push(...[...observations.values()].sort().slice(0, 5));
    if (observations.size > 5) parts.push('Weitere Beobachtungen: ' + (observations.size - 5) + '.');
    return parts.join(' ');
  }

  function exposureChanged(ctx) {
    const state = panels.get(ctx);
    const selection = state?.selection;
    if (!selection || !state.exposure?.isConnected) return;
    const { site, points, areaPoints, bounds, query } = selection;
    state.exposure.replaceChildren(el('p', '', exposureText(site ? points : (areaPoints || []), query)));
    for (const station of UA.HannoverLayers?.stationReadings?.(ctx, bounds, query) || []) {
      const line = el('p');
      line.append(sourceLink(station.name, station.url), ' · ' + station.text + ' (VMZ, Station im Rechteck)');
      state.exposure.append(line);
    }
    state.exposure.append(el('p', '', 'Ein Risiko je Fahrt erfordert das Verkehrsaufkommen für dieselben Wege, Verkehrsarten und Zeiträume. Einzelne Messwerte reichen dafür nicht aus.'));
  }

  function showSelection(ctx, state, selection) {
    const previous = state.selection;
    const activeCase = previous?.query === selection.query && sameBounds(previous?.bounds, selection.bounds)
      ? state.activeCase : null;
    const restoreFocus = activeCase?.link === document.activeElement;
    resetDetail(ctx, state);
    state.selection = selection;
    const { label, total, points, pattern, changes, visibleCount, complete, site, networkStatus } = selection;
    if ((state.mode.value === 'network') === Boolean(site)) {
      const action = [...state.rows.querySelectorAll('[data-discovery-candidate]')]
        .find(button => button.dataset.discoveryCandidate === selection.id);
      action?.setAttribute('aria-pressed', 'true');
    }
    const heading = el('h4', '', label);
    heading.tabIndex = -1;
    const criteria = selection.query.mapFilters ? 'Such- und Kartenfiltern der Musterkarte' : 'Suchkriterien';
    const contextCount = complete
      ? countText(total, 'Fall insgesamt im Rechteck', 'Fälle insgesamt im Rechteck')
      : countText(total, 'geladener Fall im Rechteck', 'geladene Fälle im Rechteck');
    const cohortCount = site
      ? countText(points.length, 'zugeordneter Fall nach ' + criteria, 'zugeordnete Fälle nach ' + criteria)
      : countText(points.length, 'Fall nach ' + criteria, 'Fälle nach ' + criteria);
    state.heading = heading;
    state.detail.append(heading);
    if (networkStatus) {
      const status = el('p', '', networkStatus === 'pending'
        ? 'Der gespeicherte Netzstand wird geladen.'
        : 'Der gespeicherte Netzstand ist nicht verfügbar. Die Fallliste bezieht sich auf das ursprüngliche Rechteck.');
      status.setAttribute('role', 'status');
      state.detail.append(status);
    }
    state.detail.append(el('p', '', networkStatus === 'pending' ? contextCount : cohortCount + ' · ' + contextCount));
    state.detail.hidden = false;
    if (networkStatus === 'pending') {
      if (restoreFocus) heading.focus({ preventScroll: true });
      return heading;
    }
    if (selection.coordinates?.length) state.detail.append(el('p', '', 'Türkise Kontur markiert die Netzstelle.'));
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
      if (ctx.ui?.btnOpenExport && !networkStatus) {
        state.detail.append(button('Antragsentwurf für diese Stelle öffnen', () => ctx.ui.btnOpenExport.click()));
      }
    } else if (!networkStatus) {
      state.detail.append(el('p', '', 'Für diese Auswahl ist kein wiederkehrendes Muster mit mindestens drei Fällen aus zwei Jahren belegt.'));
    }
    if (site && ctx.reviewNetworkResult && UA.ReviewNetwork?.compareSites) {
      const predicate = selection.query.mapFilters ? point => matchesMapFilters(ctx, point) : undefined;
      const comparison = UA.ReviewNetwork.compareSites(ctx.reviewNetworkResult, site.id, selection.query, predicate);
      const features = ctx.reviewNetworkResult.network.sites.get(site.id)?.crossingFeatures;
      for (const line of UA.ReviewNetwork.comparisonLines(comparison, features)) state.detail.append(el('p', '', line));
    }
    state.exposure = el('div', 'site-discovery-note');
    state.detail.append(state.exposure);
    exposureChanged(ctx);

    state.history = el('div');
    renderHistory(state.history, changes);
    state.detail.append(state.history);

    const listDetails = el('details', 'site-discovery-case-list');
    listDetails.open = true;
    const list = el('ol');
    const status = el('p', 'site-discovery-case-status');
    status.setAttribute('role', 'status');
    listDetails.append(el('summary', '', 'Einzelfälle auf der Karte'), status, list);
    if (!site || points.length) state.detail.append(listDetails);
    addSelectionLayer(ctx, state, selection, list, status, activeCase?.point);
    if (restoreFocus) (state.activeCase?.link || heading).focus({ preventScroll: true });
    appendFacilities(ctx, state, selection);
    const fieldCheck = el('details');
    fieldCheck.append(el('summary', '', 'Vor Ort prüfen'), el('p', '',
      'Querungen und Signalphasen beobachten. Wartezeiten, vermiedene Querungen, Umwege und Beinahekonflikte erfassen. Verkehrsmengen nach Verkehrsart, Richtung und Tageszeit erheben.'));
    state.detail.append(fieldCheck);
    return heading;
  }

  function matchesMapFilters(ctx, point) {
    const mask = UA.maskFromProps(point.props);
    return mask > 0 && UA.matchesNonInvolvementFilters(ctx, point.props) && UA.matchesInvolvementFilter(ctx, mask);
  }

  function buildSelection(ctx, { bounds, query, key, label, changes = [], visibleCount, useExactKey = false }) {
    const all = pointsInArea(ctx, bounds);
    const population = query.mapFilters ? all.filter(point => matchesMapFilters(ctx, point)) : all;
    const points = UA.SiteDiscovery.filterPoints(population, query);
    const pattern = useExactKey && !key ? null : UA.SiteDiscovery.patternForPoints(points, key || undefined);
    return {
      bounds, query, label, changes, visibleCount, points, pattern, areaPoints: all, total: all.length,
      complete: ctx.accidentDataCoverage?.complete === true,
    };
  }

  function buildNetworkSelection(ctx, row, query, site) {
    return {
      id: row.id, bounds: row.bounds, label: row.label, changes: row.changes, points: row.points, pattern: row.pattern,
      kind: row.kind, coordinates: row.coordinates, query, site, total: pointsInArea(ctx, row.bounds).length, complete: true,
    };
  }

  function restoreNetworkSelection(ctx, state, focus, pending) {
    const { bounds, query, key, site } = focus;
    const result = ctx.reviewNetworkResult;
    const predicate = query.mapFilters ? point => matchesMapFilters(ctx, point) : undefined;
    const row = result?.network.revision === site.revision ? UA.ReviewNetwork.row(result, site.id, query, predicate) : null;
    const selection = row && sameBounds(row.bounds, bounds) ? {
      ...buildNetworkSelection(ctx, row, query, site),
      pattern: key ? UA.SiteDiscovery.patternForPoints(row.points, key) : null,
    } : {
      ...buildSelection(ctx, { bounds, query, useExactKey: true, label: 'Geteilter Prüfbereich' }),
      networkStatus: pending ? 'pending' : 'unavailable',
    };
    showSelection(ctx, state, { ...selection, focus });
  }

  function selectCandidate(ctx, state, row, networkMode) {
    const site = networkMode ? { id: row.id, revision: ctx.reviewNetworkResult.network.revision } : null;
    const selection = site ? buildNetworkSelection(ctx, row, state.query, site)
      : buildSelection(ctx, { bounds: row.bounds, query: state.query, label: row.label, changes: row.changes });
    if (!UA.setSelectionArea(ctx, row.bounds, { fit: fitOptions(ctx) })) return;
    setFocus(ctx, { bounds: row.bounds, query: state.query, key: selection.pattern?.key || null, ...(site ? { site } : {}) });
    const heading = showSelection(ctx, state, { ...selection, id: row.id, focus: ctx.discoveryFocus });
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
    const networkMode = state.mode.value === 'network';
    const activeCandidate = state.rows.contains(document.activeElement)
      ? document.activeElement.dataset.discoveryCandidate
      : null;
    state.rows.replaceChildren();
    const rows = [...state.candidates];
    if (state.sort.value === 'severe') rows.sort((a, b) => b.severeCount - a.severeCount || b.count - a.count);
    if (state.sort.value === 'pattern') rows.sort((a, b) => (b.pattern?.points.length || 0) - (a.pattern?.points.length || 0) || b.count - a.count);
    for (const row of rows.slice(0, state.limit)) {
      const action = button(row.label, () => selectCandidate(ctx, state, row, networkMode));
      action.classList.add('site-discovery-result');
      action.dataset.discoveryCandidate = row.id;
      action.disabled = !row.bounds;
      action.setAttribute('aria-pressed', String(row.id === state.selection?.id && networkMode === Boolean(state.selection?.site)));
      const cases = networkMode ? countText(row.count, 'zugeordneter Fall', 'zugeordnete Fälle') : countText(row.count, 'Fall', 'Fälle');
      action.append(el('span', '', (kindLabels[row.kind] || 'Prüfbereich') + ' · '
        + cases + ' · ' + number.format(row.severeCount) + ' mit Getöteten oder Schwerverletzten'));
      const item = el('li');
      item.append(action);
      state.rows.append(item);
      if (row.id === activeCandidate) action.focus({ preventScroll: true });
    }
    state.status.textContent = (networkMode ? countText(rows.length, 'Netzstelle', 'Netzstellen') : countText(rows.length, 'Prüfbereich', 'Prüfbereiche'))
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
    state.candidates = state.mode.value === 'network'
      ? UA.ReviewNetwork.rows(ctx.reviewNetworkResult, state.query, { kind: state.networkKind.value, onlyEmpty: state.onlyEmpty.checked })
      : UA.SiteDiscovery.candidates(ctx.allPts || [], state.query, state.sites || []);
    renderRows(ctx, state);
  }

  function syncSearchMode(state) {
    const networkMode = state.mode.value === 'network';
    state.networkKindLabel.hidden = !networkMode;
    state.onlyEmptyLabel.hidden = !networkMode;
    state.networkMeta.hidden = !networkMode;
    state.rows.setAttribute('aria-label', networkMode ? 'Gefundene Netzstellen' : 'Gefundene Prüfbereiche');
    state.more.textContent = networkMode ? 'Weitere Netzstellen' : 'Weitere Prüfbereiche';
  }

  function showCrossingCoverage(state, network) {
    const available = Number.isInteger(network.documentedCrossings) && network.documentedCrossings > 0;
    for (const option of state.networkKind.options) {
      if (['unlit', 'unmarked'].includes(option.value)) option.disabled = !available;
    }
    if (!state.crossingCoverage) return;
    state.crossingCoverage.textContent = available
      ? 'Für ' + number.format(network.documentedCrossings) + ' von ' + number.format(network.counts.crossing)
        + ' Querungen liegen einzelne OSM-Merkmale vor. Fehlende Angaben sind unbekannt.'
      : 'Für diese Netzrevision sind derzeit keine zusätzlichen Querungsmerkmale geladen.';
  }

  function updateNetwork(ctx, state, allowLoad) {
    const complete = ctx.accidentDataCoverage?.complete === true;
    if (complete && allowLoad && !state.networkRequest && UA.ReviewNetwork?.load) {
      const city = state.city;
      const request = Promise.resolve().then(() => UA.ReviewNetwork.load(city)).catch(() => null);
      state.networkRequest = request;
      ctx.reviewNetworkPromise = request.then(network => {
        if (state.networkRequest !== request || ctx.CITY_RAW !== city) return null;
        state.network = network || null;
        dataChanged(ctx);
        network?.crossingContextReady?.then(() => {
          if (state.network !== network || ctx.CITY_RAW !== city) return;
          if (ctx.discoveryFocus?.site && state.selection) restoreNetworkSelection(ctx, state, ctx.discoveryFocus, false);
          showCrossingCoverage(state, network);
          if (!state.panel.hidden && state.mode.value === 'network') refreshCandidates(ctx, state);
        });
        return ctx.reviewNetworkResult || null;
      });
    }

    const network = complete ? state.network : null;
    const previous = ctx.reviewNetworkResult;
    if (network ? previous?.network === network && state.networkPoints === ctx.allPts : !previous) return false;
    const result = network ? UA.ReviewNetwork.analyze(network, ctx.allPts || []) : null;
    state.networkPoints = network ? ctx.allPts : null;
    ctx.reviewNetworkResult = result;
    if (state.network !== undefined) ctx.reviewNetworkPromise = Promise.resolve(result);

    state.networkControls.hidden = !result;
    state.title.textContent = result ? 'Stellen finden' : 'Prüfbereiche finden';
    if (!result) state.mode.value = 'areas';
    else if (!previous) state.mode.value = 'network';
    syncSearchMode(state);
    state.networkMeta.replaceChildren();
    if (result) {
      const { total, assigned, ambiguous, unmatched } = result.counts;
      const coverage = el('p', 'site-discovery-note', 'Zuordnung im Stadtdatensatz · '
        + countText(total, 'Fall insgesamt', 'Fälle insgesamt') + ' · ' + number.format(assigned) + ' zugeordnet · '
        + number.format(ambiguous) + ' mehrdeutig · ' + number.format(unmatched) + ' ohne Zuordnung');
      const source = el('p', 'site-discovery-note');
      source.append(countText(network.sites.size, 'Netzstelle', 'Netzstellen') + ' · ',
        sourceLink(network.source.label, network.source.url), ' · ' + sourceDate(network.source.date));
      state.crossingCoverage = el('p', 'site-discovery-note');
      state.networkMeta.append(coverage, source, state.crossingCoverage);
      showCrossingCoverage(state, network);
    }
    return true;
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
      state.network = undefined;
      state.networkRequest = null;
      ctx.reviewNetworkPromise = null;
    }
    const focus = ctx.discoveryFocus;
    const visible = !state.panel.hidden;
    const networkChanged = updateNetwork(ctx, state, visible || Boolean(focus?.site));
    if (!visible && !focus?.site && !state.selection) return;
    const complete = ctx.accidentDataCoverage?.complete === true;
    const scope = complete
      ? 'Vollständiger verfügbarer Stadtdatensatz. Fälle mit Personenschaden.'
      : 'Stadtdatensatz unvollständig. Die gesamte Liste bezieht sich nur auf die geladenen Unfalldaten.';
    if (state.coverage.textContent !== scope) state.coverage.textContent = scope;
    const selection = state.selection;
    const pointsChanged = state.points !== ctx.allPts;
    const mapChanged = state.mapPoints !== ctx.filteredAll;
    const pending = complete && Boolean(state.networkRequest) && state.network === undefined;
    if (focus?.site && sameBounds(focus.bounds, areaBounds(ctx))) {
      if (selection?.focus !== focus || pointsChanged || networkChanged || state.complete !== complete
          || state.networkPending !== pending || (focus.query.mapFilters && mapChanged)) {
        restoreNetworkSelection(ctx, state, focus, pending);
      }
    } else if (selection && (pointsChanged || (selection.query.mapFilters && mapChanged))) {
      showSelection(ctx, state, { ...selection, ...buildSelection(ctx, {
        ...selection, key: focus?.key, useExactKey: true,
      }) });
    }
    state.mapPoints = ctx.filteredAll;
    if (pointsChanged) {
      state.points = ctx.allPts;
      refreshYearControls(ctx, state);
    }
    state.complete = complete;
    state.networkPending = pending;
    if (!visible) return;
    if (opening || pointsChanged || networkChanged) refreshCandidates(ctx, state);
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
        if (!state.panel.hidden && state.mode.value === 'areas') refreshCandidates(ctx, state);
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

    const networkControls = el('div');
    networkControls.hidden = true;
    const mode = selectControl('siteDiscoveryMode', 'Suchmodus', [['areas', 'Prüfbereiche'], ['network', 'Netzregister']]);
    const networkKind = selectControl('siteDiscoveryNetworkKind', 'Netztyp', [
      ['all', 'Alle'], ...['junction', 'crossing', 'segment'].map(kind => [kind, kindLabels[kind]]),
      ['unlit', 'Querung · unbeleuchtet (OSM)'], ['unmarked', 'Querung · ohne Markierung (OSM)'],
    ]);
    const networkGrid = el('div', 'site-discovery-criteria');
    networkGrid.append(mode.wrapper, networkKind.wrapper);
    const onlyEmpty = el('input');
    onlyEmpty.type = 'checkbox';
    const onlyEmptyLabel = el('label');
    onlyEmptyLabel.append(onlyEmpty, ' Ohne zugeordneten Fall nach Suchkriterien');
    const networkMeta = el('div');
    networkControls.append(networkGrid, onlyEmptyLabel, networkMeta);

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
      networkControls, grid, detail, status, rows, more);
    (trigger.closest('.taskActions') || trigger).after(panel);

    const savedQuery = ctx.discoveryFocus?.query || allQuery;
    const { mapFilters: _mapFilters, ...query } = savedQuery;
    severity.select.value = query.severity;
    type.select.value = query.type;
    involvement.select.value = query.involvement || 'all';
    const state = {
      panel, trigger, title, coverage, status, rows, more, detail, sort: sort.select,
      networkControls, mode: mode.select, networkKind: networkKind.select, networkKindLabel: networkKind.wrapper,
      onlyEmpty, onlyEmptyLabel, networkMeta,
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
    for (const control of [mode.select, networkKind.select, onlyEmpty]) {
      control.addEventListener('change', () => {
        syncSearchMode(state);
        state.limit = listPage;
        refreshCandidates(ctx, state);
      });
    }
    trigger.addEventListener('click', () => {
      if (!panel.hidden) { close(); return; }
      showPanel(ctx, state);
      title.focus();
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    });

    if (ctx.discoveryFocus && sameBounds(ctx.discoveryFocus.bounds, areaBounds(ctx))) {
      const { bounds, key, site } = ctx.discoveryFocus;
      if (!site) {
        showSelection(ctx, state, {
          ...buildSelection(ctx, { bounds, query: savedQuery, key, useExactKey: true, label: 'Geteilter Prüfbereich' }),
          shared: true,
        });
      }
      if (!UA.qBool?.('export', false)) showPanel(ctx, state, { fromMap: true });
      else if (site) dataChanged(ctx);
    }
  }

  UA.SiteDiscoveryUI = Object.freeze({ bind, selectCluster, selectionChanged, dataChanged, exposureChanged });
})();
