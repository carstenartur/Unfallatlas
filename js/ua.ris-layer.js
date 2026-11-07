(() => {
  const UA = (window.UA = window.UA || {});
  const controls = new WeakMap();
  const PANE = 'uaRisPane';
  const styles = {
    official: { label: 'Amtlich verortet', color: '#532b78', dashed: false, fill: '#532b78' },
    derived: { label: 'Abgeleitete Lage', color: '#7a4709', dashed: true, fill: '#fff' },
    mixed: { label: 'Amtliche und abgeleitete Lage', color: '#532b78', dashed: true, fill: '#eee0fb' },
  };

  const cityOf = ctx => String(ctx.CITY_RAW || '').trim();

  function text(parent, tag, content) {
    const el = document.createElement(tag);
    el.textContent = content;
    parent.appendChild(el);
    return el;
  }

  function checkbox(parent, label) {
    const row = text(parent, 'label', '');
    row.style.cssText = 'display:block;cursor:pointer;line-height:26px';
    const input = document.createElement('input');
    input.type = 'checkbox';
    row.append(input, document.createTextNode(` ${label}`));
    return input;
  }

  function httpsUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch (_) { /* No link for an invalid source URL. */ }
    return '';
  }

  function rectOf(bounds) {
    if (!bounds || bounds.isValid?.() === false) return null;
    const rect = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    return rect.every(Number.isFinite) && rect[0] < rect[2] && rect[1] < rect[3] ? rect : null;
  }

  function insideRect([x, y], [w, s, e, n]) {
    return x >= w && x <= e && y >= s && y <= n;
  }

  // Clip the segment's parameter range to each of the rectangle's two axes.
  function segmentHits(a, b, rect) {
    let start = 0;
    let end = 1;
    for (let axis = 0; axis < 2; axis++) {
      const delta = b[axis] - a[axis];
      if (!delta) {
        if (a[axis] < rect[axis] || a[axis] > rect[axis + 2]) return false;
      } else {
        const lo = (rect[axis] - a[axis]) / delta;
        const hi = (rect[axis + 2] - a[axis]) / delta;
        start = Math.max(start, Math.min(lo, hi));
        end = Math.min(end, Math.max(lo, hi));
        if (start > end) return false;
      }
    }
    return true;
  }

  function lineHits(line, rect) {
    return line.some((point, i) => i > 0 && segmentHits(line[i - 1], point, rect));
  }

  function insideRing([x, y], ring) {
    let inside = false;
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1];
      const [bx, by] = ring[i];
      if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
    }
    return inside;
  }

  function polygonHits(rings, rect) {
    if (rings.some(ring => lineHits(ring, rect))) return true;
    // If the rectangle touches no boundary, one corner determines containment,
    // including the case where the entire rectangle lies within a hole.
    return !!rings.length && insideRing(rect, rings[0]) && !rings.slice(1).some(ring => insideRing(rect, ring));
  }

  function intersects({ type, coordinates }, rect) {
    switch (type) {
      case 'Point': return insideRect(coordinates, rect);
      case 'MultiPoint': return coordinates.some(point => insideRect(point, rect));
      case 'LineString': return lineHits(coordinates, rect);
      case 'MultiLineString': return coordinates.some(line => lineHits(line, rect));
      case 'Polygon': return polygonHits(coordinates, rect);
      case 'MultiPolygon': return coordinates.some(polygon => polygonHits(polygon, rect));
      default: return false;
    }
  }

  function coordinateBounds(coordinates, rect = [Infinity, Infinity, -Infinity, -Infinity]) {
    if (typeof coordinates[0] === 'number') {
      const [x, y] = coordinates;
      rect[0] = Math.min(rect[0], x);
      rect[1] = Math.min(rect[1], y);
      rect[2] = Math.max(rect[2], x);
      rect[3] = Math.max(rect[3], y);
    } else {
      for (const part of coordinates) coordinateBounds(part, rect);
    }
    return rect;
  }

  function featureHits(feature, [w, s, e, n]) {
    const [fw, fs, fe, fn] = feature.bbox;
    return fw <= e && fe >= w && fs <= n && fn >= s && intersects(feature.geometry, [w, s, e, n]);
  }

  function indexSnapshot(snapshot) {
    const records = new Map(snapshot.records.map(record => [record.id, record]));
    const links = new Map();
    for (const record of records.values()) {
      const parent = record.relatedTo;
      if (!parent || parent === record.id || !records.has(parent)) continue;
      if (!links.has(parent)) links.set(parent, []);
      if (!links.has(record.id)) links.set(record.id, []);
      links.get(parent).push(record.id);
      links.get(record.id).push(parent);
    }
    // Records matched to the same street reuse its geometry. Render one
    // clickable feature per shape so an upper path cannot hide other records.
    const byGeometry = new Map();
    for (const { geometry, properties } of snapshot.features.features) {
      if (!records.has(properties.recordId)) continue;
      const key = JSON.stringify([geometry.type, geometry.coordinates]);
      let feature = byGeometry.get(key);
      if (!feature) {
        feature = {
          type: 'Feature', geometry, bbox: coordinateBounds(geometry.coordinates),
          properties: { accuracy: properties.accuracy, locations: [] },
        };
        byGeometry.set(key, feature);
      }
      feature.properties.locations.push(properties);
      if (feature.properties.accuracy !== properties.accuracy) feature.properties.accuracy = 'mixed';
    }
    const features = [...byGeometry.values()];
    return { manifest: snapshot.manifest, records, links, features };
  }

  function linkedRecords(data, ids) {
    const group = new Set(ids);
    for (const member of group) {
      for (const related of data.links.get(member) || []) group.add(related);
    }
    for (const id of ids) group.delete(id);
    return [...group].map(member => data.records.get(member));
  }

  function current(ctx, state) {
    return controls.get(ctx) === state && ctx.map === state.map && cityOf(ctx) === state.city;
  }

  function popup(ctx, state, data, feature) {
    const root = document.createElement('section');
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    const { locations } = feature.properties;

    function appendRecord(parent, entry, location) {
      if (location) {
        const label = [styles[location.accuracy].label, location.label].filter(Boolean).join(' · ');
        text(parent, 'div', label).style.marginBottom = '6px';
      }
      text(parent, 'strong', entry.title);
      const meta = [entry.type, entry.number, entry.date, entry.gremium || entry.premium].filter(Boolean);
      if (meta.length) text(parent, 'div', meta.join(' · '));
      const source = entry.source ? ` · Quelle: ${entry.source}` : '';
      const url = httpsUrl(entry.url);
      if (!url) {
        if (entry.source) text(parent, 'div', `Quelle: ${entry.source}`);
        return;
      }
      const links = text(parent, 'div', '');
      const link = text(links, 'a', 'Amtliches Dokument');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Amtliches Dokument: ${entry.title}`);
      links.append(document.createTextNode(source));
      if (typeof UA.PoliticalContext?.addReferences !== 'function') return;
      const adopt = text(parent, 'button', 'Für Bericht übernehmen');
      adopt.type = 'button';
      adopt.className = 'smallBtn';
      adopt.setAttribute('aria-label', `${entry.title} für Bericht übernehmen`);
      adopt.addEventListener('click', () => {
        if (!current(ctx, state) || !state.toggle.checked || state.data !== data) return;
        UA.PoliticalContext.addReferences(ctx, [entry]);
        status.textContent = 'Vorgang für den Bericht übernommen.';
      });
    }

    if (locations.length === 1) {
      appendRecord(root, data.records.get(locations[0].recordId), locations[0]);
    } else {
      text(root, 'h4', 'Ratsvorgänge an dieser Stelle');
      const list = text(root, 'ul', '');
      for (const location of locations) appendRecord(text(list, 'li', ''), data.records.get(location.recordId), location);
    }
    const related = linkedRecords(data, locations.map(location => location.recordId));
    if (related.length) {
      text(root, 'h4', 'Verknüpfte Vorgänge');
      const list = text(root, 'ul', '');
      for (const entry of related) appendRecord(text(list, 'li', ''), entry);
    }
    root.appendChild(status);
    return root;
  }

  function vectorStyle(feature) {
    const { color, dashed } = styles[feature.properties.accuracy];
    return { color, weight: 4, dashArray: dashed ? '7 5' : null, fillOpacity: 0.16 };
  }

  function pointMarker(L, feature, latlng) {
    const { color, dashed, fill } = styles[feature.properties.accuracy];
    const swatch = document.createElement('span');
    swatch.style.cssText = `display:block;width:100%;height:100%;box-sizing:border-box;` +
      `background:${fill};border:3px ${dashed ? 'dashed' : 'solid'} ${color};` +
      `border-radius:${dashed ? '50%' : '3px'};box-shadow:0 0 0 2px #fff,0 1px 4px 2px #555`;
    const size = [20, 20];
    return L.marker(latlng, { pane: PANE, icon: L.divIcon({ className: 'ua-ris-point', html: swatch, iconSize: size }) });
  }

  function bindFeature(ctx, state, data, feature, layer) {
    if (typeof layer.eachLayer === 'function') {
      layer.eachLayer(child => bindFeature(ctx, state, data, feature, child));
      return;
    }
    const { locations } = feature.properties;
    layer.bindPopup(() => popup(ctx, state, data, feature), { maxWidth: 340, maxHeight: 280 });
    layer.on('add', () => {
      const el = layer.getElement();
      if (!el) return;
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', locations.length === 1
        ? `Ratsvorgang: ${data.records.get(locations[0].recordId).title}`
        : `${locations.length} Ratsvorgänge an dieser Stelle`);
      el.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        layer.openPopup();
      });
    });
  }

  function clearLayer(state) {
    if (state.layer) state.layer.remove();
    state.layer = null;
    state.featureLayers.clear();
    state.rendered = null;
  }

  function showError(state, error) {
    if (error?.code === 'RIS_SECURE_CONTEXT_REQUIRED') {
      state.status.textContent = error.message;
      return;
    }
    state.status.textContent = error?.code === 'RIS_SNAPSHOT_UNAVAILABLE'
      ? 'Für diese Stadt ist kein Kartenbestand zu Ratsvorgängen verfügbar.'
      : 'Der Kartenbestand konnte nicht geladen werden. Zum erneuten Versuch aus- und einschalten.';
  }

  function syncVisibleLayers(ctx, state, data, visible) {
    const next = new Set(visible);
    for (const [feature, layer] of state.featureLayers) {
      if (next.has(feature)) continue;
      state.layer.removeLayer(layer);
      state.featureLayers.delete(feature);
    }
    if (!visible.length) return;
    const L = window.L;
    if (!state.layer) {
      if (!state.renderer) {
        const pane = state.map.getPane(PANE) || state.map.createPane(PANE);
        pane.style.zIndex = '410';
        state.renderer = L.svg({ pane: PANE }); // SVG allows keyboard focus on lines and areas.
      }
      state.layer = L.geoJSON([], {
        pane: PANE, renderer: state.renderer, bubblingMouseEvents: false,
        style: vectorStyle,
        pointToLayer: (feature, latlng) => pointMarker(L, feature, latlng),
        onEachFeature(feature, layer) {
          bindFeature(ctx, state, data, feature, layer);
          state.featureLayers.set(feature, layer);
        },
      }).addTo(state.map);
    }
    // Keep any layer that remains visible, including its open popup or focus.
    for (const feature of visible) {
      if (!state.featureLayers.has(feature)) state.layer.addData(feature);
    }
  }

  function recordCount(features) {
    const ids = new Set();
    for (const feature of features) {
      for (const { recordId } of feature.properties.locations) ids.add(recordId);
    }
    return ids.size;
  }

  function draw(ctx, state, rect) {
    const viewport = rectOf(state.map.getBounds());
    const key = `${rect?.join(',') || 'all'}|${viewport?.join(',') || 'empty'}`;
    if (state.rendered === key) return;
    state.rendered = key;
    const data = state.data;
    try {
      const selected = rect ? data.features.filter(feature => featureHits(feature, rect)) : data.features;
      const visible = viewport ? selected.filter(feature => featureHits(feature, viewport)) : [];
      syncVisibleLayers(ctx, state, data, visible);
      state.legend.hidden = !visible.length;
      state.mixedLegend.hidden = !visible.some(feature => feature.properties.accuracy === 'mixed');
      let status;
      if (!selected.length) {
        status = data.features.length
          ? 'Keine Ratsvorgänge in der Markierung.'
          : 'Der Kartenbestand enthält keine verorteten Ratsvorgänge.';
      } else {
        const shown = recordCount(visible);
        const total = visible.length === selected.length ? shown : recordCount(selected);
        const scope = rect ? ' in der Markierung' : '';
        status = `${total} ${total === 1 ? 'verorteter Ratsvorgang' : 'verortete Ratsvorgänge'}${scope} · ${shown} im Kartenausschnitt`;
      }
      if (state.status.textContent !== status) state.status.textContent = status;
    } catch (error) {
      clearLayer(state);
      state.data = null;
      state.legend.hidden = true;
      state.coverage.hidden = true;
      showError(state, error);
    }
  }

  function showCoverage(state, manifest) {
    const { generatedAt, coverage } = manifest || {};
    const { from, to, complete, bodies, warnings } = coverage || {};
    const date = value => String(value || '').slice(0, 10).split('-').reverse().join('.');
    const details = state.coverage;
    details.replaceChildren();
    text(details, 'summary', complete === false ? 'Datenstand und Abdeckung (Teilbestand)' : 'Datenstand und Abdeckung');
    const info = text(details, 'div', '');
    info.style.cssText = 'max-height:6rem;overflow:auto';
    if (generatedAt) text(info, 'div', `Stand: ${date(generatedAt)}`);
    if (from || to) text(info, 'div', `Zeitraum: ${date(from) || 'offen'} bis ${date(to) || 'offen'}`);
    if (bodies?.length) text(info, 'div', `Gremien: ${bodies.join(', ')}`);
    for (const warning of warnings || []) text(info, 'div', warning);
    details.hidden = false;
  }

  function refresh(ctx) {
    const state = controls.get(ctx);
    if (!state || ctx.map !== state.map) return;
    const city = cityOf(ctx);
    if (state.city !== city) {
      clearLayer(state);
      Object.assign(state, { city, data: null, pending: null });
      state.toggle.checked = state.filter.checked = false;
      state.body.hidden = state.legend.hidden = state.coverage.hidden = true;
      state.status.textContent = '';
    }
    const rect = rectOf(ctx.selectionBounds);
    state.filter.disabled = !rect;
    state.filter.parentElement.style.display = rect ? 'block' : 'none';
    if (!rect) state.filter.checked = false;
    if (state.toggle.checked && state.data) draw(ctx, state, state.filter.checked ? rect : null);
  }

  function enable(ctx, state) {
    if (state.data) {
      showCoverage(state, state.data.manifest);
      refresh(ctx);
      return;
    }
    state.status.textContent = 'Ratsvorgänge werden geladen …';
    if (state.pending) return;
    const city = state.city;
    const request = Promise.resolve().then(() => UA.RisCatalogue.loadMap(city)).then(indexSnapshot);
    state.pending = request;
    request.then(data => {
      if (!current(ctx, state) || state.pending !== request) return;
      state.data = data;
      state.pending = null;
      if (state.toggle.checked) enable(ctx, state);
    }, error => {
      if (!current(ctx, state) || state.pending !== request) return;
      state.pending = null;
      if (state.toggle.checked) showError(state, error);
    });
  }

  function controlContent(ctx) {
    if (typeof UA.RisCatalogue?.loadMap !== 'function') return null;
    const old = controls.get(ctx);
    if (old && old.map === ctx.map) {
      refresh(ctx);
      return old.root;
    }
    if (old) {
      clearLayer(old);
      old.map.off('moveend', old.onMove);
    }
    const root = document.createElement('div');
    root.style.maxWidth = '185px';
    const toggle = checkbox(root, 'Ratsvorgänge');
    toggle.dataset.contextOverlay = 'ris';
    const body = text(root, 'div', '');
    const filter = checkbox(body, 'Nur in markierter Fläche');
    const status = text(body, 'div', '');
    status.setAttribute('role', 'status');
    const legend = text(body, 'div', '');
    let mixedLegend;
    for (const [accuracy, { label, color, dashed }] of Object.entries(styles)) {
      const row = text(legend, 'div', '');
      const sample = text(row, 'span', '');
      sample.style.cssText = `display:inline-block;width:15px;border-top:3px ${dashed ? 'dashed' : 'solid'} ${color};vertical-align:middle`;
      row.append(document.createTextNode(` ${label}`));
      if (accuracy === 'mixed') mixedLegend = row;
    }
    const coverage = text(body, 'details', '');
    body.hidden = legend.hidden = coverage.hidden = true;
    const onMove = () => { if (toggle.checked) refresh(ctx); };
    const state = {
      root, toggle, body, filter, status, legend, mixedLegend, coverage, onMove,
      map: ctx.map, city: cityOf(ctx), featureLayers: new Map(),
    };
    controls.set(ctx, state);
    state.map.on('moveend', onMove);
    state.map.once('unload', () => {
      state.map.off('moveend', onMove);
      if (controls.get(ctx) === state) controls.delete(ctx);
    });
    toggle.addEventListener('change', () => {
      refresh(ctx);
      if (!current(ctx, state)) return;
      body.hidden = !toggle.checked;
      if (toggle.checked) enable(ctx, state);
      else {
        clearLayer(state);
        status.textContent = '';
        legend.hidden = coverage.hidden = true;
      }
    });
    filter.addEventListener('change', () => refresh(ctx));
    refresh(ctx);
    return root;
  }

  UA.RisLayer = { controlContent, refresh };
})();
