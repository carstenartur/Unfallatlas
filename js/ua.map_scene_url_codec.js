(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // MapSceneUrlCodec — round-trip between URL search string and MapScene
  //
  // encode(scene)  → URL query string (without leading "?")
  // decode(search) → MapScene
  //
  // Backwards compatible with the canonical URL parameter names defined
  // in ua.state.js (CANON dict). Parameters absent from the scene that
  // still have their default values are omitted to keep URLs short.
  // ----------------------------

  UA.MapSceneUrlCodec = {

    /**
     * Encode a MapScene into a URL query string.
     * Only parameters that differ from defaults are included.
     * Returns a string without a leading "?".
     */
    encode: function encodeMapScene(scene) {
      if (!scene) return "";
      const p = new URLSearchParams();

      function set(k, v) { if (v !== null && v !== undefined && v !== "") p.set(k, String(v)); }
      function setBool(k, v, def) { if (v !== def) p.set(k, v ? '1' : '0'); }
      function setNum(k, v, def) { if (v != null && Number.isFinite(v) && v !== def) p.set(k, String(v)); }

      if (scene.city) set('city', scene.city);

      const f = scene.filters || {};
      if (f.severity     && f.severity     !== "all") set('severity',     f.severity);
      if (f.dayType      && f.dayType      !== "all") set('dayType',      f.dayType);
      if (f.roadCondition && f.roadCondition !== "all") set('roadCondition', f.roadCondition);
      setNum('hourFrom',          f.hourFrom,          0);
      setNum('hourTo',            f.hourTo,            23);
      setNum('maxPoints',         f.maxPoints,         100000);
      setNum('viewportPaddingPct',f.viewportPaddingPct,20);
      setNum('heatRadius',        f.heatRadius,        25);

      // For involvement checkboxes: only emit when they differ from the
      // typical defaults so freshly-opened URLs stay clean.
      setBool('includeCyclist',    f.includeCyclist,    true);
      setBool('includePedestrian', f.includePedestrian, true);
      setBool('includeCar',        f.includeCar,        true);
      setBool('includeMotorcycle', f.includeMotorcycle, false);
      setBool('includeGkfz',       f.includeGkfz,       false);
      setBool('includeSonstig',    f.includeSonstig,    false);

      if (f.involvementMode && f.involvementMode !== "or") set('involvementMode', f.involvementMode);

      // Context (enrichment) filters
      const cf = f.contextFilters || {};
      if (cf.slopeClasses   && cf.slopeClasses.length)   set('ctxSlope',   cf.slopeClasses.join(','));
      if (cf.trafficClasses && cf.trafficClasses.length) set('ctxTraffic', cf.trafficClasses.join(','));
      if (cf.onlyMatchedWays) p.set('ctxOnlyMatched', '1');

      // Layer visibility (only emit when toggled from defaults)
      const l = scene.layers || {};
      setBool('showCluster',          l.showCluster,          true);
      setBool('showHeatmap',          l.showHeatmap,          true);
      setBool('showOnlyAboveAverage', l.showOnlyAboveAverage, false);
      setBool('showSchools',          l.showSchools,          true);
      setBool('showKindergartens',    l.showKindergartens,    true);
      setBool('showArgumentation',    l.showArgumentation,    true);

      if (scene.accidentView && scene.accidentView !== "bySeverity") {
        set('accidentView', scene.accidentView);
      }

      // Viewport
      if (scene.center && Number.isFinite(scene.center.lat) && Number.isFinite(scene.center.lon)) {
        p.set('centerLat', String(scene.center.lat));
        p.set('centerLon', String(scene.center.lon));
      }
      if (scene.zoom != null && Number.isFinite(scene.zoom)) p.set('zoom', String(scene.zoom));

      // Selection rectangle
      const sel = scene.selection;
      if (sel && Number.isFinite(sel.south) && Number.isFinite(sel.west) &&
                 Number.isFinite(sel.north) && Number.isFinite(sel.east)) {
        p.set('selSouth', String(sel.south));
        p.set('selWest',  String(sel.west));
        p.set('selNorth', String(sel.north));
        p.set('selEast',  String(sel.east));
      }

      // Context map overlays
      const ovl = scene.contextOverlays && scene.contextOverlays.active;
      if (ovl) {
        const layers = [];
        if (ovl.slope)   layers.push('slope');
        if (ovl.traffic) layers.push('traffic');
        if (layers.length) set('mapLayer', layers.join(','));
      }

      return p.toString();
    },

    /**
     * Decode a URL search string (with or without leading "?") into a MapScene.
     * Missing parameters receive their defaults. Unknown parameters are ignored.
     */
    decode: function decodeMapScene(search) {
      const qs = (typeof search === 'string')
        ? new URLSearchParams(search.replace(/^\?/, ''))
        : (search || new URLSearchParams());

      function get(k, def)     { return qs.has(k) ? qs.get(k) : def; }
      function getBool(k, def) { return qs.has(k) ? (qs.get(k) === '1' || qs.get(k) === 'true') : def; }
      function getNum(k, def)  {
        if (!qs.has(k)) return def;
        const n = parseFloat(qs.get(k));
        return Number.isFinite(n) ? n : def;
      }

      let center = null;
      if (qs.has('centerLat') && qs.has('centerLon')) {
        const lat = parseFloat(qs.get('centerLat'));
        const lon = parseFloat(qs.get('centerLon'));
        if (Number.isFinite(lat) && Number.isFinite(lon)) center = { lat, lon };
      }

      let selection = null;
      if (qs.has('selSouth') && qs.has('selWest') && qs.has('selNorth') && qs.has('selEast')) {
        const s = parseFloat(qs.get('selSouth'));
        const w = parseFloat(qs.get('selWest'));
        const n = parseFloat(qs.get('selNorth'));
        const e = parseFloat(qs.get('selEast'));
        if (Number.isFinite(s) && Number.isFinite(w) && Number.isFinite(n) && Number.isFinite(e) &&
            s < n && w < e) {
          selection = { south: s, west: w, north: n, east: e };
        }
      }

      const slopeRaw   = qs.has('ctxSlope')   ? qs.get('ctxSlope').split(',').filter(Boolean)   : [];
      const trafficRaw = qs.has('ctxTraffic') ? qs.get('ctxTraffic').split(',').filter(Boolean) : [];

      let mapLayerSlope   = false;
      let mapLayerTraffic = false;
      if (qs.has('mapLayer')) {
        const parts = qs.get('mapLayer').split(',');
        mapLayerSlope   = parts.includes('slope');
        mapLayerTraffic = parts.includes('traffic');
      }

      return UA.MapScene.create({
        city: get('city', ''),
        center,
        zoom: getNum('zoom', null),
        selection,
        filters: {
          severity:          get('severity',      'all'),
          dayType:           get('dayType',       'all'),
          roadCondition:     get('roadCondition', 'all'),
          hourFrom:          getNum('hourFrom',          0),
          hourTo:            getNum('hourTo',            23),
          maxPoints:         getNum('maxPoints',         100000),
          viewportPaddingPct:getNum('viewportPaddingPct',20),
          heatRadius:        getNum('heatRadius',        25),
          includeCyclist:    getBool('includeCyclist',    true),
          includePedestrian: getBool('includePedestrian', true),
          includeCar:        getBool('includeCar',        true),
          includeMotorcycle: getBool('includeMotorcycle', false),
          includeGkfz:       getBool('includeGkfz',       false),
          includeSonstig:    getBool('includeSonstig',    false),
          involvementMode:   get('involvementMode', 'or'),
          contextFilters: {
            slopeClasses:    slopeRaw,
            trafficClasses:  trafficRaw,
            onlyMatchedWays: getBool('ctxOnlyMatched', false)
          }
        },
        layers: {
          showCluster:          getBool('showCluster',          true),
          showHeatmap:          getBool('showHeatmap',          true),
          showOnlyAboveAverage: getBool('showOnlyAboveAverage', false),
          showSchools:          getBool('showSchools',          true),
          showKindergartens:    getBool('showKindergartens',    true),
          showArgumentation:    getBool('showArgumentation',    true)
        },
        accidentView: get('accidentView', 'bySeverity'),
        contextOverlays: {
          active: { slope: mapLayerSlope, traffic: mapLayerTraffic }
        }
      });
    }
  };
})();
