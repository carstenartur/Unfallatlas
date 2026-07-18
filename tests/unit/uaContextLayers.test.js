'use strict';

const fs = require('fs');
const path = require('path');

function evaluate(relPath, win) {
  const source = fs.readFileSync(path.resolve(__dirname, relPath), 'utf8');
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
}

function loadModule() {
  const win = { UA: {}, requestIdleCallback: undefined };
  evaluate('../../js/ua.core.js', win);
  evaluate('../../js/ua.data_paths.js', win);
  evaluate('../../js/ua.context_layers.js', win);
  return win.UA;
}

function missingCompressedResources(UA) {
  UA.fetchJsonCompressed = jest.fn(async () => {
    throw new Error('missing');
  });
}

describe('UA.contextLayers public contract', () => {
  test('exposes detection, loading, tile and resolution APIs', () => {
    const UA = loadModule();
    expect(typeof UA.contextLayers.detect).toBe('function');
    expect(typeof UA.contextLayers.capabilitiesFromDetection).toBe('function');
    expect(typeof UA.contextLayers.load).toBe('function');
    expect(typeof UA.contextLayers.loadTilesForBbox).toBe('function');
    expect(typeof UA.contextLayers.resolveWayAcrossTiles).toBe('function');
    expect(UA.contextLayers.TILE_FETCH_CONCURRENCY).toBeGreaterThan(0);
  });

  test('detects only context fields actually present', () => {
    const UA = loadModule();
    const plain = UA.contextLayers.detect({
      type: 'FeatureCollection',
      features: [{ properties: { id: '1' } }],
    });
    expect(plain.availableFields).toEqual([]);
    expect(plain.hasDicts).toBe(false);

    const enriched = UA.contextLayers.detect({
      type: 'FeatureCollection',
      properties: { enrichmentDicts: { highway: ['residential'] } },
      features: [{
        properties: {
          matched_way_id: 'W1',
          elevation_m: 123,
          slope_class: 'steep',
          traffic_proxy_class: 'high',
          highway: 'residential',
        },
      }],
    });
    expect(enriched.hasDicts).toBe(true);
    expect(enriched.availableFields).toEqual(expect.arrayContaining([
      'matched_way_id', 'elevation_m', 'slope_class', 'traffic_proxy_class', 'highway',
    ]));
    expect(UA.contextLayers.capabilitiesFromDetection(enriched)).toEqual(expect.objectContaining({
      hasElevation: true,
      hasSlope: true,
      hasOsmContext: true,
      hasTrafficProxy: true,
      hasAny: true,
    }));
  });

  test('resolves integer-coded way attributes without mutating state', () => {
    const UA = loadModule();
    const state = {
      ways: { W1: { highway: 1, maxspeed: 30 } },
      dicts: { highway: ['residential', 'secondary'] },
    };
    const before = JSON.stringify(state);
    expect(UA.contextLayers.resolveWay(state, 'W1'))
      .toEqual({ highway: 'secondary', maxspeed: 30 });
    expect(JSON.stringify(state)).toBe(before);
    expect(UA.contextLayers.resolveWay(state, 'missing')).toBeNull();
  });
});

describe('UA.contextLayers loading through DataResources', () => {
  test('caches one promise per city and preserves FeatureCollection dictionaries', async () => {
    const UA = loadModule();
    missingCompressedResources(UA);
    const ctx = { geojsonProps: { enrichmentDicts: { highway: ['residential'] } } };

    const first = UA.contextLayers.load(ctx, 'Bonn');
    const second = UA.contextLayers.load(ctx, 'Bonn');
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(expect.objectContaining({
      slug: 'bonn',
      ways: null,
      dicts: { highway: ['residential'] },
    }));
  });

  test('parses v2 and legacy-v1 ways payloads', async () => {
    const v2UA = loadModule();
    v2UA.fetchJsonCompressed = jest.fn(async url => {
      if (url.endsWith('ways_bonn.json')) {
        return {
          schemaVersion: 2,
          ways: { W1: { highway: 0 } },
          geometries: { W1: [50, 7, 50.001, 7.001] },
        };
      }
      throw new Error('missing');
    });
    const v2 = await v2UA.contextLayers.load({}, 'Bonn');
    expect(v2.ways).toEqual({ W1: { highway: 0 } });
    expect(v2.geometries.W1).toEqual([50, 7, 50.001, 7.001]);

    const v1UA = loadModule();
    v1UA.fetchJsonCompressed = jest.fn(async url => {
      if (url.endsWith('ways_bonn.json')) return { W1: { highway: 'residential' } };
      throw new Error('missing');
    });
    const v1 = await v1UA.contextLayers.load({}, 'Bonn');
    expect(v1.ways).toEqual({ W1: { highway: 'residential' } });
    expect(v1.geometries).toBeNull();
  });

  test('loads a sidecar-driven v3 manifest from the canonical registry resource', async () => {
    const UA = loadModule();
    const manifest = {
      schemaVersion: 3,
      z: 13,
      tiles: [{ x: 4280, y: 2730 }],
      dicts: { highway: ['residential'] },
    };
    UA.fetchJsonCompressed = jest.fn(async url => {
      if (url.endsWith('ways_bonn.json')) throw new Error('missing');
      if (url.endsWith('output_all_years_bonn.enrichment.meta.json')) {
        return { schemaVersion: 3, tileIndexPath: 'ctxtiles\\bonn\\index.json' };
      }
      if (url.endsWith('ctxtiles/bonn/index.json')) return manifest;
      throw new Error(`unexpected URL: ${url}`);
    });

    const state = await UA.contextLayers.load({}, 'Bonn');
    expect(state.tileIndex).toBe(manifest);
    expect(state.tileIndexUrl).toBe('out/ctxtiles/bonn/index.json');
    expect(state.tileIndex.tileUrlByKey.get('4280/2730'))
      .toBe('out/ctxtiles/bonn/4280/2730.json');
    expect(state.ways).toEqual({});
    expect(state.geometries).toEqual({});
  });

  test('rejects unsupported future ways schemas once per city', async () => {
    const UA = loadModule();
    UA.fetchJsonCompressed = jest.fn(async url => {
      if (url.endsWith('ways_future.json')) return { schemaVersion: 9, ways: { W1: {} } };
      throw new Error('missing');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await UA.contextLayers.load({}, 'future');
      expect(first.ways).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      await UA.contextLayers.load({}, 'future');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('v3 context tile loading through DataResources', () => {
  function tileBounds(x, y, z) {
    const west = (x / Math.pow(2, z)) * 360 - 180;
    const east = ((x + 1) / Math.pow(2, z)) * 360 - 180;
    const northN = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    const southN = Math.PI - (2 * Math.PI * (y + 1)) / Math.pow(2, z);
    const north = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(northN) - Math.exp(-northN)));
    const south = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(southN) - Math.exp(-southN)));
    return {
      getSouth: () => south + 0.001,
      getNorth: () => north - 0.001,
      getWest: () => west + 0.001,
      getEast: () => east - 0.001,
    };
  }

  test('loads only viewport tiles as gzip and reuses the tile cache', async () => {
    const UA = loadModule();
    const envelope = {
      schemaVersion: 3,
      coverage: 'full',
      tileIndexUrl: 'out/ctxtiles/bonn/index.json',
    };
    const manifest = {
      schemaVersion: 3,
      z: 13,
      coverage: 'full',
      tiles: [
        { x: 4280, y: 2730 },
        { x: 4290, y: 2730 },
      ],
      wayIndex: { W1: [4280, 2730], W2: [4290, 2730] },
      dicts: { highway: ['residential', 'secondary'] },
    };
    UA.fetchJsonCompressed = jest.fn(async url => {
      if (url.endsWith('ways_bonn.json')) return envelope;
      if (url.endsWith('ctxtiles/bonn/index.json')) return manifest;
      throw new Error('missing');
    });
    UA.fetchJsonGz = jest.fn(async url => {
      if (url.endsWith('/4280/2730.json.gz')) {
        return {
          ways: { W1: { highway: 0, maxspeed: 30 } },
          geometries: { W1: [50, 7, 50.001, 7.001] },
        };
      }
      throw new Error(`unexpected tile: ${url}`);
    });

    const state = await UA.contextLayers.load({}, 'Bonn');
    const bounds = tileBounds(4280, 2730, 13);
    const merged = await UA.contextLayers.loadTilesForBbox(state, bounds);
    expect(UA.fetchJsonGz).toHaveBeenCalledWith(
      'out/ctxtiles/bonn/4280/2730.json.gz',
      expect.objectContaining({ cache: 'force-cache' })
    );
    expect(merged.ways.W1).toBeDefined();
    expect(merged.ways.W2).toBeUndefined();

    await UA.contextLayers.loadTilesForBbox(state, bounds);
    expect(UA.fetchJsonGz).toHaveBeenCalledTimes(1);
  });

  test('popup hydration uses the same central tile resource', async () => {
    const UA = loadModule();
    UA.fetchJsonGz = jest.fn(async () => ({
      ways: { Z9: { highway: 0 } },
      geometries: { Z9: [50, 7, 50.001, 7.001] },
    }));
    const state = {
      slug: 'bonn',
      ways: {},
      geometries: {},
      dicts: { highway: ['residential'] },
      tileIndex: {
        z: 13,
        tiles: [{ x: 100, y: 200 }],
        wayIndex: { Z9: [100, 200] },
        tileKeySet: new Set(['100/200']),
      },
      _tileCache: new Map(),
    };

    expect(UA.contextLayers.resolveWayAcrossTiles(state, 'Z9')).toBeNull();
    await state._tileCache.get('100/200');
    expect(UA.fetchJsonGz).toHaveBeenCalledWith(
      'out/ctxtiles/bonn/100/200.json.gz',
      expect.any(Object)
    );
    expect(UA.contextLayers.resolveWayAcrossTiles(state, 'Z9'))
      .toEqual({ highway: 'residential' });
  });

  test('is a no-op for untiled v1/v2 states', async () => {
    const UA = loadModule();
    const state = {
      tileIndex: null,
      _tileCache: null,
      ways: { W1: { highway: 'residential' } },
      geometries: { W1: [50, 7, 50.001, 7.001] },
    };
    const merged = await UA.contextLayers.loadTilesForBbox(state, {});
    expect(merged.ways).toBe(state.ways);
    expect(merged.geometries).toBe(state.geometries);
  });
});