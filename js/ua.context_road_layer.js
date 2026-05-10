(() => {
  'use strict';

  /**
   * js/ua.context_road_layer.js
   *
   * First-class map layers for the contextual data the enrichment
   * pipeline produces: "Straßensteigung" (slope) and
   * "Verkehrsbelastung" (traffic-volume proxy). Replaces the
   * "hidden metadata + chip filters only" UX with directly visible,
   * canvas-rendered road-segment overlays.
   *
   * The module is intentionally side-effect-free at load time. Map
   * integration (creating Leaflet `L.Control`s, hooking up toggles,
   * URL persistence) lives in `js/ua.map_v2.js` — this file only
   * exposes pure builders that take a hydrated `state` from
   * `UA.contextLayers.load()` and return Leaflet layers / DOM.
   *
   * Public API:
   *   UA.contextRoadLayer.SLOPE_CLASS_VALUES      ← ordered, low → high
   *   UA.contextRoadLayer.TRAFFIC_CLASS_VALUES    ← ordered, low → high
   *   UA.contextRoadLayer.SLOPE_LABELS_DE         ← class → human label
   *   UA.contextRoadLayer.TRAFFIC_LABELS_DE
   *   UA.contextRoadLayer.slopeClassColor(cls)    → "#rrggbb" | null
   *   UA.contextRoadLayer.trafficClassColor(cls)  → "#rrggbb" | null
   *   UA.contextRoadLayer.classifySlopeFromAttrs(wayAttrs) → class
   *   UA.contextRoadLayer.classifyTrafficFromAttrs(wayAttrs) → class
   *   UA.contextRoadLayer.decodeGeometry(flat)    → [[lat,lon], …]
   *   UA.contextRoadLayer.buildSlopeLayer(state, opts?) → L.LayerGroup
   *   UA.contextRoadLayer.buildTrafficLayer(state, opts?) → L.LayerGroup
   *   UA.contextRoadLayer.buildLegend(kind)       → HTMLElement
   */

  const UA = (window.UA = window.UA || {});

  // Ordered low → high. Mirrors SLOPE_CLASS_THRESHOLDS in
  // scripts/enrich_geojson.js and SLOPE_CLASS_VALUES in js/ua.ui.js so
  // chip-filter ↔ overlay legend stay in lock-step.
  const SLOPE_CLASS_VALUES   = ['flat', 'gentle', 'moderate', 'steep', 'very_steep'];
  const TRAFFIC_CLASS_VALUES = ['low', 'medium', 'high', 'very_high'];

  const SLOPE_LABELS_DE = {
    flat:       'flach (≤ 2 %)',
    gentle:     'leicht (≤ 4 %)',
    moderate:   'mäßig (≤ 6 %)',
    steep:      'steil (≤ 10 %)',
    very_steep: 'sehr steil (> 10 %)',
  };
  // Neutral colour + label for ways present in the v3 context network
  // but without a slope signal (no DEM coverage / SRTM gap / way too
  // short). Rendered when the caller opts in via `opts.showUnclassified`
  // so the user can see that the road is in the dataset, just without
  // a calculated slope.
  const SLOPE_NO_SIGNAL_COLOR = '#bdbdbd';
  const SLOPE_NO_SIGNAL_LABEL_DE = 'kein Steigungssignal';
  const TRAFFIC_LABELS_DE = {
    low:       'niedrig (≤ 1 000 DTV)',
    medium:    'mittel (≤ 5 000 DTV)',
    high:      'hoch (≤ 15 000 DTV)',
    very_high: 'sehr hoch (> 15 000 DTV)',
  };

  // Colour ramps. Slope = ColorBrewer YlOrRd-5; Traffic = YlGnBu-4. Both
  // are perceptually ordered and colour-blind safe.
  const SLOPE_COLORS = {
    flat:       '#ffffb2',
    gentle:     '#fecc5c',
    moderate:   '#fd8d3c',
    steep:      '#f03b20',
    very_steep: '#bd0026',
  };
  const TRAFFIC_COLORS = {
    low:       '#ffffcc',
    medium:    '#a1dab4',
    high:      '#41b6c4',
    very_high: '#225ea8',
  };

  // Mirror of SLOPE_CLASS_THRESHOLDS / TRAFFIC_PROXY_THRESHOLDS in
  // scripts/enrich_geojson.js. Only used as a fallback when a way
  // doesn't carry an explicit class but has a numeric proxy.
  function classifySlope(percent) {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
    const v = Math.abs(percent);
    if (v <= 2)  return 'flat';
    if (v <= 4)  return 'gentle';
    if (v <= 6)  return 'moderate';
    if (v <= 10) return 'steep';
    return 'very_steep';
  }
  // DTV proxy table for ways that only carry a `highway` tag (mirrors
  // scripts/producers/traffic_producer.js). Highway types not listed
  // here are treated as "no signal" and the layer skips them — by
  // design, since their volume is genuinely unknown and an arbitrary
  // "low" default would mislead the visual.
  const HIGHWAY_DTV_PROXY = {
    motorway: 50000, motorway_link: 20000,
    trunk:    30000, trunk_link:    15000,
    primary:  15000, primary_link:   8000,
    secondary: 8000, secondary_link: 5000,
    tertiary:  3000, tertiary_link:  2000,
    unclassified: 1000,
    residential:   500,
    living_street: 200,
    service:       100,
  };
  function classifyTrafficProxy(dtv) {
    if (typeof dtv !== 'number' || !Number.isFinite(dtv)) return null;
    if (dtv <= 1000)  return 'low';
    if (dtv <= 5000)  return 'medium';
    if (dtv <= 15000) return 'high';
    return 'very_high';
  }

  function slopeClassColor(cls)   { return SLOPE_COLORS[cls] || null; }
  function trafficClassColor(cls) { return TRAFFIC_COLORS[cls] || null; }

  /**
   * Resolve a slope class from a per-way attrs row. Prefers an
   * explicit `road_slope_percent` (already int-coded? no — slope
   * fields are numeric, see scripts/enrich_geojson.js); falls back to
   * `osm_incline` when present. Returns null when no slope signal.
   */
  function classifySlopeFromAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object') return null;
    const rsp = attrs.road_slope_percent;
    const c = classifySlope(rsp);
    if (c) return c;
    // osm_incline is a string like "5%", "up", "down"; only the numeric
    // form is useful for classification.
    const inc = attrs.osm_incline;
    if (typeof inc === 'string') {
      const m = inc.match(/-?\d+(\.\d+)?/);
      if (m) return classifySlope(parseFloat(m[0]));
    }
    return null;
  }

  /**
   * Resolve a traffic class from a per-way attrs row. Prefers an
   * explicit `traffic_volume_value` (DTV vehicles/day); falls back to
   * the highway-tag DTV proxy. Returns null when no signal.
   */
  function classifyTrafficFromAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object') return null;
    if (Number.isFinite(attrs.traffic_volume_value)) {
      return classifyTrafficProxy(attrs.traffic_volume_value);
    }
    if (typeof attrs.highway === 'string') {
      const dtv = HIGHWAY_DTV_PROXY[attrs.highway];
      if (dtv != null) return classifyTrafficProxy(dtv);
    }
    return null;
  }

  /**
   * Decode the flat `[lat, lon, lat, lon, ...]` polyline encoding the
   * enrichment pipeline ships in `ways_<city>.json`. Returns a
   * Leaflet-friendly `[[lat, lon], ...]` array (or null on bad input).
   */
  function decodeGeometry(flat) {
    if (!Array.isArray(flat) || flat.length < 4 || (flat.length % 2) !== 0) return null;
    const out = new Array(flat.length / 2);
    for (let i = 0; i < flat.length; i += 2) {
      const lat = +flat[i], lon = +flat[i + 1];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      out[i / 2] = [lat, lon];
    }
    return out;
  }

  /** Common style options for canvas-rendered overlay polylines. */
  function lineStyle(color, opts) {
    const o = opts || {};
    return {
      color,
      weight:    Number.isFinite(o.weight) ? o.weight : 4,
      opacity:   Number.isFinite(o.opacity) ? o.opacity : 0.85,
      lineCap:   'round',
      lineJoin:  'round',
      interactive: false,
      renderer:  o.renderer || undefined,
    };
  }

  /**
   * Build a Leaflet LayerGroup of polylines coloured by class. Pure —
   * no side effects on the map until the caller adds it.
   *
   * @param {object}  state        result of UA.contextLayers.load()
   * @param {string}  kind         "slope" | "traffic"
   * @param {object}  [opts]
   * @param {function} [opts.classifier] (resolvedAttrs) → class | null
   * @param {function} [opts.colorFor]  (class) → "#rrggbb" | null
   * @param {object}  [opts.renderer]   shared L.canvas() renderer
   * @param {number}  [opts.weight]     line weight (default 4)
   * @param {number}  [opts.opacity]    line opacity (default 0.85)
   * @returns {L.LayerGroup}
   */
  function buildLayer(state, kind, opts) {
    const o = opts || {};
    if (!window.L || typeof window.L.layerGroup !== 'function') {
      throw new Error('UA.contextRoadLayer.buildLayer: Leaflet is not available');
    }
    const group = window.L.layerGroup();
    if (!state || !state.geometries || !state.ways) return group;

    const classifier = o.classifier
      || (kind === 'slope' ? classifySlopeFromAttrs : classifyTrafficFromAttrs);
    const colorFor   = o.colorFor
      || (kind === 'slope' ? slopeClassColor : trafficClassColor);

    const dicts = (state.dicts) || {};
    // Light per-call resolver — avoids importing UA.contextLayers and
    // keeps this module standalone for testing.
    const resolveAttrs = (wayId) => {
      const w = state.ways[wayId];
      if (!w) return null;
      const out = {};
      for (const k of Object.keys(w)) {
        const dict = dicts[k];
        const v = w[k];
        out[k] = (Array.isArray(dict) && Number.isInteger(v) && v >= 0 && v < dict.length)
          ? dict[v] : v;
      }
      return out;
    };

    const renderer = o.renderer
      || (typeof window.L.canvas === 'function' ? window.L.canvas({ padding: 0.2 }) : undefined);

    // Optional viewport filter (PR-E full-network overlay). When the
    // caller supplies `bounds` (typically `map.getBounds()`), we only
    // emit polylines whose bounding box intersects that rectangle —
    // crucial for v3 tile loads where `state.geometries` may carry
    // way data well outside the user's current view. Falsy bounds
    // disables the filter (legacy v1/v2 behaviour).
    const bounds = o.bounds || null;
    let bSouth, bNorth, bWest, bEast;
    if (bounds) {
      if (typeof bounds.getSouth === 'function') {
        bSouth = bounds.getSouth(); bNorth = bounds.getNorth();
        bWest  = bounds.getWest();  bEast  = bounds.getEast();
      } else {
        bSouth = bounds.south; bNorth = bounds.north;
        bWest  = bounds.west;  bEast  = bounds.east;
      }
    }
    const intersectsBounds = (latlngs) => {
      if (!bounds || !Number.isFinite(bSouth)) return true;
      let minLat = +Infinity, maxLat = -Infinity, minLon = +Infinity, maxLon = -Infinity;
      for (const ll of latlngs) {
        const lat = ll[0], lon = ll[1];
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      }
      // AABB intersection test (lat is inverted on slippy but Leaflet
      // bounds are still south≤north, west≤east so the standard test
      // works directly).
      return !(maxLat < bSouth || minLat > bNorth || maxLon < bWest || minLon > bEast);
    };

    for (const wayId of Object.keys(state.geometries)) {
      const flat = state.geometries[wayId];
      const latlngs = decodeGeometry(flat);
      if (!latlngs) continue;
      if (!intersectsBounds(latlngs)) continue;
      const attrs = resolveAttrs(wayId);
      const cls   = classifier(attrs);
      let color, featureClass;
      if (cls) {
        color = colorFor(cls);
        featureClass = cls;
      } else if (o.showUnclassified && kind === 'slope') {
        // Render the road in neutral grey so users see that the way is
        // covered by the v3 context network even when no slope signal
        // could be calculated. Mirrors the "kein Steigungssignal" row
        // appended to buildLegend('slope').
        color = SLOPE_NO_SIGNAL_COLOR;
        featureClass = 'no_signal';
      } else {
        continue;
      }
      if (!color) continue;
      try {
        const line = window.L.polyline(latlngs, lineStyle(color, { renderer, weight: o.weight, opacity: o.opacity }));
        // Tiny payload so a future hover/tooltip can read the class
        // without re-resolving the way table.
        line.feature = {
          type: 'Feature',
          properties: { way_id: String(wayId), class: featureClass, kind },
          geometry: null,
        };
        group.addLayer(line);
      } catch (_) { /* malformed line — skip */ }
    }
    return group;
  }

  function buildSlopeLayer(state, opts) {
    // Slope overlay defaults to showing unclassified ways in neutral
    // grey so the v3 full-network coverage is visible at a glance —
    // colour = slope calculated, grey = road covered but no signal.
    const o = opts || {};
    const merged = (o.showUnclassified === undefined)
      ? Object.assign({}, o, { showUnclassified: true })
      : o;
    return buildLayer(state, 'slope', merged);
  }
  function buildTrafficLayer(state, opts) { return buildLayer(state, 'traffic', opts); }

  /**
   * Build a small DOM legend block (color swatch + label per class)
   * for use as the body of a Leaflet `L.control` or inside the report
   * exports. Returns a real `HTMLDivElement`; safe to insert anywhere.
   */
  function buildLegend(kind) {
    const div = document.createElement('div');
    div.className = 'context-road-legend context-road-legend--' + kind;
    const title = document.createElement('div');
    title.className = 'context-road-legend__title';
    title.textContent = (kind === 'slope') ? 'Straßensteigung' : 'Verkehrsbelastung';
    div.appendChild(title);

    const values = (kind === 'slope') ? SLOPE_CLASS_VALUES : TRAFFIC_CLASS_VALUES;
    const labels = (kind === 'slope') ? SLOPE_LABELS_DE    : TRAFFIC_LABELS_DE;
    const colorFn = (kind === 'slope') ? slopeClassColor   : trafficClassColor;
    for (const cls of values) {
      const row = document.createElement('div');
      row.className = 'context-road-legend__row';
      const sw = document.createElement('span');
      sw.className = 'context-road-legend__swatch';
      sw.style.background = colorFn(cls) || 'transparent';
      const lbl = document.createElement('span');
      lbl.className = 'context-road-legend__label';
      lbl.textContent = labels[cls] || cls;
      row.appendChild(sw);
      row.appendChild(lbl);
      div.appendChild(row);
    }
    // For the slope layer, append an explicit "no signal" row so users
    // can tell coloured = slope calculated apart from neutral/grey =
    // road is in the v3 context network but no slope could be derived
    // (DEM gap, way too short, etc.). Uses a distinct DOM class so
    // tests / styling can target it independently of the value rows.
    if (kind === 'slope') {
      const row = document.createElement('div');
      row.className = 'context-road-legend__nosignal';
      const sw = document.createElement('span');
      sw.className = 'context-road-legend__swatch';
      sw.style.background = SLOPE_NO_SIGNAL_COLOR;
      const lbl = document.createElement('span');
      lbl.className = 'context-road-legend__label';
      lbl.textContent = SLOPE_NO_SIGNAL_LABEL_DE;
      row.appendChild(sw);
      row.appendChild(lbl);
      div.appendChild(row);
    }
    return div;
  }

  UA.contextRoadLayer = {
    SLOPE_CLASS_VALUES,
    TRAFFIC_CLASS_VALUES,
    SLOPE_LABELS_DE,
    TRAFFIC_LABELS_DE,
    SLOPE_COLORS,
    TRAFFIC_COLORS,
    SLOPE_NO_SIGNAL_COLOR,
    SLOPE_NO_SIGNAL_LABEL_DE,
    HIGHWAY_DTV_PROXY,
    classifySlope,
    classifyTrafficProxy,
    slopeClassColor,
    trafficClassColor,
    classifySlopeFromAttrs,
    classifyTrafficFromAttrs,
    decodeGeometry,
    buildLayer,
    buildSlopeLayer,
    buildTrafficLayer,
    buildLegend,
  };
})();
