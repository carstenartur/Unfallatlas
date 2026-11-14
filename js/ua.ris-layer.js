(() => {
  const UA = (window.UA = window.UA || {});
  const controls = new WeakMap();
  const PANE = 'uaRisPane';
  const styles = {
    official: { label: 'Amtlich verortet', color: '#532b78', dashed: false, fill: '#532b78' },
    derived: { label: 'Abgeleitete Lage', color: '#7a4709', dashed: true, fill: '#fff' },
    mixed: { label: 'Amtliche und abgeleitete Lage', color: '#532b78', dashed: true, fill: '#eee0fb' },
  };
  const sourceLabels = new Map([
    ['hannover-sim', 'Landeshauptstadt Hannover · SIM'],
    ['region-hannover-ris', 'Region Hannover · ALLRIS'],
  ]);
  const sourceLabel = source => sourceLabels.get(source) || source;

  const cityOf = ctx => String(ctx.CITY_RAW || '').trim();

  function sharedState(ctx) {
    ctx.contextOverlays ||= {};
    ctx.contextOverlays.active ||= { slope: false, traffic: false };
    ctx.contextOverlays.active.ris = !!ctx.contextOverlays.active.ris;
    ctx.risView ||= { selectionOnly: false };
    return ctx.contextOverlays.active;
  }

  function sync(ctx) {
    if (!UA._hydrating) UA.syncAllToUrl?.(ctx);
  }

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
    if (snapshot.partitioned) return { ...snapshot, features: snapshot.features.features.map(feature => ({ ...feature, bbox: feature.bounds || coordinateBounds(feature.geometry.coordinates) })) };
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

  function popupGuard(ctx, state, data, layer, root) {
    const revision = ctx.politicalContextCityRevision;
    const token = layer._uaRisPopupToken = Symbol('ris-popup');
    const active = () => current(ctx, state) && state.toggle.checked && state.data === data
      && ctx.politicalContextCityRevision === revision && layer._uaRisPopupToken === token;
    layer.once('popupclose', () => { if (layer._uaRisPopupToken === token) layer._uaRisPopupToken = null; });
    // Leaflet measures the initial loading placeholder. Reflow the same root
    // after each asynchronous expansion so its maxHeight and auto-pan apply.
    const captureLayout = () => ({
      focus: root.contains(document.activeElement) ? document.activeElement : null,
      content: root.parentElement,
      top: root.parentElement?.scrollTop || 0,
      left: root.parentElement?.scrollLeft || 0,
    });
    const reflow = (view = captureLayout()) => {
      if (!active() || !layer.isPopupOpen()) return;
      layer.getPopup().update();
      if (!active() || !layer.isPopupOpen()) return;
      // Leaflet detaches even the cached root while measuring it. Restore only
      // focus that belonged to this popup; never take focus from another UI.
      if (view.focus && (document.activeElement === document.body || root.contains(document.activeElement))) {
        const usable = root.contains(view.focus) && !view.focus.disabled
          && !view.focus.closest('[hidden], [inert], [aria-hidden="true"]');
        const target = usable ? view.focus : root.querySelector('[role="status"]');
        if (target) {
          if (!usable) target.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
      }
      if (view.content?.isConnected) {
        view.content.scrollTop = view.top;
        view.content.scrollLeft = view.left;
      }
    };
    // Native disabling can blur the active button before an async response.
    // Keep it focusable while blocking repeated activation accessibly.
    const pending = button => button.getAttribute('aria-disabled') === 'true';
    const setPending = (button, value) => button.setAttribute('aria-disabled', String(value));
    return { active, captureLayout, reflow, pending, setPending };
  }

  function recordContext(parent, entry, ctx, guard) {
    const context = entry.sourceContext;
    if (context) {
      const levels = Object.fromEntries((UA.RisSources?.levels || [
        { id: 'city', label: 'Stadt' }, { id: 'region', label: 'Region' }, { id: 'state', label: 'Land' },
        { id: 'federal', label: 'Deutschland' }, { id: 'eu', label: 'EU' },
      ]).map(level => [level.id, level.label]));
      const statuses = { proposal: 'Vorlage / Antrag', answer: 'Antwort', agenda: 'Tagesordnung', minutes: 'Protokoll', other: 'Sonstiges' };
      text(parent, 'div', [levels[context.level], context.publisher, context.issuer, context.documentKind, statuses[context.status]].filter(Boolean).join(' · '));
      const dates = [['publicationDate', 'Veröffentlichung'], ['documentDate', 'Dokumentdatum'], ['meetingDate', 'Sitzungsdatum']];
      for (const [field, label] of dates) if (context[field]) text(parent, 'div', `${label}: ${context[field]}`);
    }
    const pdf = httpsUrl(entry.originalPdfUrl);
    if (pdf) {
      const link = text(parent, 'a', 'Original-PDF');
      link.href = pdf; link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
    if (entry.id && typeof UA.RisDetails?.open === 'function') {
      const open = text(parent, 'button', 'Verlauf und Zusammenhänge');
      open.type = 'button'; open.className = 'smallBtn';
      open.setAttribute('aria-label', `Verlauf und Zusammenhänge: ${entry.title}`);
      open.addEventListener('click', () => {
        if (guard.active()) UA.RisDetails.open(ctx, entry.id, { trigger: ctx.map.getContainer() });
      });
    }
  }

  function popup(ctx, state, data, feature, layer) {
    const root = document.createElement('section');
    root.style.overflowWrap = 'anywhere';
    const guard = popupGuard(ctx, state, data, layer, root);
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    const { locations } = feature.properties;

    function appendRecord(parent, entry, location) {
      const place = Number.isInteger(location?.locationIndex) ? entry.locations?.[location.locationIndex] : null;
      const details = place && UA.PoliticalContext?.renderLocation?.(place);
      if (location) {
        let mapLabel = location.label || '';
        if (details) {
          // The snapshot appends the geometry attribution to its map label.
          const prefix = `${place.label} — `;
          if (mapLabel === place.label) mapLabel = '';
          else if (mapLabel.startsWith(prefix)) mapLabel = mapLabel.slice(prefix.length);
        }
        const label = [styles[location.accuracy].label, mapLabel].filter(Boolean).join(' · ');
        text(parent, 'div', label).style.marginBottom = '6px';
      }
      text(parent, 'strong', entry.title);
      const meta = [entry.type, entry.number, entry.date, entry.gremium || entry.premium].filter(Boolean);
      if (meta.length) text(parent, 'div', meta.join(' · '));
      recordContext(parent, entry, ctx, guard);
      if (details) {
        details.style.cssText = 'margin:4px 0;overflow-wrap:anywhere';
        parent.append(details);
      }
      const source = entry.source ? ` · Quelle: ${sourceLabel(entry.source)}` : '';
      const url = httpsUrl(entry.url);
      if (!url) {
        if (entry.source) text(parent, 'div', `Quelle: ${sourceLabel(entry.source)}`);
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
      adopt.addEventListener('click', async () => {
        const revision = ctx.politicalContextCityRevision;
        const active = () => current(ctx, state) && state.toggle.checked && state.data === data
          && ctx.politicalContextCityRevision === revision;
        if (adopt.disabled || !active()) return;
        adopt.disabled = true;
        status.textContent = 'Vorgang wird geprüft …';
        try {
          await UA.PoliticalContext.addReferences(ctx, [entry]);
          if (active()) status.textContent = 'Vorgang für den Bericht übernommen.';
        } catch (error) {
          if (active()) {
            if (error?.code === 'RIS_SNAPSHOT_REFERENCE_MISMATCH') {
              clearLayer(state);
              state.data = null;
              state.legend.hidden = state.coverage.hidden = true;
              state.status.textContent = 'Der Vorgang gehört nicht zum aktuellen Datenstand. Bitte den Kartenlayer aus- und wieder einschalten.';
            } else {
              status.textContent = error?.message || 'Der Vorgang konnte nicht übernommen werden.';
            }
          }
        } finally {
          adopt.disabled = state.data !== data;
        }
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

  function partitionPopup(ctx, state, data, feature, layer) {
    const root = document.createElement('section');
    root.style.overflowWrap = 'anywhere';
    const { active, captureLayout, reflow, pending, setPending } = popupGuard(ctx, state, data, layer, root);
    const props = feature.properties;
    if (props.overview) {
      text(root, 'strong', 'Übersicht: zusammengefasste Kartenlagen');
      if (props.spatialGroup) {
        text(root, 'p', `${props.geometryCount} Kartenlagen in dieser räumlichen Gruppe. Beim Vergrößern werden die einzelnen Lagen sichtbar.`);
      } else {
        text(root, 'p', `${props.recordCount} Ratsvorgänge · ${props.geometryCount} Kartenlagen in dieser Zelle. Die Fläche zeigt eine Zusammenfassung, keine genaue Lage.`);
      }
      const zoom = text(root, 'button', 'Für Details vergrößern');
      zoom.type = 'button'; zoom.className = 'smallBtn';
      const zoomStatus = text(root, 'div', '');
      zoomStatus.setAttribute('role', 'status');
      const canZoom = () => {
        const maximum = state.map.getMaxZoom();
        const atMaximum = Number.isFinite(maximum) && state.map.getZoom() >= maximum;
        zoom.disabled = atMaximum;
        zoom.textContent = atMaximum ? 'Maximale Vergrößerung erreicht' : 'Für Details vergrößern';
        zoomStatus.hidden = !atMaximum;
        zoomStatus.textContent = atMaximum
          ? 'Die Karte kann hier nicht weiter vergrößert werden. Die Übersicht bleibt zusammengefasst.' : '';
        return !atMaximum;
      };
      canZoom();
      zoom.addEventListener('click', () => {
        if (!active()) return;
        if (!canZoom()) { reflow(); return; }
        const map = state.map;
        const currentZoom = map.getZoom();
        const maximum = map.getMaxZoom();
        const zoomLimit = Number.isFinite(maximum) ? maximum : Math.max(18, currentZoom + 1);
        let [w, s, e, n] = feature.bbox;
        // Budget fallbacks can return a cell much larger than the current
        // high-zoom view. Drill into its visible part, never back out to it.
        const viewport = rectOf(map.getBounds());
        if (viewport) {
          const clipped = [Math.max(w, viewport[0]), Math.max(s, viewport[1]),
            Math.min(e, viewport[2]), Math.min(n, viewport[3])];
          if (clipped[0] < clipped[2] && clipped[1] < clipped[3]) [w, s, e, n] = clipped;
        }
        const bounds = window.L.latLngBounds([s, w], [n, e]);
        const nextZoom = Math.min(zoomLimit, Math.max(currentZoom + 1, map.getBoundsZoom(bounds)));
        map.setView(bounds.getCenter(), nextZoom, { animate: false });
        map.getContainer().focus({ preventScroll: true });
      });
      return root;
    }
    text(root, 'h4', 'Ratsvorgänge an dieser Stelle');
    const list = text(root, 'ul', '');
    const status = text(root, 'div', 'Vorgänge werden geladen …');
    status.setAttribute('role', 'status');
    const more = text(root, 'button', 'Weitere Vorgänge laden');
    more.type = 'button'; more.className = 'smallBtn';
    more.hidden = true;
    let page = 0;
    const seen = new Set();

    function appendRecord(parent, entry, location, withRelated = true) {
      text(parent, 'strong', entry.title);
      const meta = [entry.type, entry.number, entry.date, entry.gremium || entry.premium].filter(Boolean);
      if (meta.length) text(parent, 'div', meta.join(' · '));
      recordContext(parent, entry, ctx, { active });
      if (location) text(parent, 'div', [styles[location.accuracy || props.accuracy]?.label, location.label].filter(Boolean).join(' · '));
      const evidence = text(parent, 'div', '');
      const place = entry.locations?.find(item => item.id === location?.locationId);
      if (place) {
        const detail = UA.PoliticalContext?.renderLocation?.(place);
        if (detail) evidence.append(detail);
      } else if (location?.locationId && (entry.locationCount > 0 || entry.locations?.length || entry.locationsNextPage != null)) {
        // A feature may refer to a location beyond the record's first page.
        // Read one bounded page per explicit action and match the stable ID.
        const inspect = text(evidence, 'button', 'Ortsbeleg laden');
        inspect.type = 'button'; inspect.className = 'smallBtn';
        let locationPage = entry.locationsNextPage ?? 0;
        inspect.addEventListener('click', async () => {
          if (!active() || pending(inspect)) return;
          setPending(inspect, true);
          let view;
          try {
            const result = await UA.RisCatalogue.loadRecordLocations(state.city, entry.id, locationPage, { snapshot: data.manifest });
            if (!active()) return;
            view = captureLayout();
            const match = result.locations.find(item => item.id === location.locationId);
            if (match) {
              const detail = UA.PoliticalContext?.renderLocation?.(match);
              evidence.replaceChildren();
              if (detail) evidence.append(detail);
            } else if (result.nextPage != null) {
              locationPage = result.nextPage;
              inspect.textContent = 'Weitere Ortsbelege durchsuchen';
            } else {
              inspect.textContent = 'Ortsbeleg nicht verfügbar · Erneut versuchen';
              locationPage = 0;
            }
          } catch (error) {
            if (active()) status.textContent = error?.message || 'Ortsbeleg konnte nicht geladen werden.';
          } finally { setPending(inspect, false); reflow(view); }
        });
      }
      const url = httpsUrl(entry.url);
      if (url) {
        const link = text(parent, 'a', 'Amtliches Dokument');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `Amtliches Dokument: ${entry.title}`);
        if (typeof UA.PoliticalContext?.addReferences === 'function') {
          const adopt = text(parent, 'button', 'Für Bericht übernehmen');
          adopt.type = 'button'; adopt.className = 'smallBtn';
          adopt.setAttribute('aria-label', `${entry.title} für Bericht übernehmen`);
          adopt.addEventListener('click', async () => {
            if (!active() || pending(adopt)) return;
            setPending(adopt, true);
            try {
              await UA.PoliticalContext.addReferences(ctx, [entry]);
              if (active()) status.textContent = 'Vorgang für den Bericht übernommen.';
            } catch (error) {
              if (active()) status.textContent = error?.message || 'Der Vorgang konnte nicht übernommen werden.';
            } finally { setPending(adopt, false); reflow(); }
          });
        }
      }
      if (entry.source) text(parent, 'div', `Quelle: ${sourceLabel(entry.source)}`);
      if (!withRelated) return;
      const relatedList = text(parent, 'ul', '');
      const relatedButton = text(parent, 'button', 'Verknüpfte Vorgänge anzeigen');
      relatedButton.type = 'button'; relatedButton.className = 'smallBtn';
      let relatedPage = 0;
      const relatedSeen = new Set();
      relatedButton.addEventListener('click', async () => {
        if (!active() || pending(relatedButton)) return;
        setPending(relatedButton, true);
        let view;
        try {
          const result = await UA.RisCatalogue.loadRelatedRecords(state.city, entry.id, relatedPage, { snapshot: data.manifest });
          if (!active()) return;
          view = captureLayout();
          for (const related of result.records) {
            if (relatedSeen.has(related.id)) continue;
            relatedSeen.add(related.id);
            appendRecord(text(relatedList, 'li', ''), related, null, false);
          }
          status.textContent = result.complete === false ? 'Verknüpfte Vorgänge unvollständig; Daten fehlen.'
            : !relatedSeen.size ? 'Keine verknüpften Vorgänge.' : `${relatedSeen.size} verknüpfte Vorgänge geladen.`;
          if (result.complete === false) relatedButton.textContent = 'Verknüpfte Vorgänge erneut laden';
          else if (result.nextPage != null) { relatedPage = result.nextPage; relatedButton.textContent = 'Weitere verknüpfte Vorgänge laden'; }
          else relatedButton.hidden = true;
        } catch (error) {
          if (active()) status.textContent = error?.message || 'Verknüpfte Vorgänge konnten nicht geladen werden. Bitte erneut versuchen.';
        } finally { setPending(relatedButton, false); reflow(view); }
      });
    }

    async function loadPage() {
      if (!active() || pending(more)) return;
      setPending(more, true);
      let view;
      try {
        const result = await UA.RisCatalogue.loadFeatureRecords(state.city, props.geometryId, page, { snapshot: data.manifest });
        if (!active()) return;
        view = captureLayout();
        const records = new Map(result.records.map(entry => [entry.id, entry]));
        for (const location of result.links) {
          const key = `${location.recordId}/${location.locationId || ''}`;
          const entry = records.get(location.recordId);
          if (!entry || seen.has(key)) continue;
          seen.add(key);
          appendRecord(text(list, 'li', ''), entry, location);
        }
        status.textContent = result.complete === false ? 'Vorgänge unvollständig; Daten fehlen.' : `${seen.size} von ${result.total ?? seen.size} Ortsbezügen geladen.`;
        more.hidden = result.nextPage == null && result.complete !== false;
        more.textContent = result.complete === false || result.nextPage == null ? 'Erneut versuchen' : 'Weitere Vorgänge laden';
        if (result.complete !== false && result.nextPage != null) page = result.nextPage;
      } catch (error) {
        if (active()) {
          status.textContent = error?.message || 'Vorgänge konnten nicht geladen werden.';
          more.textContent = 'Erneut versuchen'; more.hidden = false;
        }
      } finally { setPending(more, false); reflow(view); }
    }
    more.addEventListener('click', loadPage);
    loadPage();
    return root;
  }

  function vectorStyle(feature) {
    if (feature.properties.overview) return { color: '#532b78', weight: 2, dashArray: '5 5', fillOpacity: 0.12 };
    const { color, dashed } = styles[feature.properties.accuracy];
    return { color, weight: 4, dashArray: dashed ? '7 5' : null, fillOpacity: 0.16 };
  }

  function pointMarker(L, feature, latlng) {
    if (feature.properties.spatialGroup) {
      const badge = document.createElement('span');
      badge.textContent = feature.properties.geometryCount.toLocaleString('de-DE');
      badge.style.cssText = 'display:grid;place-items:center;width:100%;height:100%;border-radius:50%;'
        + 'box-shadow:0 0 0 2px #fff,0 1px 4px #555;background:#532b78;color:white;font-weight:bold';
      return L.marker(latlng, { pane: PANE, icon: L.divIcon({ className: 'ua-ris-group', html: badge, iconSize: [32, 32] }) });
    }
    const { color, dashed, fill } = styles[feature.properties.accuracy];
    const swatch = document.createElement('span');
    swatch.style.cssText = `display:block;width:100%;height:100%;box-sizing:border-box;` +
      `background:${fill};border:3px ${dashed ? 'dashed' : 'solid'} ${color};` +
      `border-radius:${dashed ? '50%' : '3px'};box-shadow:0 0 0 2px #fff,0 1px 4px 2px #555`;
    const size = [20, 20];
    return L.marker(latlng, { pane: PANE, icon: L.divIcon({ className: 'ua-ris-point', html: swatch, iconSize: size }) });
  }

  function popupLayout(ctx, state) {
    const container = state.map.getContainer();
    const view = container.getBoundingClientRect();
    const options = { maxWidth: 340, maxHeight: 280 };
    if (!view.width || !view.height) return options;

    const margin = 8;
    if (window.matchMedia?.(UA.COMPACT_MAP_QUERY)?.matches) {
      // CSS temporarily hides the workspace and map cards while this popup
      // is open. Leave room for the shortcut back to the results.
      const launcher = document.getElementById('btnRisBrowse')?.getBoundingClientRect();
      const top = launcher?.height ? Math.max(margin, launcher.bottom - view.top + margin) : margin;
      return {
        maxWidth: Math.max(50, Math.min(options.maxWidth, view.width - 2 * margin - 50)),
        maxHeight: Math.max(50, Math.min(options.maxHeight, view.height - top - margin - 56)),
        autoPanPaddingTopLeft: [margin, top],
        autoPanPaddingBottomRight: [margin, margin],
      };
    }
    const panel = ctx.ui?.panelEl?.getBoundingClientRect();
    const list = document.querySelector('body.ris-list-open:not(.ris-list-collapsed) #polCtxPanel')?.getBoundingClientRect();
    const layerControlElement = state.root.closest('.context-overlay-control');
    const legendElement = container.querySelector('.layer-legend-control');
    const layerControl = layerControlElement?.getBoundingClientRect();
    const legend = legendElement?.getBoundingClientRect();
    // Karte owns both control aliases. Reserve its right-hand column once,
    // leaving the full central height usable beside tall desktop sidebars.
    const unifiedCard = layerControlElement && layerControlElement === legendElement;
    const left = Math.max(margin, ...[panel, list].filter(box => box?.width)
      .map(box => box.right - view.left + margin));
    const top = !unifiedCard && layerControl?.height ? Math.max(margin, layerControl.bottom - view.top + margin) : margin;
    const legendRight = legend?.width ? Math.max(margin, view.right - legend.left + margin) : margin;
    const legendBottom = legend?.height ? Math.max(margin, view.bottom - legend.top + margin) : margin;
    const besideLegend = unifiedCard || view.height - top - legendBottom < options.maxHeight + 56
      && view.width - left - legendRight >= 210;
    const right = besideLegend ? legendRight : margin;
    const bottom = besideLegend ? margin : legendBottom;
    return {
      // Leaflet's maximums apply to the content, leaving room for its frame and tip.
      maxWidth: Math.max(50, Math.min(options.maxWidth, view.width - left - right - 50)),
      maxHeight: Math.max(50, Math.min(options.maxHeight, view.height - top - bottom - 56)),
      autoPanPaddingTopLeft: [left, top],
      autoPanPaddingBottomRight: [right, bottom],
    };
  }

  function bindFeature(ctx, state, data, feature, layer) {
    if (typeof layer.eachLayer === 'function') {
      layer.eachLayer(child => bindFeature(ctx, state, data, feature, child));
      return;
    }
    const { locations } = feature.properties;
    layer.bindPopup(() => {
      window.L.setOptions(layer.getPopup(), popupLayout(ctx, state));
      if (layer._uaRisPopupToken && layer._uaRisPopupRoot) return layer._uaRisPopupRoot;
      return layer._uaRisPopupRoot = data.partitioned
        ? partitionPopup(ctx, state, data, feature, layer) : popup(ctx, state, data, feature, layer);
    }, { className: 'ua-ris-popup' });
    if (feature.properties.spatialGroup) {
      layer.on('popupclose', () => positionGroupMarker(feature, layer));
    }
    layer.on('add', () => {
      const el = layer.getElement();
      if (!el) return;
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      const props = feature.properties;
      let label = data.partitioned
        ? `${props.recordCount} Ratsvorgänge: ${props.label || 'Kartenlage'}`
        : locations.length === 1
        ? `Ratsvorgang: ${data.records.get(locations[0].recordId).title}`
        : `${locations.length} Ratsvorgänge an dieser Stelle`;
      if (props.spatialGroup) label = `Räumliche Gruppe: ${props.geometryCount} Kartenlagen; für Details vergrößern`;
      else if (props.overview) label = `Übersichtszelle: ${props.recordCount} Ratsvorgänge; für Details vergrößern`;
      el.setAttribute('aria-label', label);
      el.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        layer.openPopup();
      });
    });
  }

  function clearLayer(state) {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = undefined;
    if (state.layer) state.layer.remove();
    state.layer = null;
    state.featureLayers.clear();
    state.rendered = null;
    state.focused = null;
  }

  function showError(state, error) {
    if (error?.code === 'RIS_SECURE_CONTEXT_REQUIRED') {
      state.status.textContent = error.message;
      return;
    }
    if (error?.code === 'RIS_SNAPSHOT_EXPIRED') {
      state.status.textContent = error.message || 'Der letzte Kartenbestand ist abgelaufen. Bitte das amtliche Portal öffnen.';
      return;
    }
    state.status.textContent = error?.code === 'RIS_SNAPSHOT_UNAVAILABLE'
      ? 'Für diese Stadt ist kein Kartenbestand zu Ratsvorgängen verfügbar.'
      : 'Der Kartenbestand konnte nicht geladen werden. Zum erneuten Versuch aus- und einschalten.';
  }

  function positionGroupMarker(feature, layer) {
    const [lng, lat] = feature.geometry.coordinates;
    const current = layer.getLatLng();
    if (current.lat !== lat || current.lng !== lng) layer.setLatLng([lat, lng]);
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
      const layer = state.featureLayers.get(feature);
      if (!layer) state.layer.addData(feature);
      else if (feature.properties.spatialGroup && !layer.isPopupOpen()) positionGroupMarker(feature, layer);
    }
  }

  function recordCount(features) {
    const ids = new Set();
    for (const feature of features) {
      for (const { recordId } of feature.properties.locations) ids.add(recordId);
    }
    return ids.size;
  }

  function draw(ctx, state, rect, freshness) {
    const viewport = rectOf(state.map.getBounds());
    const { complete, stale } = freshness;
    const key = `${rect?.join(',') || 'all'}|${viewport?.join(',') || 'empty'}|${complete}|${stale}`;
    if (state.rendered === key) return;
    state.rendered = key;
    const data = state.data;
    try {
      showCoverage(state, data.manifest, freshness);
      if (data.partitioned) {
        const candidates = [...data.features];
        if (state.focused && !candidates.includes(state.focused)) candidates.push(state.focused);
        const visible = candidates.filter(feature => (!rect || featureHits(feature, rect)) && viewport && featureHits(feature, viewport));
        syncVisibleLayers(ctx, state, data, visible);
        state.legend.hidden = !visible.some(feature => !feature.properties.overview);
        state.mixedLegend.hidden = !visible.some(feature => feature.properties.accuracy === 'mixed');
        let status = `${visible.length} Kartenlagen im Kartenausschnitt`;
        if (data.overview) {
          const grouping = visible.some(feature => feature.properties.spatialGroup) ? 'räumliche Gruppen' : 'zusammengefasste Zellen';
          status = `Übersicht: ${grouping} · Für genaue Kartenlagen vergrößern`;
        }
        const budgetOverview = data.overview && data.coverage?.truncated === true
          && Array.isArray(data.coverage.missing) && data.coverage.missing.length === 0;
        if (!data.coverage?.complete) {
          if (!budgetOverview) status += ' · Kartenabdeckung unvollständig; Daten fehlen';
        } else if (!visible.length) status = 'Keine verorteten Ratsvorgänge im Kartenausschnitt' + (rect ? ' innerhalb der Markierung' : '') + '.';
        if (data.coverage?.truncated) status += ' · Detailbudget erreicht';
        if (!complete) status += ' · Teilbestand';
        if (stale) status += ' · Veralteter Datenstand';
        if (data.manifest.refreshFailure) status += ' · Aktualisierung fehlgeschlagen';
        if (state.pending) status += ' · Kartenausschnitt wird geladen …';
        if (state.loadError) status += ' · Aktualisierung fehlgeschlagen; Karte bewegen oder Layer erneut einschalten';
        state.status.textContent = status;
        return;
      }
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
      if (!complete) status += ' · Teilbestand';
      if (stale) status += ' · Veralteter Datenstand';
      if (data.manifest.refreshFailure) status += ' · Aktualisierung fehlgeschlagen';
      if (state.status.textContent !== status) state.status.textContent = status;
    } catch (error) {
      clearLayer(state);
      state.data = null;
      state.legend.hidden = true;
      state.coverage.hidden = true;
      showError(state, error);
    }
  }

  function showCoverage(state, manifest, { complete, stale, expired, warnings }) {
    const { generatedAt, coverage: { from, to, bodies } } = manifest;
    const date = value => String(value || '').slice(0, 10).split('-').reverse().join('.');
    const details = state.coverage;
    const labels = expired ? ['Abgelaufen'] : [!complete && 'Teilbestand', stale && 'Veraltet'].filter(Boolean);
    const summary = `Datenstand und Abdeckung${labels.length ? ` (${labels.join(', ')})` : ''}`;
    if (!details.hidden && state.coverageManifest === manifest && details.firstElementChild?.textContent === summary) return;
    state.coverageManifest = manifest;
    details.replaceChildren();
    text(details, 'summary', summary);
    const info = text(details, 'div', '');
    info.style.cssText = 'max-height:6rem;overflow:auto';
    if (generatedAt) text(info, 'div', `Stand: ${date(generatedAt)}`);
    if (from || to) text(info, 'div', `Zeitraum: ${date(from) || 'offen'} bis ${date(to) || 'offen'}`);
    if (bodies?.length) text(info, 'div', `Gremien: ${bodies.join(', ')}`);
    for (const warning of warnings) text(info, 'div', warning);
    details.hidden = false;
  }

  function scheduleFreshnessCheck(ctx, state, checkAt) {
    if (state.expiryTimer !== undefined || !Number.isFinite(checkAt)) return;
    // Clamp delays that exceed the browser's timer range.
    const delay = Math.max(0, Math.min(checkAt - Date.now(), 0x7fffffff));
    state.expiryTimer = setTimeout(() => {
      state.expiryTimer = undefined;
      refresh(ctx);
    }, delay);
  }

  function catalogueLevelCountLabels(manifest) {
    const sources = UA.RisSources;
    if (!sources || !manifest.levelCounts) return [];
    const declaredLevels = new Set((manifest.sourceStatuses || []).map(status => sources.levelOf(status)));
    const levels = [...sources.levels, { id: 'unknown', label: 'Ebene offen' }];
    return levels.flatMap(({ id, label }) => {
      const counts = manifest.levelCounts[id];
      if (counts) return [`${label} ${counts.records.toLocaleString('de-DE')} (${counts.mapped.toLocaleString('de-DE')} verortet)`];
      return declaredLevels.has(id) ? [`${label} 0`] : [];
    });
  }

  function refreshCatalogueCount(ctx, state) {
    const footer = ctx.ui?.risCatalogueCountEl;
    const city = state.city;
    if (!footer || typeof UA.RisCatalogue?.loadManifest !== 'function') return;
    if (state.catalogueCount?.city !== city) {
      clearTimeout(state.catalogueCount?.timer);
      state.catalogueCount = { city };
      footer.hidden = false;
      footer.textContent = 'Anzahl der Ratsvorgänge wird geladen …';
    }
    const count = state.catalogueCount;
    if (count.pending) return;
    const active = () => current(ctx, state) && state.catalogueCount === count;
    const setLabel = label => { if (footer.textContent !== label) footer.textContent = label; };
    const expiredLabel = 'Der letzte geprüfte Ratsdatenstand ist abgelaufen.';
    const showCount = manifest => {
      if (!active()) return;
      const { stale, expired, nextCheckAt } = UA.RisCatalogue.snapshotStatus(manifest);
      if (expired) {
        setLabel(expiredLabel);
        return;
      }
      const total = manifest.recordCount ?? manifest.records.count;
      let label = `Ratsvorgänge im veröffentlichten Katalog: ${total.toLocaleString('de-DE')}`;
      if (manifest.schemaVersion === 2) label += ` (davon ${manifest.mappedRecordCount.toLocaleString('de-DE')} verortet)`;
      for (const breakdown of catalogueLevelCountLabels(manifest)) label += ` · ${breakdown}`;
      if (!manifest.coverage.complete) label += ' · Teilbestand';
      if (stale) label += ' · Veralteter Datenstand';
      if (manifest.refreshFailure) label += ' · Aktualisierung fehlgeschlagen';
      setLabel(label);
      const delay = Math.max(0, Math.min(nextCheckAt - Date.now(), 0x7fffffff));
      count.timer = setTimeout(() => showCount(manifest), delay);
    };

    // Use the same TTL and in-flight request cache as the map and research.
    count.pending = true;
    UA.RisCatalogue.loadManifest(city).then(manifest => {
      if (!active()) return;
      count.pending = false;
      if (count.manifest === manifest) return;
      clearTimeout(count.timer);
      count.manifest = manifest;
      showCount(manifest);
    }, error => {
      if (!active()) return;
      count.pending = false;
      clearTimeout(count.timer);
      count.manifest = null;
      if (error?.code === 'RIS_SNAPSHOT_UNAVAILABLE') setLabel('Für diese Stadt ist kein veröffentlichter Ratsdatenbestand verfügbar.');
      else if (error?.code === 'RIS_SNAPSHOT_EXPIRED') setLabel(expiredLabel);
      else setLabel('Der veröffentlichte Ratsdatenbestand konnte nicht geladen werden.');
    });
  }

  function refresh(ctx) {
    const state = controls.get(ctx);
    if (!state || ctx.map !== state.map) return;
    const city = cityOf(ctx);
    if (state.city !== city) {
      clearLayer(state);
      Object.assign(state, { city, data: null, pending: null, pendingKey: null, loadedKey: null,
        requestVersion: (state.requestVersion || 0) + 1 });
      state.body.hidden = state.legend.hidden = state.coverage.hidden = true;
      state.status.textContent = '';
      state.loadError = null;
    }
    refreshCatalogueCount(ctx, state);
    const active = sharedState(ctx);
    const wasEnabled = state.toggle.checked;
    state.toggle.checked = active.ris;
    state.body.hidden = !active.ris;
    const rect = rectOf(ctx.selectionBounds);
    state.filter.disabled = !rect;
    state.filter.parentElement.style.display = rect ? 'block' : 'none';
    if (!rect && ctx.risView.selectionOnly && !UA._hydrating) {
      ctx.risView.selectionOnly = false;
      sync(ctx);
    }
    state.filter.checked = !!ctx.risView.selectionOnly;
    if (!active.ris) {
      if (wasEnabled || state.layer) {
        if (state.data?.partitioned) {
          state.requestVersion = (state.requestVersion || 0) + 1;
          state.pending = state.pendingKey = null;
          state.loadedKey = null;
        }
        clearLayer(state);
        state.status.textContent = '';
        state.legend.hidden = state.coverage.hidden = true;
      }
      return;
    }
    const query = mapQuery(ctx, state);
    if (state.data?.partitioned && state.loadedKey === query.key
        && state.pending && state.pendingKey !== query.key && !state.pendingNavigation) {
      // The viewport already has the requested result. A late response for
      // the abandoned selection would replace its markers until a reload.
      state.pending = state.pendingKey = null;
    }
    if (!state.data && !state.loadError && state.pendingKey !== query.key) {
      state.status.textContent = 'Ratsvorgänge werden geladen …';
      loadSnapshot(ctx, state, false, false, query);
    }
    if (state.toggle.checked && state.data) {
      const { manifest } = state.data;
      const freshness = UA.RisCatalogue.snapshotStatus(manifest);
      if (freshness.expired) {
        clearLayer(state);
        state.data = null;
        state.legend.hidden = true;
        showCoverage(state, manifest, freshness);
        showError(state, { code: 'RIS_SNAPSHOT_EXPIRED' });
        return;
      }
      scheduleFreshnessCheck(ctx, state, freshness.nextCheckAt);
      if (state.data.partitioned && state.loadedKey !== query.key && state.pendingKey !== query.key) {
        loadSnapshot(ctx, state, false, false, query);
      }
      draw(ctx, state, state.filter.checked ? rect : null, freshness);
    }
  }

  function mapQuery(ctx, state) {
    let bounds = rectOf(state.map.getBounds());
    const selection = state.filter.checked && rectOf(ctx.selectionBounds);
    if (bounds && selection) {
      const clipped = [Math.max(bounds[0], selection[0]), Math.max(bounds[1], selection[1]),
        Math.min(bounds[2], selection[2]), Math.min(bounds[3], selection[3])];
      // An off-screen selection is still the useful query scope for record navigation.
      bounds = clipped[0] <= clipped[2] && clipped[1] <= clipped[3] ? clipped : selection;
    }
    const zoom = state.map.getZoom();
    return { bounds, zoom, key: `${bounds?.join(',')}|${zoom}` };
  }

  function loadSnapshot(ctx, state, revalidate = false, navigation = false, query = mapQuery(ctx, state)) {
    const { key, bounds, zoom } = query;
    if (state.pending && state.pendingKey === key && !revalidate) {
      state.pendingNavigation ||= navigation;
      return state.pending;
    }
    if (state.data && !revalidate && (!state.data.partitioned || state.loadedKey === key)) return Promise.resolve(state.data);
    const city = state.city;
    const version = state.requestVersion = (state.requestVersion || 0) + 1;
    const options = { bounds, zoom, maxFeatures: zoom >= 14 ? 1500 : 1000, ...(revalidate ? { revalidate: true } : {}) };
    const request = Promise.resolve().then(() => UA.RisCatalogue.loadMap(city, options)).then(indexSnapshot);
    state.pending = request;
    state.pendingKey = key;
    state.pendingNavigation = navigation;
    state.loadError = null;
    request.then(data => {
      if (!current(ctx, state) || state.pending !== request || state.requestVersion !== version) return;
      if (data.partitioned && !state.toggle.checked && !state.pendingNavigation) {
        state.pending = state.pendingKey = null;
        return;
      }
      if (state.data?.partitioned && data.partitioned && state.data.manifest.generation === data.manifest.generation) {
        // Reuse live feature objects and their handlers only within this generation.
        const previous = new Map(state.data.features.map(feature => [feature.properties.geometryId, feature]));
        if (state.focused) previous.set(state.focused.properties.geometryId, state.focused);
        data.features = data.features.map(feature => {
          const existing = previous.get(feature.properties.geometryId);
          return existing ? Object.assign(existing, feature) : feature;
        });
        Object.assign(state.data, data);
      } else {
        if (state.data) clearLayer(state);
        state.data = data;
      }
      state.pending = null;
      state.pendingKey = null;
      state.loadedKey = key;
      state.rendered = null;
      if (state.toggle.checked) refresh(ctx);
    }, error => {
      if (!current(ctx, state) || state.pending !== request || state.requestVersion !== version) return;
      state.pending = null;
      state.pendingKey = null;
      state.loadedKey = key;
      state.loadError = error;
      state.rendered = null;
      if (state.toggle.checked) {
        if (state.data) refresh(ctx);
        else showError(state, error);
      }
    });
    return request;
  }

  function snapshotMatches(manifest, snapshot) {
    return snapshot?.sha256 && snapshot.mapSha256 && snapshot.city === manifest.city
      && snapshot.sha256 === (manifest.generation || manifest.records?.sha256) && snapshot.mapSha256 === (manifest.generation || manifest.map?.sha256);
  }

  async function showLocation(ctx, ref, index, isActive) {
    refresh(ctx);
    const state = controls.get(ctx);
    if (!state || !current(ctx, state)) throw new Error('Die Karte ist gerade nicht verfügbar.');
    const revision = ctx.politicalContextCityRevision;
    const interactionEpoch = state.interactionEpoch || 0;
    const active = () => current(ctx, state) && ctx.politicalContextCityRevision === revision
      && (state.interactionEpoch || 0) === interactionEpoch && isActive();
    let data;
    try {
      data = await loadSnapshot(ctx, state, false, true).catch(error => {
        if (error?.code !== 'RIS_SNAPSHOT_EXPIRED') throw error;
        return null;
      });
      if (!active()) return null;
      if (!data || !snapshotMatches(data.manifest, ref.snapshot) || UA.RisCatalogue.snapshotStatus(data.manifest).stale) {
        data = await loadSnapshot(ctx, state, true, true);
      }
    } catch (error) {
      if (active()) throw error;
      return null;
    }
    if (!active()) return null;
    if (UA.RisCatalogue.snapshotStatus(data.manifest).expired) {
      throw new Error('Der Kartenbestand ist abgelaufen.');
    }
    if (data.partitioned && state.data?.manifest.generation === data.manifest.generation) data = state.data;
    if (state.data !== data || !snapshotMatches(data.manifest, ref.snapshot)) {
      throw new Error('Treffer und Karte stammen aus unterschiedlichen Datenständen. Bitte die Recherche erneut starten.');
    }
    let feature;
    if (data.partitioned) {
      const location = typeof index === 'string' ? ref.locations?.find(place => place.id === index) : ref.locations?.[index];
      const geometryId = location?.geometryId || (index && typeof index === 'object' ? index.geometryId : null);
      if (geometryId) {
        const exact = await UA.RisCatalogue.loadGeometry(state.city, geometryId, { snapshot: data.manifest });
        if (!active() || state.data !== data) return null;
        if (exact) {
          feature = data.features.find(item => item.properties.geometryId === geometryId) || { ...exact, bbox: exact.bounds || coordinateBounds(exact.geometry.coordinates) };
        }
      }
    } else {
      const geometryId = index && typeof index === 'object' ? index.geometryId : null;
      feature = data.features.find(feature => feature.properties.locations.some(location => {
        if (location.recordId !== ref.id) return false;
        if (!geometryId) return location.locationIndex === index;
        const identity = Number.isInteger(location.locationIndex)
          ? `legacy:location:${location.locationIndex}` : 'legacy:record';
        return geometryId === identity;
      }));
    }
    if (!feature) throw new Error('Für diesen Ort ist keine Kartenlage verfügbar.');
    const selection = state.filter.checked && rectOf(ctx.selectionBounds);
    if (selection && !featureHits(feature, selection)) {
      throw new Error('Der Ort liegt außerhalb der markierten Fläche.');
    }

    if (data.partitioned) state.focused = feature;
    sharedState(ctx).ris = true;
    state.toggle.checked = true;
    state.body.hidden = false;
    const [west, south, east, north] = feature.bbox;
    const bounds = window.L.latLngBounds([south, west], [north, east]);
    if (!state.map.getBounds().contains(bounds)) {
      state.map.fitBounds(bounds, { animate: false, maxZoom: Math.max(state.map.getZoom(), 16), padding: [18, 18] });
    }
    state.rendered = null;
    refresh(ctx);
    if (!active()) return null;
    const layer = state.featureLayers.get(feature);
    const target = layer?.getLayers?.().find(child => {
      const point = child.getLatLng();
      return !selection || insideRect([point.lng, point.lat], selection);
    }) || layer;
    const element = target?.getElement?.();
    if (!element) throw new Error('Für diesen Ort ist keine Kartenlage im Kartenausschnitt verfügbar.');
    target.openPopup();
    sync(ctx);
    return element;
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
      clearTimeout(old.catalogueCount?.timer);
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
    const onMove = () => { if (toggle.checked || ctx.ui?.risCatalogueCountEl) refresh(ctx); };
    const state = {
      root, toggle, body, filter, status, legend, mixedLegend, coverage, onMove,
      map: ctx.map, city: cityOf(ctx), featureLayers: new Map(),
    };
    controls.set(ctx, state);
    state.map.on('moveend', onMove);
    state.map.once('unload', () => {
      clearTimeout(state.expiryTimer);
      clearTimeout(state.catalogueCount?.timer);
      state.map.off('moveend', onMove);
      if (controls.get(ctx) === state) controls.delete(ctx);
    });
    toggle.addEventListener('change', () => {
      state.interactionEpoch = (state.interactionEpoch || 0) + 1;
      if (!current(ctx, state)) return;
      sharedState(ctx).ris = toggle.checked;
      state.loadError = null;
      if (!toggle.checked) {
        if (state.data?.partitioned) {
          state.requestVersion = (state.requestVersion || 0) + 1;
          state.pending = state.pendingKey = null;
          state.loadedKey = null;
        }
        clearLayer(state);
        status.textContent = '';
        legend.hidden = coverage.hidden = true;
      }
      refresh(ctx);
      sync(ctx);
    });
    filter.addEventListener('change', () => {
      sharedState(ctx);
      ctx.risView.selectionOnly = filter.checked;
      refresh(ctx);
      sync(ctx);
    });
    refresh(ctx);
    return root;
  }

  UA.RisLayer = { controlContent, refresh, showLocation, intersects };
})();
