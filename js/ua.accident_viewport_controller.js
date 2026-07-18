(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  function normalizeBounds(bounds) {
    if (!bounds) return null;
    let result;
    if (typeof bounds.getSouth === 'function') {
      result = {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      };
    } else if (Array.isArray(bounds) && bounds.length === 4) {
      result = {
        south: bounds[0], west: bounds[1], north: bounds[2], east: bounds[3],
      };
    } else if (typeof bounds === 'object') {
      result = {
        south: bounds.south, west: bounds.west,
        north: bounds.north, east: bounds.east,
      };
    } else {
      return null;
    }
    if (!Object.values(result).every(Number.isFinite)) return null;
    return Object.freeze(result);
  }

  function stableFeatureText(feature) {
    return JSON.stringify(feature);
  }

  function fallbackIdentity(feature) {
    const providerApi = UA.AccidentProvider;
    if (providerApi && typeof providerApi._canonicalFeatureIdentity === 'function') {
      return providerApi._canonicalFeatureIdentity(feature);
    }
    return `feature:${stableFeatureText(feature)}`;
  }

  function mergeTileSet(tileSet) {
    const byIdentity = new Map();
    let properties = null;
    const tiles = Array.isArray(tileSet && tileSet.tiles)
      ? tileSet.tiles.slice().sort((left, right) => String(left.key).localeCompare(String(right.key), 'en', { numeric: true }))
      : [];

    for (const tile of tiles) {
      const collection = tile && tile.featureCollection;
      if (!collection || collection.type !== 'FeatureCollection'
          || !Array.isArray(collection.features)) continue;
      if (!properties && collection.properties && typeof collection.properties === 'object') {
        properties = collection.properties;
      }
      const identities = Array.isArray(tile.featureIdentities)
        && tile.featureIdentities.length === collection.features.length
        ? tile.featureIdentities
        : collection.features.map(fallbackIdentity);

      collection.features.forEach((feature, index) => {
        const identity = String(identities[index] || fallbackIdentity(feature));
        const text = stableFeatureText(feature);
        const existing = byIdentity.get(identity);
        if (existing && existing.text !== text) {
          throw new Error(
            `[AccidentViewportController] conflicting duplicate feature identity ${identity}`
          );
        }
        if (!existing) byIdentity.set(identity, { feature, text });
      });
    }

    const features = Array.from(byIdentity.entries())
      .sort((left, right) => left[0].localeCompare(right[0], 'en', { numeric: true }))
      .map(entry => entry[1].feature);
    const result = { type: 'FeatureCollection', features };
    if (properties) result.properties = properties;
    return result;
  }

  function freezeCoverage(values) {
    const result = { ...values };
    for (const key of ['requiredTileKeys', 'loadedTileKeys', 'missingTileKeys']) {
      if (Array.isArray(result[key])) result[key] = Object.freeze(result[key].slice());
    }
    return Object.freeze(result);
  }

  function create(options = {}) {
    const provider = options.provider;
    if (!provider || typeof provider.fetchTileSetForBbox !== 'function') {
      throw new TypeError(
        '[AccidentViewportController] provider.fetchTileSetForBbox must be a function'
      );
    }

    let epoch = 0;
    let activeCity = null;
    let geojson = { type: 'FeatureCollection', features: [] };
    let coverage = null;

    function snapshot() {
      return Object.freeze({
        epoch,
        city: activeCity,
        geojson,
        coverage,
      });
    }

    function invalidate() {
      epoch += 1;
      return epoch;
    }

    async function load(cityRaw, bounds) {
      const city = UA.normKey && typeof UA.normKey === 'function'
        ? UA.normKey(cityRaw)
        : String(cityRaw || '').trim().toLowerCase();
      const normalizedBounds = normalizeBounds(bounds);
      if (!city) throw new Error('[AccidentViewportController] city is required');
      if (!normalizedBounds) {
        throw new Error('[AccidentViewportController] finite viewport bounds are required');
      }

      if (activeCity !== city) {
        activeCity = city;
        geojson = { type: 'FeatureCollection', features: [] };
        coverage = null;
      }

      const requestEpoch = ++epoch;
      coverage = freezeCoverage({
        mode: 'viewport-partial',
        complete: false,
        viewportComplete: false,
        provider: 'tiled',
        city,
        bounds: normalizedBounds,
        epoch: requestEpoch,
        status: 'loading',
        requiredTileKeys: [],
        requiredTileCount: 0,
        loadedTileKeys: [],
        loadedTileCount: 0,
        missingTileKeys: [],
        missingTileCount: 0,
        loadedFeatureCount: Array.isArray(geojson.features) ? geojson.features.length : 0,
      });

      try {
        const tileSet = await provider.fetchTileSetForBbox(city, normalizedBounds);
        if (requestEpoch !== epoch) {
          return Object.freeze({ committed: false, stale: true, epoch: requestEpoch });
        }

        const nextGeoJson = mergeTileSet(tileSet);
        if (typeof provider.retainForViewport === 'function') {
          provider.retainForViewport(city, tileSet.requestedTileKeys || []);
        }
        const requiredTileKeys = Array.from(tileSet.requestedTileKeys || []);
        const loadedTileKeys = Array.from(tileSet.loadedTileKeys || []);
        const missingTileKeys = Array.from(tileSet.missingTileKeys || []);
        const status = missingTileKeys.length > 0
          ? 'degraded'
          : 'complete-for-viewport';
        const nextCoverage = freezeCoverage({
          mode: 'viewport-partial',
          complete: false,
          viewportComplete: missingTileKeys.length === 0,
          provider: 'tiled',
          city,
          bounds: normalizedBounds,
          epoch: requestEpoch,
          status,
          tileZoom: Number.isInteger(tileSet.tileZoom) ? tileSet.tileZoom : null,
          requiredTileKeys,
          requiredTileCount: requiredTileKeys.length,
          loadedTileKeys,
          loadedTileCount: loadedTileKeys.length,
          missingTileKeys,
          missingTileCount: missingTileKeys.length,
          loadedFeatureCount: nextGeoJson.features.length,
          manifestTileCount: Number.isInteger(tileSet.manifestTileCount)
            ? tileSet.manifestTileCount
            : null,
          sourceTotalCount: Number.isInteger(tileSet.sourceTotalCount)
            ? tileSet.sourceTotalCount
            : null,
          sourceFingerprint: tileSet.sourceFingerprint || null,
        });

        geojson = nextGeoJson;
        coverage = nextCoverage;
        return Object.freeze({
          committed: true,
          stale: false,
          epoch: requestEpoch,
          geojson,
          coverage,
        });
      } catch (error) {
        if (requestEpoch !== epoch) {
          return Object.freeze({ committed: false, stale: true, epoch: requestEpoch });
        }
        coverage = freezeCoverage({
          ...(coverage || {}),
          mode: 'viewport-partial',
          complete: false,
          viewportComplete: false,
          provider: 'tiled',
          city,
          bounds: normalizedBounds,
          epoch: requestEpoch,
          status: 'degraded',
          error: String(error && error.message ? error.message : error),
          loadedFeatureCount: Array.isArray(geojson.features) ? geojson.features.length : 0,
        });
        return Object.freeze({
          committed: true,
          stale: false,
          changed: false,
          epoch: requestEpoch,
          geojson,
          coverage,
          error,
        });
      }
    }

    function clear(cityRaw) {
      invalidate();
      if (typeof provider.clearCache === 'function') provider.clearCache(cityRaw);
      if (cityRaw == null || activeCity === String(cityRaw || '').trim().toLowerCase()
          || (UA.normKey && UA.normKey(cityRaw) === activeCity)) {
        activeCity = null;
        geojson = { type: 'FeatureCollection', features: [] };
        coverage = null;
      }
    }

    return Object.freeze({
      load,
      invalidate,
      clear,
      getSnapshot: snapshot,
    });
  }

  UA.AccidentViewportController = Object.freeze({
    create,
    normalizeBounds,
    _mergeTileSet: mergeTileSet,
  });
})();
