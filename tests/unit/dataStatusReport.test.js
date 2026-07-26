'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { extractAccidentYears } = require('../../scripts/build-static-data');
const {
  generateDataStatus,
  metadataDate,
  renderBadge,
  scanAccidentYears,
} = require('../../scripts/generate-data-status');

function writeGzipJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(JSON.stringify(value))));
}

describe('dataset status report', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-data-status-'));
    fs.mkdirSync(path.join(root, 'site', 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cities.txt'), 'Alpha\nBeta\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('extracts accident years while the canonical manifest already has the GeoJSON in memory', () => {
    expect(extractAccidentYears({
      type: 'FeatureCollection',
      features: [
        { properties: { UJAHR: 2024 } },
        { properties: { jahr: '2022' } },
        { properties: { year: 2024 } },
        { properties: { somethingElse: 2023 } },
      ],
    })).toEqual([2022, 2024]);
  });

  test('streams accident years as a backward-compatible fallback', async () => {
    const file = path.join(root, 'accidents.geojson.gz');
    writeGzipJson(file, {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { ujahr: 2022 }, geometry: null },
        { type: 'Feature', properties: { UJAHR: '2024' }, geometry: null },
      ],
    });
    await expect(scanAccidentYears(file)).resolves.toEqual([2022, 2024]);
  });

  test('writes five deterministic badges plus a detailed city matrix', async () => {
    writeGzipJson(path.join(root, 'site', 'out', 'output_all_years_alpha.geojson.gz'), {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { UJAHR: 2023 }, geometry: null },
        { type: 'Feature', properties: { UJAHR: 2024 }, geometry: null },
      ],
    });
    writeGzipJson(path.join(root, 'site', 'out', 'output_all_years_beta.geojson.gz'), {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { jahr: 2024 }, geometry: null }],
    });
    writeGzipJson(path.join(root, 'site', 'out', 'poi_alpha.geojson.gz'), {
      type: 'FeatureCollection',
      properties: { generatedAt: '2026-07-20T10:00:00Z' },
      features: [{ type: 'Feature', properties: { amenity: 'school' }, geometry: null }],
    });
    writeGzipJson(path.join(root, 'site', 'out', 'output_all_years_alpha.enrichment.meta.json.gz'), {
      schemaVersion: 3,
      generatedAt: '2026-07-21T08:00:00Z',
      sources: {
        osm: { source: 'OpenStreetMap', extractDate: '2026-07-19' },
        dem: { source: 'SRTM Local Tiles' },
        traffic: { source: 'OSM-highway-proxy' },
      },
      slope: { coveragePercent: 91.4 },
    });
    fs.writeFileSync(path.join(root, 'site', 'out', 'data-manifest.json'), JSON.stringify({
      schemaVersion: 2,
      dataMode: 'gzip-only',
      cities: {
        alpha: {
          accidents: {
            gzipPath: 'out/output_all_years_alpha.geojson.gz',
            features: 2,
            years: [2023, 2024],
          },
          poi: { gzipPath: 'out/poi_alpha.geojson.gz', features: 1 },
          enrichment: {
            metaPath: 'out/output_all_years_alpha.enrichment.meta.json.gz',
            hasSlope: true,
            hasTrafficProxy: true,
            contextTiles: 3,
          },
        },
        beta: {
          accidents: {
            gzipPath: 'out/output_all_years_beta.geojson.gz',
            features: 1,
            years: [2024],
          },
        },
      },
    }, null, 2));

    const status = await generateDataStatus({ root, site: 'site', cities: 'cities.txt' });
    expect(status.configuredCities).toBe(2);
    expect(status.families.accidents).toMatchObject({ present: 2, total: 2, level: 'success' });
    expect(status.families.accidents.message).toContain('bis 2024');
    expect(status.families.poi).toMatchObject({ present: 1, total: 2, level: 'warning' });
    expect(status.families.roads.message).toContain('2026-07-19');
    expect(status.families.slope.message).toContain('91,4 %');
    expect(status.families.traffic.message).toContain('OSM-Proxy');

    for (const name of ['accidents', 'poi', 'roads', 'slope', 'traffic']) {
      expect(fs.existsSync(path.join(root, 'site', 'status', `${name}.svg`))).toBe(true);
    }
    const firstBadge = fs.readFileSync(path.join(root, 'site', 'status', 'accidents.svg'), 'utf8');
    await generateDataStatus({ root, site: 'site', cities: 'cities.txt' });
    expect(fs.readFileSync(path.join(root, 'site', 'status', 'accidents.svg'), 'utf8')).toBe(firstBadge);

    const html = fs.readFileSync(path.join(root, 'site', 'data-status', 'index.html'), 'utf8');
    expect(html).toContain('Datenstatus der Unfallwerkbank');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('data-relative-date');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'site', 'data-status', 'status.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 1, configuredCities: 2 });
  });

  test('unknown timestamps remain explicit and badge text is XML-safe', () => {
    expect(metadataDate({ properties: {} })).toBeNull();
    const badge = renderBadge('Schulen & Kitas', 'Stand <unbekannt>', 'unknown');
    expect(badge).toContain('Schulen &amp; Kitas');
    expect(badge).toContain('Stand &lt;unbekannt&gt;');
    expect(badge).not.toContain('Stand <unbekannt>');
  });
});
