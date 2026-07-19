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
  // Amtliche Unfall-Basisdaten
  // ---------------------------------------------------------------------------

  const ACCIDENT_SEVERITY_LABELS = Object.freeze({
    '1': 'Unfall mit Getöteten',
    '2': 'Unfall mit Schwerverletzten',
    '3': 'Unfall mit Leichtverletzten',
  });
  const ACCIDENT_WEEKDAY_LABELS = Object.freeze({
    '1': 'Sonntag', '2': 'Montag', '3': 'Dienstag', '4': 'Mittwoch',
    '5': 'Donnerstag', '6': 'Freitag', '7': 'Samstag',
  });
  const ACCIDENT_ROAD_CONDITION_LABELS = Object.freeze({
    '0': 'trocken',
    '1': 'nass, feucht oder schlüpfrig',
    '2': 'winterglatt',
  });
  const ACCIDENT_MONTH_LABELS = Object.freeze([
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ]);
  const ACCIDENT_PARTICIPANTS = Object.freeze([
    Object.freeze({ keys: ['istrad', 'IstRad', 'ISTRAD'], label: 'Radverkehr' }),
    Object.freeze({ keys: ['istfuss', 'IstFuss', 'ISTFUSS'], label: 'Fußverkehr' }),
    Object.freeze({ keys: ['istpkw', 'IstPKW', 'ISTPKW'], label: 'PKW' }),
    Object.freeze({ keys: ['istkrad', 'IstKrad', 'ISTKRAD'], label: 'Motorrad' }),
    Object.freeze({ keys: ['istgkfz', 'IstGkfz', 'ISTGKFZ'], label: 'LKW/Güterverkehr' }),
    Object.freeze({ keys: ['istsonstig', 'IstSonstig', 'ISTSONSTIG'], label: 'Sonstige Beteiligte' }),
  ]);

  function firstPresentValue(props, keys) {
    const p = props || {};
    for (const key of keys) {
      if (isPresent(p[key])) return p[key];
    }
    return null;
  }

  function codedLabel(value, labels) {
    if (!isPresent(value)) return null;
    const code = String(value);
    return labels[code] || `unbekannt (Code ${code})`;
  }

  function accidentDateLabel(props) {
    const year = firstPresentValue(props, ['year', 'ujahr', 'UJAHR']);
    const rawMonth = firstPresentValue(props, ['umonat', 'UMONAT', 'month']);
    const month = Number(rawMonth);
    const monthLabel = Number.isInteger(month) && month >= 1 && month <= 12
      ? ACCIDENT_MONTH_LABELS[month - 1]
      : null;
    if (monthLabel && isPresent(year)) return `${monthLabel} ${year}`;
    if (isPresent(year)) return String(year);
    return monthLabel;
  }

  function accidentTimeLabel(props) {
    const raw = firstPresentValue(props, ['ustunde', 'USTUNDE', 'hour']);
    const hour = Number(raw);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    return `${String(hour).padStart(2, '0')}:00 Uhr`;
  }

  function accidentParticipantLabel(props) {
    const labels = ACCIDENT_PARTICIPANTS
      .filter(item => item.keys.some(key => String((props || {})[key]) === '1'))
      .map(item => item.label);
    return labels.length ? labels.join(', ') : null;
  }

  function accidentCoordinateLabel(options) {
    const lat = Number(options && options.lat);
    const lon = Number(options && options.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }

  /**
   * Rendert den kompakten, amtlichen Basisblock eines Unfallmarkers.
   * Der Block ist unabhängig von optionalen Kontext-Capabilities und wird
   * deshalb für jeden gültigen Unfallpunkt erzeugt. Abgeleitete Kontextwerte
   * werden ausschließlich durch `render()` darunter ergänzt.
   *
   * @param {object|null} ctx
   * @param {object|null} props
   * @param {{lat?: number, lon?: number}} [options]
   * @returns {string}
   */
  function renderAccidentBasePopupHtml(ctx, props, options) {
    const p = props || {};
    const severity = firstPresentValue(p, ['ukategorie', 'UKATEGORIE', 'severity']);
    const severityLabel = codedLabel(severity, ACCIDENT_SEVERITY_LABELS);
    const weekday = firstPresentValue(p, ['uwochentag', 'UWOCHENTAG', 'weekday']);
    const roadCondition = firstPresentValue(p, ['strzustand', 'STRZUSTAND', 'roadCondition']);
    const accidentId = firstPresentValue(p, [
      'id', 'ID', 'objectid', 'OBJECTID', 'uid', 'UID',
      'unfall_id', 'UNFALL_ID', 'uidentstlae', 'UIDENTSTLAE',
    ]);
    const source = firstPresentValue(
      (ctx && ctx.geojsonProps) || {},
      ['source', 'quelle', 'dataSource']
    ) || (ctx && ctx.DATA_URL) || null;
    const city = ctx && ctx.CITY_RAW ? String(ctx.CITY_RAW) : null;

    const rows = [
      rowHtml('Zeitraum', accidentDateLabel(p), { field: 'accident-date' }),
      rowHtml('Uhrzeit', accidentTimeLabel(p), { field: 'accident-time' }),
      rowHtml('Wochentag', codedLabel(weekday, ACCIDENT_WEEKDAY_LABELS), { field: 'accident-weekday' }),
      rowHtml('Beteiligte', accidentParticipantLabel(p), { field: 'accident-participants' }),
      rowHtml('Fahrbahn', codedLabel(roadCondition, ACCIDENT_ROAD_CONDITION_LABELS), { field: 'accident-road-condition' }),
      rowHtml('Koordinate', accidentCoordinateLabel(options), { field: 'accident-coordinate' }),
      rowHtml('Datensatz-ID', accidentId, { field: 'accident-id' }),
      rowHtml('Stadt', city, { field: 'accident-city' }),
      rowHtml('Quelle', source, { field: 'accident-source' }),
    ].filter(Boolean);

    return (
      `<section data-ua-accident-base role="group" aria-label="Amtliche Unfalldaten"` +
        ` style="font:13px/1.35 system-ui; min-width:240px;">` +
        `<div style="font-weight:900; margin-bottom:4px;">Amtliche Unfalldaten</div>` +
        (severityLabel
          ? `<div data-ua-field="accident-severity" style="font-weight:800; margin-bottom:4px;">${escHtml(severityLabel)}</div>`
          : '') +
        rows.join('') +
        `<div style="margin-top:7px; color:#666; font-size:11px;">` +
          `Kontext-Hinweise beschreiben das Umfeld und belegen keine Unfallursache.` +
        `</div>` +
      `</section>`
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
      // formatNumber returns null for non-finite values (NaN/Infinity/garbage
      // strings) — only render the row when we can actually produce a number,
      // otherwise we'd emit "null m ü. NN".
      const elevText = formatNumber(p.elevation_m, 0);
      if (elevText !== null) {
        rows.push(rowHtml('Höhe', `${elevText} m ü. NN`, { field: 'elevation_m' }));
      }
    }
    if (caps.hasSlope) {
      // Defensive: isPresent only guards null/undefined/'', but the value can
      // still be NaN/Infinity for hand-edited datasets. formatNumber returns
      // null in that case; treat it as "no numeric value" so we don't render
      // "null %" — fall back to the class label alone if available.
      const slopePctNum = isPresent(p.slope_percent) ? formatNumber(p.slope_percent, 1) : null;
      const slopePct = slopePctNum !== null ? `${slopePctNum} %` : null;
      const slopeCls = isPresent(p.slope_class)   ? labelFor('slope_class', p.slope_class) : null;
      const slopeText = slopePct && slopeCls ? `${slopePct} (${slopeCls})` : (slopePct || slopeCls);
      if (slopeText) rows.push(rowHtml('Hangneigung lokal', slopeText, { field: 'slope_percent' }));

      const roadPctNum = isPresent(p.road_slope_percent) ? formatNumber(p.road_slope_percent, 1) : null;
      const roadCls = isPresent(p.road_slope_class)
        ? labelFor('slope_class', p.road_slope_class) : null;
      if (roadPctNum !== null) {
        const pctText = `${roadPctNum} %`;
        const roadText = roadCls ? `${pctText} (${roadCls})` : pctText;
        rows.push(rowHtml('Straßenneigung', roadText, { field: 'road_slope_percent' }));
      } else if (roadCls) {
        // Class without a numeric percent (rare but possible for hand-
        // edited datasets). Surface it so the renderer's colour can
        // still be explained from the popup.
        rows.push(rowHtml('Straßenneigung', roadCls, { field: 'road_slope_class' }));
      }
      // Per-way confidence (road_slope_confidence) wins over per-feature
      // (slope_confidence) when both are present — it describes the
      // signal that drives the slope-overlay colouring policy. Falls
      // back to the per-feature value for backward compatibility with
      // datasets that only carry slope_confidence.
      const confValue = isPresent(p.road_slope_confidence)
        ? p.road_slope_confidence
        : (isPresent(p.slope_confidence) ? p.slope_confidence : null);
      if (confValue) {
        rows.push(rowHtml('Konfidenz', labelFor('confidence', confValue), {
          field: isPresent(p.road_slope_confidence) ? 'road_slope_confidence' : 'slope_confidence',
        }));
      }
      if (isPresent(p.road_slope_method)) {
        rows.push(rowHtml('Methode', String(p.road_slope_method), { field: 'road_slope_method' }));
      }
      if (Number.isFinite(Number(p.road_slope_sample_count))) {
        rows.push(rowHtml('Stichproben', String(p.road_slope_sample_count), { field: 'road_slope_sample_count' }));
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
    'osm_incline', 'road_slope_percent', 'road_slope_class',
    'road_slope_confidence', 'road_slope_method', 'road_slope_sample_count',
    'road_context_source',
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
    renderAccidentBasePopupHtml,
    render,
    hydrateWayAttrs,
  };
  UA.renderAccidentBasePopupHtml = renderAccidentBasePopupHtml;
  UA.composeAccidentPopupHtml = composeAccidentPopupHtml;

  // Backward-compat: bestehende Aufrufer (z. B. ältere Tests, externe
  // Integrationen) finden weiter `UA.buildAccidentContextPopupHtml`.
  // Delegiert direkt auf den neuen Renderer.
  UA.buildAccidentContextPopupHtml = function buildAccidentContextPopupHtml(ctx, props) {
    const caps = (ctx && ctx.contextCapabilities) || {};
    return render(props, caps);
  };
})();
