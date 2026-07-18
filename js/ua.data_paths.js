(() => {
  'use strict';

  /**
   * js/ua.data_paths.js
   *
   * Single source of truth for all static-data file paths.
   *
   * Every path that the application resolves at runtime lives here.
   * No other module should construct `out/…` paths from raw city slugs
   * directly.  When a path convention changes (e.g. a directory rename
   * or a new file-format suffix), only this file needs updating.
   *
   * Public API:
   *   UA.DataPaths.accidentGeoJson(slug)       → out/output_all_years_{slug}.geojson
   *   UA.DataPaths.poiGeoJson(slug)            → out/poi_{slug}.geojson
   *   UA.DataPaths.contextWays(slug)           → out/ways_{slug}.json
   *   UA.DataPaths.enrichmentMeta(slug)        → out/output_all_years_{slug}.enrichment.meta.json
   *   UA.DataPaths.contextTileIndex(slug)      → out/ctxtiles/{slug}/index.json
   *   UA.DataPaths.contextTile(slug, z, x, y) → out/ctxtiles/{slug}/{z}/{x}/{y}.json
   *   UA.DataPaths.accidentTileIndex(slug)     → out/accidenttiles/{slug}/index.json
   *   UA.DataPaths.accidentTile(slug,z,x,y)   → out/accidenttiles/{slug}/{z}/{x}/{y}.json
   *
   * The functions accept raw city names (e.g. "München") or pre-slugified
   * keys (e.g. "muenchen"). Slugification is delegated to UA.normKey when
   * available so the slugify logic stays in one place (ua.core.js).
   */

  const UA = (window.UA = window.UA || {});

  function _slug(cityRaw) {
    if (UA.normKey && typeof UA.normKey === 'function') return UA.normKey(cityRaw);
    return String(cityRaw || '').toLowerCase().trim();
  }

  const DataPaths = {
    /**
     * Path to the accident GeoJSON for a city.
     * Example: out/output_all_years_berlin.geojson
     */
    accidentGeoJson(cityRaw) {
      return `out/output_all_years_${_slug(cityRaw)}.geojson`;
    },

    /**
     * Path to the POI GeoJSON for a city.
     * Example: out/poi_berlin.geojson
     */
    poiGeoJson(cityRaw) {
      return `out/poi_${_slug(cityRaw)}.geojson`;
    },

    /**
     * Path to the OSM/DEM/Traffic context-ways JSON for a city.
     * Example: out/ways_berlin.json
     */
    contextWays(cityRaw) {
      return `out/ways_${_slug(cityRaw)}.json`;
    },

    /**
     * Path to the enrichment metadata sidecar for a city.
     * Example: out/output_all_years_berlin.enrichment.meta.json
     */
    enrichmentMeta(cityRaw) {
      return `out/output_all_years_${_slug(cityRaw)}.enrichment.meta.json`;
    },

    /**
     * Path to the v3 context-tile index manifest for a city.
     * Example: out/ctxtiles/berlin/index.json
     */
    contextTileIndex(cityRaw) {
      return `out/ctxtiles/${_slug(cityRaw)}/index.json`;
    },

    /**
     * Path to a single v3 context tile.
     * Example: out/ctxtiles/berlin/13/4200/2750.json
     */
    contextTile(cityRaw, z, x, y) {
      return `out/ctxtiles/${_slug(cityRaw)}/${z}/${x}/${y}.json`;
    },

    /**
     * Path to the accident-tile index manifest for a city.
     * Example: out/accidenttiles/berlin/index.json
     */
    accidentTileIndex(cityRaw) {
      return `out/accidenttiles/${_slug(cityRaw)}/index.json`;
    },

    /**
     * Path to a single accident tile.
     * Example: out/accidenttiles/berlin/13/4200/2750.json
     */
    accidentTile(cityRaw, z, x, y) {
      return `out/accidenttiles/${_slug(cityRaw)}/${z}/${x}/${y}.json`;
    },
  };

  UA.DataPaths = DataPaths;

  // Optional missing-data recovery UI. Loading it here keeps the existing HTML
  // entry point unchanged and makes the same button available on GitHub Pages
  // and in the Docker server. The module is self-initialising and degrades to a
  // safe GitHub Actions link when no local API exists.
  if (typeof document !== 'undefined' && !document.querySelector('script[data-ua-context-generation]')) {
    const script = document.createElement('script');
    script.src = 'js/ua.context_generation.js?v=2026-07-18';
    script.async = true;
    script.dataset.uaContextGeneration = '1';
    document.head.appendChild(script);
  }
})();
