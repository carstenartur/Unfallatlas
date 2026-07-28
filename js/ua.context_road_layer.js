(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  const SLOPE_CLASS_VALUES = ['flat', 'gentle', 'moderate', 'steep', 'very_steep'];
  const TRAFFIC_CLASS_VALUES = ['low', 'medium', 'high', 'very_high'];

  const SLOPE_LABELS_DE = {
    flat: 'flach (≤ 2 %)',
    gentle: 'leicht (≤ 4 %)',
    moderate: 'mäßig (≤ 6 %)',
    steep: 'steil (≤ 10 %)',
    very_steep: 'sehr steil (> 10 %)',
  };
  const TRAFFIC_LABELS_DE = {
    low: 'niedriger OSM-Straßenklassenproxy',
    medium: 'mittlerer OSM-Straßenklassenproxy',
    high: 'hoher OSM-Straßenklassenproxy',
    very_high: 'sehr hoher OSM-Straßenklassenproxy',
  };

  const SLOPE_NO_SIGNAL_COLOR = '#bdbdbd';
  const SLOPE_NO_SIGNAL_LABEL_DE = 'kein Steigungssignal';
  const SLOPE_LOW_CONFIDENCE_COLOR = '#9aa9b8';
  const SLOPE_LOW_CONFIDENCE_LABEL_DE = 'geringe Konfidenz';

  const SLOPE_COLORS = {
    flat: '#ffffb2', gentle: '#fecc5c', moderate: '#fd8d3c',
    steep: '#f03b20', very_steep: '#bd0026',
  };
  const TRAFFIC_COLORS = {
    low: '#2a9d8f', medium: '#277da1', high: '#3a5a98', very_high: '#1b1b5e',
  };

  const HIGHWAY_TRAFFIC_PROXY_CLASS = Object.freeze({
    motorway: 'very_high', motorway_link: 'very_high',
    trunk: 'very_high', trunk_link: 'very_high',
    primary: 'high', primary_link: 'high',
    secondary: 'high', secondary_link: 'high',
    tertiary: 'medium', tertiary_link: 'medium', unclassified: 'medium',
    residential: 'low', living_street: 'low', service: 'low',
    pedestrian: 'low', track: 'low',
  });

  function classifySlope(percent) {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
    const value = Math.abs(percent);
    if (value <= 2) return 'flat';
    if (value <= 4) return 'gentle';
    if (value <= 6) return 'moderate';
    if (value <= 10) return 'steep';
    return 'very_steep';
  }

  /**
   * Classify a licensed measured/modelled numeric value for visual ordering.
   * This helper is never used to invent a value for the OSM fallback.
   */
  function classifyTrafficProxy(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value <= 1000) return 'low';
    if (value <= 5000) return 'medium';
    if (value <= 15000) return 'high';
    return 'very_high';
  }

  function slopeClassColor(cls) { return SLOPE_COLORS[cls] || null; }
  function trafficClassColor(cls) { return TRAFFIC_COLORS[cls] || null; }

  function classifySlopeFromAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object') return null;
    const explicit = attrs.road_slope_class;
    if (typeof explicit === 'string' && SLOPE_CLASS_VALUES.includes(explicit)) return explicit;
    const calculated = classifySlope(attrs.road_slope_percent);
    if (calculated) return calculated;
    if (typeof attrs.osm_incline === 'string') {
      const match = attrs.osm_incline.match(/-?\d+(\.\d+)?/);
      if (match) return classifySlope(parseFloat(match[0]));
    }
    return null;
  }

  function classifyTrafficFromAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object') return null;
    const explicit = attrs.traffic_proxy_class;
    if (typeof explicit === 'string' && TRAFFIC_CLASS_VALUES.includes(explicit)) return explicit;

    const type = String(attrs.traffic_measurement_type || '').toLowerCase();
    if (type === 'proxy') {
      // A proxy carrying a numeric value violates the typed contract. Never
      // display that value as though it were measured or modelled.
      return null;
    }
    if (Number.isFinite(attrs.traffic_volume_value)) {
      return classifyTrafficProxy(attrs.traffic_volume_value);
    }
    if (typeof attrs.highway === 'string') {
      return HIGHWAY_TRAFFIC_PROXY_CLASS[attrs.highway] || null;
    }
    return null;
  }

  function decodeGeometry(flat) {
    if (!Array.isArray(flat) || flat.length < 4 || flat.length % 2 !== 0) return null;
    const result = new Array(flat.length / 2);
    for (let index = 0; index < flat.length; index += 2) {
      const lat = +flat[index];
      const lon = +flat[index + 1];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      result[index / 2] = [lat, lon];
    }
    return result;
  }

  function lineStyle(color, options) {
    const opts = options || {};
    return {
      color,
      weight: Number.isFinite(opts.weight) ? opts.weight : 4,
      opacity: Number.isFinite(opts.opacity) ? opts.opacity : 0.85,
      dashArray: typeof opts.dashArray === 'string' && opts.dashArray ? opts.dashArray : null,
      lineCap: 'round', lineJoin: 'round', interactive: false,
      renderer: opts.renderer || undefined,
    };
  }

  function buildLayer(state, kind, options) {
    const opts = options || {};
    if (!window.L || typeof window.L.layerGroup !== 'function') {
      throw new Error('UA.contextRoadLayer.buildLayer: Leaflet is not available');
    }
    const group = window.L.layerGroup();
    if (!state || !state.geometries || !state.ways) return group;

    const classifier = opts.classifier ||
      (kind === 'slope' ? classifySlopeFromAttrs : classifyTrafficFromAttrs);
    const colorFor = opts.colorFor ||
      (kind === 'slope' ? slopeClassColor : trafficClassColor);
    const dicts = state.dicts || {};
    const renderer = opts.renderer ||
      (typeof window.L.canvas === 'function' ? window.L.canvas({ padding: 0.2 }) : undefined);

    const resolveAttrs = wayId => {
      const row = state.ways[wayId];
      if (!row) return null;
      const resolved = {};
      for (const key of Object.keys(row)) {
        const value = row[key];
        const dict = dicts[key];
        // Slope/traffic classes are intentionally never dictionary-decoded:
        // explicit string values are the authoritative enrichment decision.
        if ((key === 'road_slope_class' || key === 'traffic_proxy_class') && typeof value === 'string') {
          resolved[key] = value;
        } else {
          resolved[key] = Array.isArray(dict) && Number.isInteger(value) && value >= 0 && value < dict.length
            ? dict[value] : value;
        }
      }
      return resolved;
    };

    const bounds = opts.bounds || null;
    let south, north, west, east;
    if (bounds) {
      if (typeof bounds.getSouth === 'function') {
        south = bounds.getSouth(); north = bounds.getNorth();
        west = bounds.getWest(); east = bounds.getEast();
      } else {
        south = bounds.south; north = bounds.north;
        west = bounds.west; east = bounds.east;
      }
    }
    const intersectsBounds = latlngs => {
      if (!bounds || !Number.isFinite(south)) return true;
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (const [lat, lon] of latlngs) {
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      }
      return !(maxLat < south || minLat > north || maxLon < west || minLon > east);
    };

    for (const wayId of Object.keys(state.geometries)) {
      const latlngs = decodeGeometry(state.geometries[wayId]);
      if (!latlngs || !intersectsBounds(latlngs)) continue;
      const attrs = resolveAttrs(wayId);
      const cls = classifier(attrs);
      const confidence = kind === 'slope' && attrs && typeof attrs.road_slope_confidence === 'string'
        ? attrs.road_slope_confidence : null;
      const lowConfidence = kind === 'slope' && confidence === 'low';
      let color;
      let featureClass;
      if (cls && lowConfidence) {
        color = SLOPE_LOW_CONFIDENCE_COLOR;
        featureClass = 'low_confidence';
      } else if (cls) {
        color = colorFor(cls);
        featureClass = cls;
      } else if (opts.showUnclassified && kind === 'slope') {
        color = SLOPE_NO_SIGNAL_COLOR;
        featureClass = 'no_signal';
      } else {
        continue;
      }
      if (!color) continue;

      try {
        const line = window.L.polyline(latlngs, lineStyle(color, {
          renderer,
          weight: opts.weight,
          opacity: opts.opacity,
          dashArray: opts.dashArray,
        }));
        const properties = { way_id: String(wayId), class: featureClass, kind };
        if (kind === 'slope') {
          if (cls) properties.slope_class = cls;
          if (confidence) properties.slope_confidence = confidence;
          if (attrs) {
            if (Number.isFinite(attrs.road_slope_percent)) properties.slope_percent = attrs.road_slope_percent;
            if (typeof attrs.road_slope_method === 'string' && attrs.road_slope_method) {
              properties.slope_method = attrs.road_slope_method;
            }
            if (Number.isFinite(attrs.road_slope_sample_count)) {
              properties.slope_sample_count = attrs.road_slope_sample_count;
            }
          }
        } else if (attrs) {
          properties.traffic_measurement_type = attrs.traffic_measurement_type ||
            (attrs.traffic_proxy_class ? 'proxy' : null);
          properties.traffic_proxy_class = attrs.traffic_proxy_class || cls;
        }
        line.feature = { type: 'Feature', properties, geometry: null };

        const percent = attrs && Number.isFinite(attrs.road_slope_percent)
          ? attrs.road_slope_percent : null;
        if (kind === 'slope' && opts.debug && opts.debug.showPercent &&
            typeof line.bindTooltip === 'function' && percent !== null) {
          try {
            line.bindTooltip(`${percent} %`, {
              permanent: true, direction: 'center', className: 'context-road-debug-tooltip',
            });
          } catch (_) { /* unsupported tooltip options */ }
        }
        group.addLayer(line);
      } catch (_) { /* malformed line */ }
    }
    return group;
  }

  function buildSlopeLayer(state, options) {
    const opts = options || {};
    const merged = Object.assign({ weight: 8, opacity: 0.9 }, opts);
    if (opts.showUnclassified === undefined) merged.showUnclassified = true;
    return buildLayer(state, 'slope', merged);
  }

  function buildTrafficLayer(state, options) {
    return buildLayer(state, 'traffic', Object.assign({
      weight: 3, opacity: 0.95, dashArray: '10 6',
    }, options || {}));
  }

  function buildLegend(kind) {
    const div = document.createElement('div');
    div.className = `context-road-legend context-road-legend--${kind}`;
    const title = document.createElement('div');
    title.className = 'context-road-legend__title';
    title.textContent = kind === 'slope' ? 'Straßensteigung' : 'Verkehrsbelastung (qualitativer Proxy)';
    div.appendChild(title);
    const encoding = document.createElement('div');
    encoding.className = 'context-road-legend__encoding';
    encoding.textContent = kind === 'slope' ? 'breite Grundlinie' : 'gestrichelte Innenlinie';
    div.appendChild(encoding);

    const values = kind === 'slope' ? SLOPE_CLASS_VALUES : TRAFFIC_CLASS_VALUES;
    const labels = kind === 'slope' ? SLOPE_LABELS_DE : TRAFFIC_LABELS_DE;
    const colorFor = kind === 'slope' ? slopeClassColor : trafficClassColor;
    const styleSwatch = (swatch, color) => {
      swatch.dataset.lineEncoding = kind === 'slope' ? 'wide-solid' : 'narrow-dashed';
      if (kind === 'traffic') {
        swatch.style.background = 'transparent';
        swatch.style.color = color;
        swatch.style.height = '0';
        swatch.style.border = '0';
        swatch.style.borderTop = `3px dashed ${color}`;
        swatch.style.borderRadius = '0';
      } else {
        swatch.style.background = color;
        swatch.style.height = '8px';
      }
    };

    for (const cls of values) {
      const row = document.createElement('div');
      row.className = 'context-road-legend__row';
      const swatch = document.createElement('span');
      swatch.className = 'context-road-legend__swatch';
      styleSwatch(swatch, colorFor(cls));
      const label = document.createElement('span');
      label.className = 'context-road-legend__label';
      label.textContent = labels[cls] || cls;
      row.appendChild(swatch); row.appendChild(label); div.appendChild(row);
    }

    if (kind === 'slope') {
      const lowRow = document.createElement('div');
      lowRow.className = 'context-road-legend__lowconfidence';
      const lowSwatch = document.createElement('span');
      lowSwatch.className = 'context-road-legend__swatch';
      styleSwatch(lowSwatch, SLOPE_LOW_CONFIDENCE_COLOR);
      const lowLabel = document.createElement('span');
      lowLabel.className = 'context-road-legend__label';
      lowLabel.textContent = SLOPE_LOW_CONFIDENCE_LABEL_DE;
      lowRow.appendChild(lowSwatch); lowRow.appendChild(lowLabel); div.appendChild(lowRow);

      const noRow = document.createElement('div');
      noRow.className = 'context-road-legend__nosignal';
      const noSwatch = document.createElement('span');
      noSwatch.className = 'context-road-legend__swatch';
      styleSwatch(noSwatch, SLOPE_NO_SIGNAL_COLOR);
      const noLabel = document.createElement('span');
      noLabel.className = 'context-road-legend__label';
      noLabel.textContent = SLOPE_NO_SIGNAL_LABEL_DE;
      noRow.appendChild(noSwatch); noRow.appendChild(noLabel); div.appendChild(noRow);
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
    SLOPE_LOW_CONFIDENCE_COLOR,
    SLOPE_LOW_CONFIDENCE_LABEL_DE,
    HIGHWAY_TRAFFIC_PROXY_CLASS,
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
