'use strict';

/**
 * Tests for scripts/producers/dem_producer.js
 *
 * Pure-helper coverage (point dedupe, sample-set construction, slope
 * computation, way-elevation derivation, dataset assembly) plus an
 * end-to-end produceCity test with a stubbed elevation fetcher that
 * proves the on-disk payload is shape-compatible with `loadDemProvider`
 * in `scripts/enrich_geojson.js`.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const dem = require('../../scripts/producers/dem_producer.js');

function fc(features) { return { type: 'FeatureCollection', features }; }
function pt(id, lon, lat) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id: String(id) },
  };
}

describe('dem_producer — slugCity', () => {
  test('matches the enrich_geojson convention', () => {
    expect(dem.slugCity('Bonn')).toBe('bonn');
    expect(dem.slugCity('Düsseldorf')).toBe('duesseldorf');
    expect(dem.slugCity('Frankfurt am Main')).toBe('frankfurt_am_main');
  });
});

describe('dem_producer — uniquePointsFromFeatureCollection', () => {
  test('deduplicates at 5 dp and quantises coordinates', () => {
    const points = dem.uniquePointsFromFeatureCollection(fc([
      pt(1, 7.123456, 50.123456),
      // Same 5 dp bucket as #1 → coalesced.
      pt(2, 7.1234561, 50.1234561),
      pt(3, 7.200000, 50.200000),
      // Malformed → skipped.
      { type: 'Feature', geometry: null, properties: {} },
    ]));
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ lat: 50.12346, lon: 7.12346 });
    expect(points[1]).toEqual({ lat: 50.20000, lon: 7.20000 });
  });

  test('returns [] on empty / malformed input', () => {
    expect(dem.uniquePointsFromFeatureCollection(null)).toEqual([]);
    expect(dem.uniquePointsFromFeatureCollection(fc([]))).toEqual([]);
  });
});

describe('dem_producer — buildSampleSet', () => {
  test('emits 5 samples with the expected order (c, n, s, e, w)', () => {
    const s = dem.buildSampleSet({ lat: 50, lon: 7 }, 30);
    expect(s.map(x => x.role)).toEqual(['c', 'n', 's', 'e', 'w']);
    expect(s[0]).toEqual({ role: 'c', lat: 50, lon: 7 });
    // ~30 m / 111320 m/deg ≈ 0.000269 deg lat
    expect(s[1].lat).toBeCloseTo(50 + 30 / 111320, 8);
    expect(s[2].lat).toBeCloseTo(50 - 30 / 111320, 8);
    // EW step is larger than NS at high lat (cos(50°) ≈ 0.643).
    expect(s[3].lon - 7).toBeGreaterThan(s[1].lat - 50);
  });
});

describe('dem_producer — computeSlopePercent', () => {
  test('flat terrain → 0 %', () => {
    expect(dem.computeSlopePercent({ n: 100, s: 100, e: 100, w: 100 }, 30)).toBeCloseTo(0, 6);
  });

  test('uphill to north → positive percent, magnitude = (Δh) / (2·offset) · 100', () => {
    // 1 m rise over 60 m (2×30 m) → 1.6667 %
    const slope = dem.computeSlopePercent({ n: 101, s: 100, e: 100, w: 100 }, 30);
    expect(slope).toBeCloseTo(1 / 60 * 100, 4);
  });

  test('downhill to north → negative percent', () => {
    const slope = dem.computeSlopePercent({ n: 99, s: 100, e: 100, w: 100 }, 30);
    expect(slope).toBeLessThan(0);
    expect(slope).toBeCloseTo(-1 / 60 * 100, 4);
  });

  test('uses the steepest of NS / EW, preserving sign', () => {
    // EW gradient is steeper (3 m / 60 m) → +5 %.
    const slope = dem.computeSlopePercent({ n: 101, s: 100, e: 103, w: 100 }, 30);
    expect(slope).toBeCloseTo(3 / 60 * 100, 4);
  });

  test('returns undefined when any neighbour is missing', () => {
    expect(dem.computeSlopePercent({ n: 100, s: undefined, e: 100, w: 100 }, 30)).toBeUndefined();
  });
});

describe('dem_producer — buildDemDataset', () => {
  test('emits the schema consumed by loadDemProvider', () => {
    const points = [{ lat: 50.0, lon: 7.0 }, { lat: 50.1, lon: 7.1 }];
    // Per point: c, n, s, e, w
    const elevations = [
      // Point 0: flat
      100, 100, 100, 100, 100,
      // Point 1: 2 m rise to north over 60 m → +3.33 %
      200, 201, 199, 200, 200,
    ];
    const ds = dem.buildDemDataset(points, elevations, {
      extractDate: '2026-05-07',
      confidence: 'srtm-90m',
    });
    expect(ds.source).toBe('OpenMeteo SRTM');
    expect(ds.resolution_m).toBe(90);
    expect(ds.extractDate).toBe('2026-05-07');
    expect(ds.points).toHaveLength(2);
    expect(ds.points[0]).toEqual({
      lat: 50.0, lon: 7.0, elevation_m: 100, slope_percent: 0, confidence: 'srtm-90m',
    });
    expect(ds.points[1].lat).toBe(50.1);
    expect(ds.points[1].elevation_m).toBe(200);
    expect(ds.points[1].slope_percent).toBeCloseTo(2 / 60 * 100, 1);
    expect(ds.points[1].confidence).toBe('srtm-90m');
  });

  test('drops points with no centre elevation', () => {
    const points = [{ lat: 50, lon: 7 }];
    const ds = dem.buildDemDataset(points, [undefined, 100, 100, 100, 100], {});
    expect(ds.points).toEqual([]);
  });

  test('omits slope_percent when neighbour data is incomplete', () => {
    const points = [{ lat: 50, lon: 7 }];
    const ds = dem.buildDemDataset(points, [100, 100, undefined, 100, 100], {});
    expect(ds.points).toHaveLength(1);
    expect(ds.points[0].elevation_m).toBe(100);
    expect(ds.points[0].slope_percent).toBeUndefined();
  });

  test('passes through wayElevations untouched', () => {
    const ds = dem.buildDemDataset([], [], {
      wayElevations: { '42': { road_slope_percent: 1.7 } },
    });
    expect(ds.wayElevations).toEqual({ '42': { road_slope_percent: 1.7 } });
  });
});

describe('dem_producer — computeWayElevations', () => {
  test('skips spans below 5 m horizontal length', () => {
    const spans = [{
      wayId: '1',
      start: { lat: 50, lon: 7 },
      end:   { lat: 50.000001, lon: 7.000001 }, // ~0.15 m
    }];
    expect(dem.computeWayElevations(spans, [100], [101])).toEqual({});
  });

  test('computes mean grade in percent, signed end-minus-start', () => {
    const spans = [{
      wayId: '1',
      start: { lat: 50.0,    lon: 7.0 },
      end:   { lat: 50.0009, lon: 7.0 },  // ~100 m to the north
    }];
    // 5 m climb over ~100 m → +5 %
    const out = dem.computeWayElevations(spans, [100], [105]);
    expect(out['1'].road_slope_percent).toBeCloseTo(5, 1);
  });

  test('skips spans with missing elevation', () => {
    const spans = [{
      wayId: '1',
      start: { lat: 50.0,    lon: 7.0 },
      end:   { lat: 50.0009, lon: 7.0 },
    }];
    expect(dem.computeWayElevations(spans, [undefined], [105])).toEqual({});
  });
});

describe('dem_producer — readOsmWaySpans', () => {
  test('reads endpoints from wayGeometries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    try {
      fs.writeFileSync(path.join(tmp, 'osm_bonn.json'), JSON.stringify({
        ways: { '1': { highway: 'residential' } },
        wayGeometries: {
          '1': [{ lat: 50, lon: 7 }, { lat: 50.001, lon: 7.001 }],
        },
        index: [],
      }));
      const spans = dem.readOsmWaySpans(tmp, 'bonn');
      expect(spans).toHaveLength(1);
      expect(spans[0].wayId).toBe('1');
      expect(spans[0].start).toEqual({ lat: 50, lon: 7 });
      expect(spans[0].end).toEqual({ lat: 50.001, lon: 7.001 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns [] when the file or wayGeometries are missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    try {
      expect(dem.readOsmWaySpans(tmp, 'bonn')).toEqual([]);
      // File without wayGeometries (older OSM cache).
      fs.writeFileSync(path.join(tmp, 'osm_bonn.json'), JSON.stringify({ ways: {}, index: [] }));
      expect(dem.readOsmWaySpans(tmp, 'bonn')).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('dem_producer — fetchElevations retry policy', () => {
  test('retries on 429 then succeeds', async () => {
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elevation: [100, 200] }) };
    };
    const r = await dem.fetchElevations(
      [{ lat: 50, lon: 7 }, { lat: 51, lon: 8 }],
      { fetch: stubFetch, retries: 3, backoffMs: 1, rateLimitBackoffMs: 1, timeoutMs: 1000, batchSize: 100 },
    );
    expect(r).toEqual([100, 200]);
    expect(calls).toBe(2);
  });

  test('does NOT retry on non-429 4xx', async () => {
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({}) };
    };
    await expect(
      dem.fetchElevations([{ lat: 50, lon: 7 }], { fetch: stubFetch, retries: 3, backoffMs: 1, timeoutMs: 1000 }),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });

  test('honours Retry-After header on 429', async () => {
    const sleeps = [];
    const sleepStub = async (ms) => { sleeps.push(ms); };
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      if (calls < 2) {
        return {
          ok: false, status: 429,
          headers: { 'retry-after': '1' }, // 1 second
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, json: async () => ({ elevation: [42] }) };
    };
    const r = await dem.fetchElevations(
      [{ lat: 50, lon: 7 }],
      {
        fetch: stubFetch, retries: 3, backoffMs: 1, rateLimitBackoffMs: 50_000,
        timeoutMs: 1000, sleep: sleepStub,
      },
    );
    expect(r).toEqual([42]);
    // The pre-attempt sleep before the retry should be ~Retry-After (1000 ms),
    // not the 50 s rate-limit fallback.
    expect(sleeps).toEqual([1000]);
  });

  test('invokes onRateLimit callback exactly when a 429 fires', async () => {
    let hits = 0;
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elevation: [1] }) };
    };
    await dem.fetchElevations(
      [{ lat: 50, lon: 7 }],
      {
        fetch: stubFetch, retries: 3, backoffMs: 1, rateLimitBackoffMs: 1,
        timeoutMs: 1000, onRateLimit: () => { hits++; },
      },
    );
    expect(hits).toBe(1);
  });

  test('chunks into batchSize-sized requests', async () => {
    const calls = [];
    const stubFetch = async (url) => {
      calls.push(url);
      const lats = url.match(/latitude=([^&]+)/)[1].split(',');
      return { ok: true, status: 200, json: async () => ({ elevation: lats.map(Number) }) };
    };
    const samples = Array.from({ length: 5 }, (_, i) => ({ lat: 50 + i, lon: 7 }));
    const r = await dem.fetchElevations(samples, {
      fetch: stubFetch, retries: 0, backoffMs: 1, timeoutMs: 1000, batchSize: 2,
      interBatchDelayMs: 0,
    });
    expect(r).toHaveLength(5);
    expect(calls).toHaveLength(3); // 2 + 2 + 1
  });

  test('inserts interBatchDelayMs between sub-batches', async () => {
    const sleeps = [];
    const sleepStub = async (ms) => { sleeps.push(ms); };
    const stubFetch = async (url) => {
      const lats = url.match(/latitude=([^&]+)/)[1].split(',');
      return { ok: true, status: 200, json: async () => ({ elevation: lats.map(Number) }) };
    };
    const samples = Array.from({ length: 3 }, (_, i) => ({ lat: 50 + i, lon: 7 }));
    await dem.fetchElevations(samples, {
      fetch: stubFetch, retries: 0, backoffMs: 1, timeoutMs: 1000, batchSize: 1,
      interBatchDelayMs: 80, sleep: sleepStub,
    });
    // 3 batches → 2 inter-batch delays of exactly interBatchDelayMs.
    expect(sleeps).toEqual([80, 80]);
  });

  test('clamps batchSize to >= 1 to avoid an infinite loop', async () => {
    const calls = [];
    const stubFetch = async (url) => {
      calls.push(url);
      const lats = url.match(/latitude=([^&]+)/)[1].split(',');
      return { ok: true, status: 200, json: async () => ({ elevation: lats.map(Number) }) };
    };
    const samples = Array.from({ length: 3 }, (_, i) => ({ lat: 50 + i, lon: 7 }));
    // batchSize=0 would never advance the loop without clamping.
    const r = await dem.fetchElevations(samples, {
      fetch: stubFetch, retries: 0, backoffMs: 1, timeoutMs: 1000, batchSize: 0,
      interBatchDelayMs: 0,
    });
    expect(r).toHaveLength(3);
    // Falls back to default batch size (≥ 1), so all samples processed.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test('clamps negative retries to 0', async () => {
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    await expect(dem.fetchElevations(
      [{ lat: 50, lon: 7 }],
      { fetch: stubFetch, retries: -5, backoffMs: 1, timeoutMs: 1000, interBatchDelayMs: 0 },
    )).rejects.toThrow();
    // retries clamped to 0 → exactly one attempt, no retry loop.
    expect(calls).toBe(1);
  });

  test('concurrency>1 dispatches batches in parallel and preserves order', async () => {
    // Each batch waits ~50 ms before resolving. Sequentially, 4 batches
    // would take ~200 ms; with concurrency=4 they should overlap and
    // finish in ~50–80 ms. We mainly assert correctness here (order +
    // overlap), not exact timing, to avoid flaky CI.
    let inFlight = 0;
    let maxInFlight = 0;
    const stubFetch = async (url) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      const lats = url.match(/latitude=([^&]+)/)[1].split(',');
      return { ok: true, status: 200, json: async () => ({ elevation: lats.map(Number) }) };
    };
    const samples = Array.from({ length: 8 }, (_, i) => ({ lat: 50 + i, lon: 7 }));
    const r = await dem.fetchElevations(samples, {
      fetch: stubFetch, retries: 0, backoffMs: 1, timeoutMs: 1000,
      batchSize: 2, interBatchDelayMs: 0, concurrency: 4,
    });
    expect(r).toEqual(samples.map(s => s.lat));
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test('concurrency>1 surfaces the first batch error', async () => {
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      // Second batch always fails (non-retryable 4xx).
      if (calls === 2) return { ok: false, status: 400, json: async () => ({}) };
      const all = [10, 20];
      return { ok: true, status: 200, json: async () => ({ elevation: all }) };
    };
    const samples = Array.from({ length: 8 }, (_, i) => ({ lat: 50 + i, lon: 7 }));
    await expect(dem.fetchElevations(samples, {
      fetch: stubFetch, retries: 0, backoffMs: 1, timeoutMs: 1000,
      batchSize: 2, interBatchDelayMs: 0, concurrency: 4,
    })).rejects.toThrow(/HTTP 400/);
  });

  test('clamps concurrency to >= 1', async () => {
    const stubFetch = async (url) => {
      const lats = url.match(/latitude=([^&]+)/)[1].split(',');
      return { ok: true, status: 200, json: async () => ({ elevation: lats.map(Number) }) };
    };
    const samples = [{ lat: 50, lon: 7 }, { lat: 51, lon: 7 }];
    const r = await dem.fetchElevations(samples, {
      fetch: stubFetch, retries: 0, backoffMs: 1, timeoutMs: 1000,
      batchSize: 1, interBatchDelayMs: 0, concurrency: 0,
    });
    expect(r).toEqual([50, 51]);
  });
});

describe('dem_producer — fetchElevationsDedup', () => {
  test('collapses samples that share a quantised (lat,lon) cell', async () => {
    const seen = [];
    const fetchFn = async (unique) => {
      seen.push(unique.length);
      return unique.map((s) => 100 + s.lat); // deterministic
    };
    const samples = [
      { lat: 50.000001, lon: 7.0 }, // → 50.00000
      { lat: 50.000002, lon: 7.0 }, // → 50.00000 (same cell)
      { lat: 50.5,      lon: 7.0 }, // distinct
      { lat: 50.000001, lon: 7.0 }, // dup of #0
    ];
    const { elevations, uniqueCount } = await dem.fetchElevationsDedup(samples, fetchFn);
    // Only 2 unique cells were sent to the fetcher.
    expect(seen).toEqual([2]);
    expect(uniqueCount).toBe(2);
    // Outputs are index-aligned with the input array.
    expect(elevations).toHaveLength(samples.length);
    expect(elevations[0]).toBe(elevations[1]); // shared cell
    expect(elevations[3]).toBe(elevations[0]); // dup of #0
    expect(elevations[2]).not.toBe(elevations[0]);
  });

  test('throws if the underlying fetcher returns the wrong length', async () => {
    const fetchFn = async () => [1, 2, 3]; // wrong length on purpose
    await expect(dem.fetchElevationsDedup(
      [{ lat: 50, lon: 7 }, { lat: 51, lon: 7 }],
      fetchFn,
    )).rejects.toThrow(/expected 2 \(deduplicated\)/);
  });
});

describe('dem_producer — parseRetryAfterMs', () => {
  test('parses integer seconds', () => {
    expect(dem.parseRetryAfterMs('5')).toBe(5_000);
    expect(dem.parseRetryAfterMs('0')).toBeUndefined();
  });
  test('parses HTTP-date in the future, ignores past dates', () => {
    const future = new Date(Date.now() + 4_000).toUTCString();
    const parsed = dem.parseRetryAfterMs(future);
    expect(parsed).toBeGreaterThan(2_000);
    expect(parsed).toBeLessThanOrEqual(5_000);
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(dem.parseRetryAfterMs(past)).toBeUndefined();
  });
  test('caps absurd values to MAX_RATE_LIMIT_BACKOFF_MS', () => {
    expect(dem.parseRetryAfterMs('99999')).toBe(dem.MAX_RATE_LIMIT_BACKOFF_MS);
  });
  test('returns undefined on garbage / empty input', () => {
    expect(dem.parseRetryAfterMs(undefined)).toBeUndefined();
    expect(dem.parseRetryAfterMs(null)).toBeUndefined();
    expect(dem.parseRetryAfterMs('')).toBeUndefined();
    expect(dem.parseRetryAfterMs('not-a-date')).toBeUndefined();
  });
});

describe('dem_producer — isRateLimitError', () => {
  test('classifies HTTP 429 / fetch failed as rate-limit', () => {
    expect(dem.isRateLimitError(new Error('Elevation HTTP 429'))).toBe(true);
    expect(dem.isRateLimitError(new Error('fetch failed'))).toBe(true);
    const err = new Error('boom'); err.status = 429;
    expect(dem.isRateLimitError(err)).toBe(true);
  });
  test('does not misclassify other errors', () => {
    expect(dem.isRateLimitError(new Error('Elevation HTTP 500'))).toBe(false);
    expect(dem.isRateLimitError(null)).toBe(false);
  });
});

describe('dem_producer — produceCity (end-to-end with stubbed elevation provider)', () => {
  test('reads input geojson, queries elevation, writes dem_<slug>.json', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    const repoRoot = path.join(tmp, 'repo');
    const outDir   = path.join(tmp, 'out');
    fs.mkdirSync(path.join(repoRoot, 'out'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(fc([pt(1, 7.0, 50.0), pt(2, 7.0, 50.0)])), // dedup → 1 unique
    );

    try {
      // Stubbed elevation fetcher: flat 100 m everywhere.
      const r = await dem.produceCity(repoRoot, 'bonn', {
        outDir,
        fetchElevations: async (samples) => samples.map(() => 100),
      });
      expect(r.skipped).toBeFalsy();
      expect(r.counts.uniquePoints).toBe(1);
      expect(r.counts.withElevation).toBe(1);
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'dem_bonn.json'), 'utf8'));
      expect(written.source).toBe('OpenMeteo SRTM');
      expect(written.resolution_m).toBe(90);
      expect(written.points).toHaveLength(1);
      expect(written.points[0].elevation_m).toBe(100);
      expect(written.points[0].slope_percent).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips cleanly when input geojson is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    try {
      const r = await dem.produceCity(tmp, 'nowhere', {
        outDir: tmp,
        fetchElevations: async () => { throw new Error('should not be called'); },
      });
      expect(r.skipped).toBe(true);
      expect(r.reason).toMatch(/no input/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('resume: skips when dem_<slug>.json already exists in outDir', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    const repoRoot = path.join(tmp, 'repo');
    const outDir   = path.join(tmp, 'out');
    fs.mkdirSync(path.join(repoRoot, 'out'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(fc([pt(1, 7.0, 50.0)])),
    );
    fs.writeFileSync(path.join(outDir, 'dem_bonn.json'), '{"sentinel":true}');
    try {
      const r = await dem.produceCity(repoRoot, 'bonn', {
        outDir,
        fetchElevations: async () => { throw new Error('must not be called'); },
      });
      expect(r.skipped).toBe(true);
      expect(r.reason).toMatch(/already cached/);
      expect(JSON.parse(fs.readFileSync(path.join(outDir, 'dem_bonn.json'), 'utf8')))
        .toEqual({ sentinel: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('produceCity reports dedup counts and skips re-fetching shared neighbour cells', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    const repoRoot = path.join(tmp, 'repo');
    const outDir   = path.join(tmp, 'out');
    fs.mkdirSync(path.join(repoRoot, 'out'), { recursive: true });
    // Two accidents ~30 m apart along latitude — far enough that
    // `uniquePointsFromFeatureCollection` keeps both at 5 dp, but
    // close enough that pt2's centre coincides with pt1's north
    // neighbour (and vice versa for the south), so dedup must drop
    // those overlaps. Without dedup that's 2×5=10 samples; with dedup
    // it should drop noticeably.
    fs.writeFileSync(
      path.join(repoRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(fc([
        pt(1, 7.0, 50.0),
        pt(2, 7.0, 50.00027), // ~30 m north → overlaps neighbour cell
      ])),
    );
    try {
      let receivedSampleCount = 0;
      const r = await dem.produceCity(repoRoot, 'bonn', {
        outDir,
        fetchElevations: async (samples) => {
          receivedSampleCount = samples.length;
          return samples.map(() => 100);
        },
      });
      expect(r.skipped).toBeFalsy();
      // 2 unique points × 5 samples = 10 raw samples; dedup must drop
      // at least the duplicated centre, so unique < total.
      expect(r.counts.pointSamplesTotal).toBe(10);
      expect(r.counts.pointSamplesUnique).toBeLessThan(r.counts.pointSamplesTotal);
      expect(receivedSampleCount).toBe(r.counts.pointSamplesUnique);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('force: re-fetches even when dem_<slug>.json already exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    const repoRoot = path.join(tmp, 'repo');
    const outDir   = path.join(tmp, 'out');
    fs.mkdirSync(path.join(repoRoot, 'out'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(fc([pt(1, 7.0, 50.0)])),
    );
    fs.writeFileSync(path.join(outDir, 'dem_bonn.json'), '{"sentinel":true}');
    try {
      let called = 0;
      const r = await dem.produceCity(repoRoot, 'bonn', {
        outDir,
        force: true,
        fetchElevations: async (samples) => { called += 1; return samples.map(() => 100); },
      });
      expect(r.skipped).toBeFalsy();
      expect(called).toBeGreaterThan(0);
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'dem_bonn.json'), 'utf8'));
      expect(written.sentinel).toBeUndefined();
      expect(written.points[0].elevation_m).toBe(100);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('produced dem_<slug>.json is consumable by enrich_geojson loadDemProvider', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    const repoRoot = path.join(tmp, 'repo');
    const outDir   = path.join(tmp, 'out');
    fs.mkdirSync(path.join(repoRoot, 'out'), { recursive: true });
    const inputFc = fc([pt(1, 7.0, 50.0)]);
    fs.writeFileSync(
      path.join(repoRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(inputFc),
    );

    try {
      // 1 m climb to north → +1.667 %.  After dedup (5 dp ≈ 1.1 m) the
      // `role` metadata is stripped before the fetcher sees the
      // samples — the real Open-Meteo API only sees lat/lon, and the
      // dedup helper deliberately strips everything else so duplicate
      // (lat,lon) pairs collapse into a single request. Discriminate
      // by latitude instead, which is what the real API does.
      const fetchStub = async (samples) => samples.map((s) => {
        if (s.lat > 50) return 101; // north neighbour
        if (s.lat < 50) return 100; // south neighbour
        return 100;                 // centre / east / west
      });
      await dem.produceCity(repoRoot, 'bonn', { outDir, fetchElevations: fetchStub });

      // Now exercise the actual consumer.
      const enrich = require('../../scripts/enrich_geojson.js');
      const fcCopy = JSON.parse(JSON.stringify(inputFc));
      const prevEnv = process.env.ENRICH_DEM_DATA_DIR;
      process.env.ENRICH_DEM_DATA_DIR = outDir;
      try {
        const { meta } = enrich.enrichCity(fcCopy, 'bonn', {
          useOsm: false, useDem: true, useTraffic: false,
        });
        expect(meta.counts.withElevation).toBe(1);
        expect(fcCopy.features[0].properties.elevation_m).toBeDefined();
        expect(fcCopy.features[0].properties.slope_percent).toBeCloseTo(1.7, 0);
        expect(fcCopy.features[0].properties.slope_class).toBe('flat');
        expect(fcCopy.features[0].properties.slope_source).toBe('OpenMeteo SRTM');
      } finally {
        if (prevEnv === undefined) delete process.env.ENRICH_DEM_DATA_DIR;
        else process.env.ENRICH_DEM_DATA_DIR = prevEnv;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('dem_producer — parseArgs', () => {
  test('parses CLI flags, falls back to env / defaults', () => {
    const prev = process.env.ENRICH_DEM_DATA_DIR;
    process.env.ENRICH_DEM_DATA_DIR = '/tmp/x';
    try {
      const opts = dem.parseArgs(['--city', 'Bonn', '--osm-dir', '/tmp/osm', '--resolution', '30', '--source', 'DGM1']);
      expect(opts.cities).toEqual(['Bonn']);
      expect(opts.outDir).toBe('/tmp/x');
      expect(opts.osmDir).toBe('/tmp/osm');
      expect(opts.resolution_m).toBe(30);
      expect(opts.source).toBe('DGM1');
    } finally {
      if (prev === undefined) delete process.env.ENRICH_DEM_DATA_DIR;
      else process.env.ENRICH_DEM_DATA_DIR = prev;
    }
  });

  test('--force flips the resume guard off', () => {
    expect(dem.parseArgs([]).force).toBeFalsy();
    expect(dem.parseArgs(['--force']).force).toBe(true);
  });

  test('--concurrency parses into opts.concurrency', () => {
    expect(dem.parseArgs([]).concurrency).toBeUndefined();
    expect(dem.parseArgs(['--concurrency', '4']).concurrency).toBe(4);
  });
});

describe('dem_producer — produceCity honours --resolution / --source overrides', () => {
  test('writes resolution_m and source from opts into the dataset', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-prod-'));
    const repoRoot = path.join(tmp, 'repo');
    const outDir   = path.join(tmp, 'out');
    fs.mkdirSync(path.join(repoRoot, 'out'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(fc([pt(1, 7.0, 50.0)])),
    );

    try {
      await dem.produceCity(repoRoot, 'bonn', {
        outDir,
        resolution_m: 30,
        source: 'DGM1',
        fetchElevations: async (samples) => samples.map(() => 100),
      });
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'dem_bonn.json'), 'utf8'));
      expect(written.resolution_m).toBe(30);
      expect(written.source).toBe('DGM1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
