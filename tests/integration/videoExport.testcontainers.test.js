/**
 * Integration tests against a real Unfallwerkbank production container.
 *
 * The suite verifies both the video-export endpoint and the user-visible
 * context overlays. Browser assertions deliberately use DOM and canvas output;
 * private globals such as `window.map` are not part of the product contract.
 */
'use strict';

const fs = require('fs');
const {
  isDockerAvailable,
  startUnfallatlasContainer,
} = require('./lib/startUnfallatlasContainer');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const GIF_BUDGET_BYTES = 10 * 1024 * 1024;
const WEBP_BUDGET_BYTES = 18 * 1024 * 1024;
const APNG_BUDGET_BYTES = 30 * 1024 * 1024;
const CONTEXT_BROWSER_TIMEOUT_MS = 120_000;

const CONTEXT_BODY = Object.freeze({
  city: 'Hannover',
  ctxSlope: 'steep,very_steep',
  ctxTraffic: 'high,very_high',
  ctxOnlyMatched: '1',
  zoom: '13',
});

function dockerLikelyAvailable() {
  if (process.env.RUN_TESTCONTAINERS === '1') return true;
  if (process.env.DOCKER_HOST) return true;
  try { return fs.existsSync('/var/run/docker.sock'); } catch (_) { return false; }
}

const SUITE_DESCRIBE = dockerLikelyAvailable() ? describe : describe.skip;
if (SUITE_DESCRIBE === describe.skip) {
  console.warn(
    '[videoExport.testcontainers] Skipping suite — no Docker socket and DOCKER_HOST unset. ' +
    'Set RUN_TESTCONTAINERS=1 to force.'
  );
}

async function postExportVideo(baseUrl, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const body = { ...CONTEXT_BODY };
  if (opts.bodyFormat !== undefined) body.format = opts.bodyFormat;
  const url = new URL(`${baseUrl}/api/export-video`);
  if (opts.queryFormat !== undefined) url.searchParams.set('format', opts.queryFormat);
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    clearTimeout(timer);
  }
}

function deterministicContextFixture() {
  const common = {
    uart: '1', utyp1: '1', ulichtverh: '0', ustrzustand: '0',
    uwochentag: '2', umonat: '6', ujahr: '2024',
    istfuss: '0', istkrad: '0', istgkfz: '0', istsonstig: '0',
  };
  const feature = (id, lon, lat, properties) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id, ...common, ...properties },
  });

  return {
    geojson: {
      type: 'FeatureCollection',
      properties: {
        enrichmentDicts: {
          highway: ['residential', 'primary'],
          surface: ['asphalt'],
          cycleway: ['lane'],
        },
      },
      features: [
        feature('bonn-context-e2e-1', 7.1000, 50.7300, {
          ukategorie: '2', ustunde: '8', istrad: '1', istpkw: '1',
          matched_way_id: 'W1', road_context_source: 'osm',
          elevation_m: 104.2, slope_percent: 5.1, slope_abs_percent: 5.1,
          slope_class: 'moderate', slope_source: 'SRTM Local Tiles',
          slope_confidence: 'high', traffic_proxy_class: 'low',
        }),
        feature('bonn-context-e2e-2', 7.1040, 50.7320, {
          ukategorie: '3', ustunde: '17', istrad: '1', istpkw: '0',
          matched_way_id: 'W2', road_context_source: 'osm',
          elevation_m: 101.0, slope_percent: 1.2, slope_abs_percent: 1.2,
          slope_class: 'flat', slope_source: 'SRTM Local Tiles',
          slope_confidence: 'high', traffic_proxy_class: 'very_high',
        }),
      ],
    },
    ways: {
      schemaVersion: 2,
      ways: {
        W1: {
          highway: 0, maxspeed: 30, lanes: 2, surface: 0, cycleway: 0,
          road_slope_percent: 5.0, road_slope_class: 'moderate',
          road_slope_method: 'median_segments', road_slope_sample_count: 6,
          road_slope_confidence: 'high', traffic_volume_value: 800,
          traffic_volume_unit: 'DTV', traffic_volume_year: 2026,
          traffic_volume_source: 'OSM-highway-proxy', traffic_volume_confidence: 'low',
        },
        W2: {
          highway: 1, maxspeed: 50, lanes: 4, surface: 0,
          road_slope_percent: 1.2, road_slope_class: 'flat',
          road_slope_method: 'median_segments', road_slope_sample_count: 8,
          road_slope_confidence: 'high', traffic_volume_value: 18000,
          traffic_volume_unit: 'DTV', traffic_volume_year: 2026,
          traffic_volume_source: 'OSM-highway-proxy', traffic_volume_confidence: 'low',
        },
      },
      geometries: {
        W1: [50.7288, 7.0988, 50.7300, 7.1000, 50.7310, 7.1012],
        W2: [50.7310, 7.1025, 50.7320, 7.1040, 50.7330, 7.1055],
      },
    },
    meta: {
      schemaVersion: 2,
      enrichmentScriptVersion: 'integration-fixture',
      citySlug: 'bonn',
      generatedAt: '2026-07-18T00:00:00.000Z',
      sources: {
        osm: { source: 'OpenStreetMap integration fixture', producerVersion: '1.2.0', coverage: 'full' },
        dem: { source: 'SRTM Local Tiles', producerVersion: '1.1.0', resolutionM: 30 },
        traffic: { source: 'OSM-highway-proxy', producerVersion: '1.0.0', datasetVersion: '1.0.0' },
      },
      counts: {
        features: 2, matchedToWay: 2, withElevation: 2,
        withTrafficProxy: 2, ways: 2, wayGeometries: 2, fullWays: 0,
      },
    },
  };
}

async function installDeterministicContextFixture(container) {
  const fixture = deterministicContextFixture();
  const script = `
    const fs = require('fs');
    const path = require('path');
    const zlib = require('zlib');
    const fixture = ${JSON.stringify(fixture)};
    const out = '/app/out';
    fs.mkdirSync(out, { recursive: true });
    const write = (logicalName, value) => {
      const raw = path.join(out, logicalName);
      fs.rmSync(raw, { force: true });
      fs.rmSync(raw + '.gz', { force: true });
      fs.writeFileSync(
        raw + '.gz',
        zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 9, mtime: 0 })
      );
    };
    write('output_all_years_bonn.geojson', fixture.geojson);
    write('ways_bonn.json', fixture.ways);
    write('output_all_years_bonn.enrichment.meta.json', fixture.meta);
    fs.rmSync(path.join(out, 'ctxtiles', 'bonn'), { recursive: true, force: true });
    console.log(JSON.stringify({ installed: true, city: 'Bonn' }));
  `;
  const result = await container.exec(['node', '-e', script]);
  if (result.exitCode !== 0) {
    throw new Error(`Could not install context fixture: ${result.output}`);
  }
}

// Playwright serializes this function into the browser context. Keep it closed
// over browser globals and the documented UA.contextRoadLayer public API only;
// duplicating RGB literals here caused the integration contract to drift when
// the traffic palette was made more contrast-safe.
function browserPaletteCounter() {
  const parseHexColor = (value) => {
    const match = /^#([0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!match) return null;
    const rgb = Number.parseInt(match[1], 16);
    return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  };
  const roadLayer = window.UA && window.UA.contextRoadLayer;
  const paletteFrom = (colors) => Object.values(colors || {})
    .map(parseHexColor)
    .filter(Boolean);
  const slopePalette = paletteFrom(roadLayer && roadLayer.SLOPE_COLORS);
  for (const special of [
    roadLayer && roadLayer.SLOPE_LOW_CONFIDENCE_COLOR,
    roadLayer && roadLayer.SLOPE_NO_SIGNAL_COLOR,
  ]) {
    const parsed = parseHexColor(special);
    if (parsed) slopePalette.push(parsed);
  }
  const trafficPalette = paletteFrom(roadLayer && roadLayer.TRAFFIC_COLORS);
  const closeTo = (r, g, b, palette) => palette.some(([pr, pg, pb]) =>
    Math.abs(r - pr) <= 8 && Math.abs(g - pg) <= 8 && Math.abs(b - pb) <= 8
  );
  const counts = {
    canvases: 0,
    slopePixels: 0,
    trafficPixels: 0,
    slopePaletteSize: slopePalette.length,
    trafficPaletteSize: trafficPalette.length,
  };
  for (const canvas of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) continue;
    const style = getComputedStyle(canvas);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    let pixels;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) continue;
      pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (_) {
      continue;
    }
    counts.canvases += 1;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 80) continue;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (closeTo(r, g, b, slopePalette)) counts.slopePixels += 1;
      if (closeTo(r, g, b, trafficPalette)) counts.trafficPixels += 1;
    }
  }
  return counts;
}

function browserAssertionScript(city) {
  const safeCity = JSON.stringify(city);
  const counterSource = browserPaletteCounter.toString();
  return `
    const { chromium } = require('@playwright/test');
    const countPalettePixels = ${counterSource};

    (async () => {
      const city = ${safeCity};
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));

      const url = new URL('http://127.0.0.1:8000/werkbank_v2.html');
      url.searchParams.set('city', city);
      url.searchParams.set('mapLayer', 'slope,traffic');
      url.searchParams.set('showCluster', '0');
      url.searchParams.set('showHeatmap', '0');
      url.searchParams.set('showSchools', '0');
      url.searchParams.set('showKindergartens', '0');
      url.searchParams.set('showArgumentation', '0');
      if (city.toLowerCase() === 'bonn') {
        url.searchParams.set('centerLat', '50.731000');
        url.searchParams.set('centerLon', '7.102000');
        url.searchParams.set('zoom', '15');
      }

      const response = await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: ${CONTEXT_BROWSER_TIMEOUT_MS},
      });
      if (!response || !response.ok()) throw new Error('Werkbank HTML was not served successfully');

      await page.waitForFunction(() => {
        const slope = document.querySelector('input[data-context-overlay="slope"]');
        const traffic = document.querySelector('input[data-context-overlay="traffic"]');
        return slope && traffic && !slope.disabled && !traffic.disabled;
      }, null, { timeout: ${CONTEXT_BROWSER_TIMEOUT_MS} });

      const slope = page.locator('input[data-context-overlay="slope"]');
      const traffic = page.locator('input[data-context-overlay="traffic"]');
      if (!(await slope.isChecked())) await slope.check();
      if (!(await traffic.isChecked())) await traffic.check();

      const deadline = Date.now() + ${CONTEXT_BROWSER_TIMEOUT_MS};
      let result = null;
      while (Date.now() < deadline) {
        const counts = await page.evaluate(countPalettePixels);
        const legends = await page.locator('.context-road-legend:visible').allTextContents();
        result = {
          ...counts,
          legendCount: legends.length,
          legendText: legends.join(' ').replace(/\\s+/g, ' ').trim(),
        };
        if (result.slopePixels >= 20
            && result.trafficPixels >= 20
            && result.legendCount === 2
            && result.legendText.includes('Straßensteigung')
            && result.legendText.includes('Verkehrsbelastung')) {
          break;
        }
        await page.waitForTimeout(250);
      }

      result = result || { canvases: 0, slopePixels: 0, trafficPixels: 0, legendCount: 0, legendText: '' };
      result.city = city;
      result.pageErrors = pageErrors;
      console.log('CONTEXT_E2E_RESULT=' + JSON.stringify(result));
      await browser.close();

      const ok = result.canvases > 0
        && result.slopePixels >= 20
        && result.trafficPixels >= 20
        && result.legendCount === 2
        && result.legendText.includes('Straßensteigung')
        && result.legendText.includes('Verkehrsbelastung')
        && result.pageErrors.length === 0;
      if (!ok) {
        console.error('Visible context contract failed: ' + JSON.stringify(result));
        process.exit(2);
      }
    })().catch(error => {
      console.error(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
}

function parseBrowserResult(output) {
  const line = String(output || '').split(/\r?\n/)
    .find(entry => entry.startsWith('CONTEXT_E2E_RESULT='));
  return line ? JSON.parse(line.slice('CONTEXT_E2E_RESULT='.length)) : null;
}

SUITE_DESCRIBE('POST /api/export-video — testcontainers integration', () => {
  let handle = null;

  beforeAll(async () => {
    const probe = await isDockerAvailable();
    if (!probe.available) {
      throw new Error(
        `Docker daemon present but unreachable: ${probe.reason}. ` +
        'Either start Docker or unset RUN_TESTCONTAINERS / DOCKER_HOST.'
      );
    }
    handle = await startUnfallatlasContainer();
  }, 10 * 60 * 1000);

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  test.each([
    { request: {}, label: 'default', expectedContentType: /^image\/gif/i, expectedExt: 'gif', budget: GIF_BUDGET_BYTES },
    { request: { bodyFormat: 'gif' }, label: 'body:gif', expectedContentType: /^image\/gif/i, expectedExt: 'gif', budget: GIF_BUDGET_BYTES },
    { request: { bodyFormat: 'webp' }, label: 'body:webp', expectedContentType: /^image\/webp/i, expectedExt: 'webp', budget: WEBP_BUDGET_BYTES },
    { request: { bodyFormat: 'apng' }, label: 'body:apng', expectedContentType: /^image\/apng/i, expectedExt: 'apng', budget: APNG_BUDGET_BYTES },
    { request: { queryFormat: 'webp' }, label: 'query:webp', expectedContentType: /^image\/webp/i, expectedExt: 'webp', budget: WEBP_BUDGET_BYTES },
  ])('returns valid $expectedExt export ($label)', async ({ request, expectedContentType, expectedExt, budget }) => {
    const { status, contentType, body } = await postExportVideo(handle.baseUrl, request);
    expect(status).toBe(200);
    expect(contentType).toMatch(expectedContentType);
    expect(body.length).toBeGreaterThanOrEqual(50 * 1024);
    expect(body.length).toBeLessThanOrEqual(budget);

    if (expectedExt === 'gif') {
      expect(['GIF87a', 'GIF89a']).toContain(body.slice(0, 6).toString('ascii'));
      expect(body[body.length - 1]).toBe(0x3b);
    } else if (expectedExt === 'webp') {
      expect(body.slice(0, 4).toString('ascii')).toBe('RIFF');
      expect(body.slice(8, 12).toString('ascii')).toBe('WEBP');
      expect(body.includes(Buffer.from('VP8X', 'ascii'))).toBe(true);
      expect(body.includes(Buffer.from('ANIM', 'ascii'))).toBe(true);
    } else if (expectedExt === 'apng') {
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(body.subarray(0, 8).equals(pngSignature)).toBe(true);
      expect(body.includes(Buffer.from('acTL', 'ascii'))).toBe(true);
    }
  }, 6 * 60 * 1000);

  it('rejects unsupported export format', async () => {
    const { status, body } = await postExportVideo(handle.baseUrl, { bodyFormat: 'mp4' });
    const json = JSON.parse(body.toString('utf8'));
    expect(status).toBe(400);
    expect(json).toEqual(expect.objectContaining({ error: 'unsupported_format' }));
    expect(json.supportedFormats).toEqual(['gif', 'webp', 'apng']);
  }, 60 * 1000);

  it('renders slope and traffic context visibly in the production container', async () => {
    const requireShipped = process.env.CONTEXT_E2E_REQUIRE_SHIPPED === '1';
    const city = String(process.env.CONTEXT_E2E_CITY || 'Bonn').trim();
    if (!requireShipped) await installDeterministicContextFixture(handle.container);

    const execution = await handle.container.exec(['node', '-e', browserAssertionScript(city)]);
    const result = parseBrowserResult(execution.output);
    if (execution.exitCode !== 0) {
      throw new Error(
        `Context browser assertion failed (exit=${execution.exitCode}, shipped=${requireShipped}, city=${city}).\n` +
        execution.output
      );
    }

    expect(result).not.toBeNull();
    expect(result.city).toBe(city);
    expect(result.canvases).toBeGreaterThan(0);
    expect(result.slopePixels).toBeGreaterThanOrEqual(20);
    expect(result.trafficPixels).toBeGreaterThanOrEqual(20);
    expect(result.legendCount).toBe(2);
    expect(result.legendText).toMatch(/Straßensteigung/);
    expect(result.legendText).toMatch(/Verkehrsbelastung/);
    expect(result.pageErrors).toEqual([]);
  }, 3 * 60 * 1000);

  it('container logs stay free of export-video error marker', async () => {
    const logs = await handle.getLogs();
    expect(logs).not.toMatch(/\[export-video\] Fehler/);
  });
});
