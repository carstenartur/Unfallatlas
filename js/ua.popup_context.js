(() => {
  'use strict';

  /**
   * js/ua.popup_context.js
   *
   * Renders the "Kontextdaten"-Sektion eines Unfall-Popups aus den
   * angereicherten Per-Feature-Feldern (siehe scripts/enrich_geojson.js).
   *
   * Bewusste Trennung:
   *   - Detection lebt in js/ua.context_layers.js
   *     (`UA.contextLayers.detect` / `capabilitiesFromDetection`).
   *   - Rendering lebt hier — keine Detection, kein State, keine I/O.
   *   - Komposition (Basis-Popup + Kontext-Sektion) lebt in
   *     `UA.composeAccidentPopupHtml`, sodass künftige Renderer
   *     beliebigen Basis-HTML-Inhalt voranstellen können, ohne dass
   *     map_v2 angefasst werden muss.
   *
   * Public API:
   *   UA.popupContext.LABELS_DE                  zentrale Mapping-Tabelle
   *   UA.popupContext.formatNumber(n, digits)    DE-Zahlenformatierung
   *   UA.popupContext.render(props, capabilities) → string|null
   *   UA.composeAccidentPopupHtml(ctx, props, opts) → string|null
   */

  const UA = (window.UA = window.UA || {});

  // ---------------------------------------------------------------------------
  // Zentrale Mapping-Tabellen (DE)
  // ---------------------------------------------------------------------------

  // Werte spiegeln SLOPE_CLASS_THRESHOLDS / TRAFFIC_PROXY_THRESHOLDS aus
  // scripts/enrich_geojson.js wider. Wenn dort ein Wert hinzukommt, hier
  // ergänzen — der Renderer fällt sonst transparent auf den Roh-String
  // zurück (kein "undefined", kein Crash).
  const LABELS_DE = Object.freeze({
    slope_class: Object.freeze({
      flat:       'flach',
      gentle:     'leicht',
      moderate:   'mäßig',
      steep:      'steil',
      very_steep: 'sehr steil',
    }),
    traffic_proxy_class: Object.freeze({
      low:       'niedrig',
      medium:    'mittel',
      high:      'hoch',
      very_high: 'sehr hoch',
    }),
    // Konfidenz-Stufen aus DEM- und Traffic-Producern
    // (scripts/producers/dem_producer.js, traffic_producer.js).
    confidence: Object.freeze({
      high:   'hoch',
      medium: 'mittel',
      low:    'niedrig',
    }),
    // Klassifikation der Quellengüte für das Badge oben rechts.
    source_kind: Object.freeze({
      measured: 'gemessen',
      derived:  'abgeleitet',
      proxy:    'Proxy',
      unknown:  'unbekannt',
    }),
  });

  // OSM-Felder mit DE-Labels. Die Werte selbst (z. B. `residential`)
  // bleiben bewusst unübersetzt — wir spiegeln OSM-Tags 1:1 wider, um
  // Diskussionen mit dem OSM-Datenstand des Reviewers nicht zu
  // erschweren.
  // Hinweis: `road_slope_percent` wird bewusst NICHT hier geführt.
  // Es ist ein Topographie-Wert (Straßenneigung) und gehört laut Spec
  // („Topography: elevation, local slope, road slope, …") in die
  // Topographie-Sektion. Hier doppelt zu rendern wäre verwirrend.
  const OSM_FIELD_LABELS = Object.freeze({
    highway:            'Straßentyp',
    maxspeed:           'Tempolimit',
    lanes:              'Fahrstreifen',
    surface:            'Belag',
    cycleway:           'Radführung',
    osm_incline:        'OSM-Steigung',
  });

  // Die Reihenfolge entscheidet auch über die Reihenfolge im Popup.
  const OSM_FIELD_ORDER = Object.freeze([
    'highway', 'maxspeed', 'lanes', 'surface', 'cycleway', 'osm_incline',
  ]);

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------

  function escHtml(s) {
    if (typeof UA.escHtml === 'function') return UA.escHtml(s);
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function isPresent(v) {
    return v !== undefined && v !== null && v !== '';
  }

  function formatNumber(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const d = Number.isInteger(digits) ? digits : 1;
    return n.toFixed(d).replace('.', ',');
  }

  function labelFor(kind, value) {
    const map = LABELS_DE[kind];
    if (!map) return String(value);
    return map[String(value)] || String(value);
  }

  // Quellen-Klassifikation: anhand des Source-Strings entscheiden, ob die
  // Information gemessen, abgeleitet oder ein Proxy ist. Bewusst
  // konservativ — unbekannte Quellen ⇒ "unknown".
  function classifySource(source) {
    const s = String(source || '').toLowerCase();
    if (!s) return 'unknown';
    if (/srtm|aster|dem|lidar/.test(s)) return 'measured';
    if (/open[- ]?meteo/.test(s))       return 'derived';
    if (/osm|proxy|dtv|highway/.test(s)) return 'proxy';
    return 'unknown';
  }

  function badgeColor(kind) {
    switch (kind) {
      case 'measured': return { bg: '#e3f4ec', fg: '#1b6e3a', border: '#bfe2cf' };
      case 'derived':  return { bg: '#eaf1fb', fg: '#1f4f99', border: '#cad9f0' };
      case 'proxy':    return { bg: '#fcf2dc', fg: '#8a5a00', border: '#e9d6a3' };
      default:         return { bg: '#eee',    fg: '#555',    border: '#ddd'    };
    }
  }

  function renderBadge(kind, sourceTitle) {
    const c = badgeColor(kind);
    const label = labelFor('source_kind', kind);
    const title = sourceTitle ? ` title="${escHtml(sourceTitle)}"` : '';
    return (
      `<span data-ua-badge="${escHtml(kind)}" style="display:inline-block; padding:1px 6px; border-radius:8px;` +
      ` font-size:11px; line-height:1.4; background:${c.bg}; color:${c.fg}; border:1px solid ${c.border};` +
      ` margin-left:6px; vertical-align:1px;"${title}>${escHtml(label)}</span>`
    );
  }

  // ---------------------------------------------------------------------------
  // Sektions-Builder
  // ---------------------------------------------------------------------------

  // Jeder Sektions-Builder gibt entweder ein HTML-Fragment oder `null`
  // zurück. Leere Sektionen werden vom Renderer komplett unterdrückt —
  // nie eine Überschrift ohne Inhalt, nie ein "undefined".

  function rowHtml(label, value, opts) {
    if (!isPresent(value)) return '';
    const titleAttr = opts && opts.title ? ` title="${escHtml(opts.title)}"` : '';
    const dataAttr  = opts && opts.field ? ` data-ua-field="${escHtml(opts.field)}"` : '';
    return (
      `<div${dataAttr}${titleAttr} style="display:grid; grid-template-columns:118px 1fr; gap:6px; margin-top:2px;">` +
        `<div style="color:#666;">${escHtml(label)}</div>` +
        `<div>${escHtml(value)}</div>` +
      `</div>`
    );
  }

  function buildTopographySection(p, caps) {
    if (!caps.hasElevation && !caps.hasSlope) return null;

    const rows = [];

    if (caps.hasElevation && isPresent(p.elevation_m)) {
      rows.push(rowHtml('Höhe', `${formatNumber(p.elevation_m, 0)} m ü. NN`, { field: 'elevation_m' }));
    }
    if (caps.hasSlope) {
      const slopePct = isPresent(p.slope_percent) ? `${formatNumber(p.slope_percent, 1)} %` : null;
      const slopeCls = isPresent(p.slope_class)   ? labelFor('slope_class', p.slope_class) : null;
      const slopeText = slopePct && slopeCls ? `${slopePct} (${slopeCls})` : (slopePct || slopeCls);
      if (slopeText) rows.push(rowHtml('Hangneigung lokal', slopeText, { field: 'slope_percent' }));

      if (isPresent(p.road_slope_percent)) {
        rows.push(rowHtml('Straßenneigung', `${formatNumber(p.road_slope_percent, 1)} %`, { field: 'road_slope_percent' }));
      }
      if (isPresent(p.slope_confidence)) {
        rows.push(rowHtml('Konfidenz', labelFor('confidence', p.slope_confidence), { field: 'slope_confidence' }));
      }
    }

    if (!rows.length) return null;

    const sourceFull = isPresent(p.slope_source) ? String(p.slope_source) : '';
    const sourceKind = sourceFull ? classifySource(sourceFull) : null;
    const headerBadge = sourceKind ? renderBadge(sourceKind, `Quelle: ${sourceFull}`) : '';

    return (
      `<section data-ua-context-section="topography" style="margin-top:8px;">` +
        `<div style="font-weight:800;">Topographie${headerBadge}</div>` +
        rows.join('') +
      `</section>`
    );
  }

  function buildRoadContextSection(p, caps) {
    if (!caps.hasOsmContext) return null;

    const rows = OSM_FIELD_ORDER
      .map((key) => {
        if (!isPresent(p[key])) return '';
        let value = p[key];
        if (key === 'maxspeed') value = `${value} km/h`;
        return rowHtml(OSM_FIELD_LABELS[key], value, { field: key });
      })
      .filter(Boolean);

    if (!rows.length) return null;

    const sourceKind = isPresent(p.road_context_source)
      ? classifySource(p.road_context_source)
      : (isPresent(p.matched_way_id) ? 'proxy' : null);
    const headerBadge = sourceKind ? renderBadge(sourceKind, isPresent(p.road_context_source) ? `Quelle: ${p.road_context_source}` : 'OSM-Way-Match') : '';

    return (
      `<section data-ua-context-section="road" style="margin-top:8px;">` +
        `<div style="font-weight:800;">Straßenkontext${headerBadge}</div>` +
        rows.join('') +
      `</section>`
    );
  }

  function buildTrafficSection(p, caps) {
    if (!caps.hasTrafficProxy) return null;
    if (!isPresent(p.traffic_proxy_class)) return null;

    const headerBadge = renderBadge('proxy', 'Schätzung anhand OSM-Highway-Klasse (DTV-Proxy)');
    const row = rowHtml('Verkehrsklasse', labelFor('traffic_proxy_class', p.traffic_proxy_class), {
      field: 'traffic_proxy_class',
    });
    return (
      `<section data-ua-context-section="traffic" style="margin-top:8px;">` +
        `<div style="font-weight:800;">Verkehrsexposition${headerBadge}</div>` +
        row +
      `</section>`
    );
  }

  function buildTechnicalDetailsSection(p) {
    // Way-IDs sind technische Identifier — gehören in einen kleinen,
    // visuell zurückgenommenen Bereich, nicht prominent in eine
    // Sektions-Headline.
    if (!isPresent(p.matched_way_id)) return null;
    const id = String(p.matched_way_id);
    return (
      `<details data-ua-context-section="technical" style="margin-top:8px; color:#777; font-size:11px;">` +
        `<summary style="cursor:pointer; user-select:none;">Technische Details</summary>` +
        `<div style="margin-top:4px;" data-ua-field="matched_way_id">OSM-Way-ID: <code style="font-size:11px;">${escHtml(id)}</code></div>` +
      `</details>`
    );
  }

  // ---------------------------------------------------------------------------
  // Public renderer
  // ---------------------------------------------------------------------------

  /**
   * Rendert die Kontextdaten-Sektion oder `null`, wenn nichts anzuzeigen ist.
   * Toleriert fehlende Felder; ignoriert unbekannte Felder; greift nur auf
   * `props` zu — keine I/O, keine Detection.
   *
   * @param {object|null|undefined} props          Per-Feature-Properties.
   * @param {object|null|undefined} capabilities   Aus `UA.contextLayers.capabilitiesFromDetection`.
   * @returns {string|null}
   */
  function render(props, capabilities) {
    const p = props || {};
    const caps = capabilities || {};

    const sections = [
      buildTopographySection(p, caps),
      buildRoadContextSection(p, caps),
      buildTrafficSection(p, caps),
    ].filter(Boolean);

    if (!sections.length) return null;

    const technical = buildTechnicalDetailsSection(p) || '';
    const disclaimer =
      `<div data-ua-context-disclaimer style="margin-top:8px; color:#666; font-size:11px;">` +
        `<em>Kontextdaten beschreiben die Umgebung, nicht die Unfallursache.</em>` +
      `</div>`;

    return (
      `<div data-ua-context style="font:13px/1.35 system-ui; min-width:240px;">` +
        `<div style="font-weight:900; margin-bottom:2px;">Kontextdaten</div>` +
        sections.join('') +
        technical +
        disclaimer +
      `</div>`
    );
  }

  /**
   * Komponiert das vollständige Popup-HTML für einen Unfall-Marker.
   * Hängt die Kontext-Sektion (sofern vorhanden) **unter** den
   * vorhandenen Basis-Inhalt — der bestehende Inhalt wird nie
   * überschrieben. Wird kein Basis-Inhalt übergeben und gibt es auch
   * keine Kontextdaten, ist das Ergebnis `null` (Aufrufer soll dann
   * gar keinen Popup binden).
   *
   * Hydration (PR-C): Sind im Feature `matched_way_id` *und* in
   * `ctx.contextLayerState` ein bereits geladener `ways_<city>.json`-
   * Snapshot vorhanden, werden die Way-Attribute (highway, maxspeed,
   * lanes, surface, cycleway, osm_incline, road_slope_percent, …) per
   * `UA.contextLayers.resolveWay` aufgelöst und auf eine *Kopie* der
   * Properties gemerged. Per-Feature-Werte gewinnen — die Way-Attribute
   * füllen nur fehlende Felder. Ist der Cache noch nicht geladen
   * (Race), wird die Sektion einfach weggelassen (kein Warten).
   *
   * @param {object|null} ctx
   * @param {object|null} props
   * @param {{ baseHtml?: string|null }} [opts]
   * @returns {string|null}
   */
  function composeAccidentPopupHtml(ctx, props, opts) {
    const base = opts && typeof opts.baseHtml === 'string' ? opts.baseHtml : '';
    const caps = (ctx && ctx.contextCapabilities) || {};
    const renderProps = hydrateWayAttrs(ctx, props);
    const ctxHtml = render(renderProps, caps);
    if (!base && !ctxHtml) return null;
    if (!ctxHtml) return base || null;
    if (!base) return ctxHtml;
    const sep = `<div style="margin:8px 0; border-top:1px dashed #ddd;"></div>`;
    return `${base}${sep}${ctxHtml}`;
  }

  // Way-Felder, die wir aus dem Lazy-Cache in die Popup-Props mergen.
  // Bewusst eine White-List, damit z. B. interne Indizes oder künftige
  // Felder, die der Renderer (noch) nicht versteht, nicht stillschweigend
  // angeschleppt werden. road_context_source liefert das Quellen-Badge.
  const HYDRATABLE_WAY_FIELDS = Object.freeze([
    'highway', 'maxspeed', 'lanes', 'surface', 'cycleway',
    'osm_incline', 'road_slope_percent', 'road_context_source',
  ]);

  function hydrateWayAttrs(ctx, props) {
    const p = props || {};
    if (!p.matched_way_id) return p;
    const state = ctx && ctx.contextLayerState;
    if (!state) return p;
    const cl = UA.contextLayers;
    if (!cl) return p;
    // PR-E (full-network v3): prefer resolveWayAcrossTiles when
    // available — it consults the per-tile cache and (race-tolerantly)
    // triggers a single tile fetch for ways not yet loaded. Falls back
    // to the legacy resolveWay for v1/v2 states (state.ways is the
    // monolithic map).
    let resolved;
    try {
      if (typeof cl.resolveWayAcrossTiles === 'function') {
        resolved = cl.resolveWayAcrossTiles(state, p.matched_way_id);
      } else if (typeof cl.resolveWay === 'function' && state.ways) {
        resolved = cl.resolveWay(state, p.matched_way_id);
      } else {
        return p;
      }
    } catch (_) { return p; }
    if (!resolved || typeof resolved !== 'object') return p;
    const merged = { ...p };
    for (const k of HYDRATABLE_WAY_FIELDS) {
      if (resolved[k] === undefined || resolved[k] === null || resolved[k] === '') continue;
      if (merged[k] !== undefined && merged[k] !== null && merged[k] !== '') continue; // per-feature wins
      merged[k] = resolved[k];
    }
    return merged;
  }

  UA.popupContext = {
    LABELS_DE,
    OSM_FIELD_LABELS,
    OSM_FIELD_ORDER,
    HYDRATABLE_WAY_FIELDS,
    formatNumber,
    classifySource,
    render,
    hydrateWayAttrs,
  };
  UA.composeAccidentPopupHtml = composeAccidentPopupHtml;

  // Backward-compat: bestehende Aufrufer (z. B. ältere Tests, externe
  // Integrationen) finden weiter `UA.buildAccidentContextPopupHtml`.
  // Delegiert direkt auf den neuen Renderer.
  UA.buildAccidentContextPopupHtml = function buildAccidentContextPopupHtml(ctx, props) {
    const caps = (ctx && ctx.contextCapabilities) || {};
    return render(props, caps);
  };
})();
