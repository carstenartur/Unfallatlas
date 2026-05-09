(() => {
  'use strict';

  /**
   * js/ua.context_layers.js
   *
   * Lazy loader for the optional "context layers" produced by the CI
   * enrichment step (scripts/enrich_geojson.js). The companion
   * ways_<city>.json + sidecar *.enrichment.meta.json are NOT fetched
   * during the application's startup path — only when the context-layers
   * UI panel is first opened, and even then behind a requestIdleCallback
   * guard so that the map stays responsive.
   *
   * The module is intentionally side-effect-free at load time. None of
   * the existing modules (ua.data_v2, ua.filters, ua.map_v2,
   * ua.export_v2, ua.report_v2) depend on it; reading the optional
   * per-feature enrichment fields (e.g. props.elevation_m) is a free
   * `?.` away wherever a renderer wants them.
   *
   * Public API:
   *   UA.contextLayers.detect(geojson)  → { availableFields[], hasDicts }
   *   UA.contextLayers.load(cityRaw)    → Promise<{ ways, meta, dicts }>
   *                                        (idempotent; cached per city)
   *   UA.contextLayers.resolveWay(state, wayId) → resolved way attrs
   *                                                with categorical
   *                                                int-codes mapped back
   *                                                to strings via dicts.
   */

  const UA = (window.UA = window.UA || {});

  // Per-feature fields the loader probes on a sample of features to
  // decide which UI toggles to render. Mirrors PER_FEATURE_FIELDS in
  // scripts/enrich_geojson.js.
  const PER_FEATURE_FIELDS = [
    'matched_way_id',
    'road_context_source',
    'elevation_m',
    'slope_percent',
    'slope_abs_percent',
    'slope_class',
    'slope_source',
    'slope_confidence',
    'traffic_proxy_class',
    'highway',
    'maxspeed',
    'lanes',
    'surface',
    'cycleway',
    'osm_incline',
    'road_slope_percent',
  ];

  const SAMPLE_SIZE = 200; // enough to detect rare fields without
                           //  paying a full-pass cost on hot paths.

  function detect(geojson) {
    const out = { availableFields: [], hasDicts: false };
    if (!geojson || !Array.isArray(geojson.features)) return out;
    out.hasDicts = !!(geojson.properties && geojson.properties.enrichmentDicts);

    const seen = new Set();
    const feats = geojson.features;
    const stride = Math.max(1, Math.floor(feats.length / SAMPLE_SIZE));
    for (let i = 0; i < feats.length && seen.size < PER_FEATURE_FIELDS.length; i += stride) {
      const p = feats[i] && feats[i].properties;
      if (!p) continue;
      for (const f of PER_FEATURE_FIELDS) if (p[f] !== undefined) seen.add(f);
    }
    out.availableFields = PER_FEATURE_FIELDS.filter(f => seen.has(f));
    return out;
  }

  // Field groupings that drive the four high-level capability flags.
  // Kept here (next to PER_FEATURE_FIELDS / detect) so adding a new
  // context field is a one-line change in this module instead of
  // touching the data loader, the popup renderer and every test in
  // parallel.
  const CAPABILITY_FIELDS = {
    hasElevation:    ['elevation_m'],
    hasSlope:        ['slope_percent', 'slope_abs_percent', 'slope_class', 'slope_source', 'slope_confidence'],
    hasOsmContext:   ['matched_way_id', 'highway', 'maxspeed', 'lanes', 'surface', 'cycleway', 'osm_incline', 'road_slope_percent', 'road_context_source'],
    hasTrafficProxy: ['traffic_proxy_class'],
  };

  /**
   * Derive the high-level capability flags consumed by the UI (popup,
   * future panel, future filters) from a `detect()` result. Single
   * source of truth — the data loader, the popup renderer and the
   * tests all go through this helper so adding a field never drifts
   * between layers.
   *
   * @param {{ availableFields?: string[] }|null|undefined} detection
   * @returns {{ hasElevation:boolean, hasSlope:boolean, hasOsmContext:boolean, hasTrafficProxy:boolean, hasAny:boolean }}
   */
  function capabilitiesFromDetection(detection) {
    const available = new Set((detection && detection.availableFields) || []);
    const caps = {};
    let hasAny = false;
    for (const flag of Object.keys(CAPABILITY_FIELDS)) {
      const present = CAPABILITY_FIELDS[flag].some(f => available.has(f));
      caps[flag] = present;
      if (present) hasAny = true;
    }
    caps.hasAny = hasAny;
    return caps;
  }

  // Cache: cityKey → Promise<state>
  const cache = new Map();

  function urls(cityRaw) {
    const slug = (UA.normKey ? UA.normKey(cityRaw) : String(cityRaw || '').toLowerCase());
    return {
      slug,
      ways: `out/ways_${slug}.json`,
      meta: `out/output_all_years_${slug}.enrichment.meta.json`,
    };
  }

  /**
   * Lazily fetch ways_<city>.json + *.enrichment.meta.json. Cached per
   * city. Both files are optional — if either 404s, the corresponding
   * field of the returned state is null and the panel falls back to
   * what the per-feature properties already carry.
   *
   * @param {object} ctx          Application context (for dicts lookup;
   *                              dicts are read from
   *                              `ctx.geojsonProps?.enrichmentDicts` —
   *                              i.e. the parsed FC.properties stashed
   *                              by the loader at fetch time. As a
   *                              compatibility fallback, an explicit
   *                              `ctx.enrichmentDicts` is also
   *                              accepted.)
   * @param {string} cityRaw      Raw city name (e.g. "Bonn").
   */
  function load(ctx, cityRaw) {
    const u = urls(cityRaw);
    if (cache.has(u.slug)) return cache.get(u.slug);

    const p = (async () => {
      const [waysResp, metaResp] = await Promise.all([
        fetch(u.ways, { cache: 'force-cache' }).catch(() => null),
        fetch(u.meta, { cache: 'force-cache' }).catch(() => null),
      ]);
      const raw  = (waysResp && waysResp.ok) ? await waysResp.json().catch(() => null) : null;
      const meta = (metaResp && metaResp.ok) ? await metaResp.json().catch(() => null) : null;
      const dicts = (ctx && (ctx.geojsonProps?.enrichmentDicts || ctx.enrichmentDicts)) || null;

      // ways_<city>.json supports two shapes:
      //   v2 (current): { schemaVersion: 2, ways: {…}, geometries: {…} }
      //   v1 (legacy):  { "<wayId>": {attrs}, ... }
      // The v2 shape is a strict superset; v1 is detected by the
      // absence of a `ways` map and the presence of object values.
      let ways = null, geometries = null;
      if (raw && typeof raw === 'object') {
        if (raw.ways && typeof raw.ways === 'object') {
          ways = raw.ways;
          geometries = (raw.geometries && typeof raw.geometries === 'object')
            ? raw.geometries : null;
        } else {
          // Legacy flat shape — every top-level value is a per-way attrs object.
          ways = raw;
        }
      }
      return { slug: u.slug, ways, geometries, meta, dicts };
    })();

    cache.set(u.slug, p);
    return p;
  }

  /** Schedule load() at idle; resolves to the state immediately if
   *  requestIdleCallback is unavailable. */
  function loadAtIdle(ctx, cityRaw) {
    return new Promise(resolve => {
      const fire = () => resolve(load(ctx, cityRaw));
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(fire, { timeout: 1500 });
      } else {
        setTimeout(fire, 0);
      }
    });
  }

  /** Resolve int-coded categorical fields on a way row back to strings
   *  via the dictionaries baked into the FeatureCollection. Pure; safe
   *  to call repeatedly. Returns a new object — never mutates input. */
  function resolveWay(state, wayId) {
    const w = state && state.ways && state.ways[wayId];
    if (!w) return null;
    const dicts = (state && state.dicts) || {};
    const out = {};
    for (const k of Object.keys(w)) {
      const dict = dicts[k];
      const v = w[k];
      out[k] = (Array.isArray(dict) && Number.isInteger(v) && v >= 0 && v < dict.length) ? dict[v] : v;
    }
    return out;
  }

  function clearCache() { cache.clear(); }

  UA.contextLayers = {
    detect,
    capabilitiesFromDetection,
    CAPABILITY_FIELDS,
    load,
    loadAtIdle,
    resolveWay,
    clearCache,
    PER_FEATURE_FIELDS,
  };
})();
