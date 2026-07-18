'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  buildCity,
  buildTilePlan,
  lonToTileX,
  latToTileY,
} = require('../../scripts/build-accident-tiles');

function point(id, lon, lat, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id, ...extra },
  };
}

function fixture() {
  return {
    type: 'FeatureCollection',
    properties: { enrichmentDicts: { highway: ['residential'] } },
    features: [
      point('a', 7.1000, 50.7300),
      point('b', 7.1010, 50.7310),
      point('c', 7.1800, 50.7800),
    ],
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'accident-tiles-'));
}

function writeSource(root, geojson = fixture()) {
  const input = path.join(root, 'input');
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(input, 'output_all_years_bonn.geojson'), JSON.stringify(geojson));
  return input;
}

function readGzipJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

function listFiles(root) {
  const result = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else result.push(path.relative(root, absolute).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return result.sort();
}

describe('build-accident-tiles', () => {
  test('groups every point into deterministic gzip-only z/x/y tiles', () => {
    const root = tempRoot();
    const inputDir = writeSource(root);
    const outputDir = path.join(root, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const result = buildCity({ city: 'Bonn', inputDir, outputDir, zoom: 13 });
    expect(result.featureCount).toBe(3);
    expect(result.tileCount).toBeGreaterThan(1);
    expect(result.explicitIdCount).toBe(3);
    expect(result.derivedIdCount).toBe(0);

    const cityDir = path.join(outputDir, 'accidenttiles', 'bonn');
    const files = listFiles(cityDir);
    expect(files).toContain('index.json.gz');
    expect(files.every(file => file.endsWith('.gz'))).toBe(true);

    const manifest = readGzipJson(path.join(cityDir, 'index.json.gz'));
    expect(manifest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      city: 'bonn',
      z: 13,
      totalCount: 3,
    }));
    expect(manifest.tiles.reduce((sum, tile) => sum + tile.count, 0)).toBe(3);

    for (const tile of manifest.tiles) {
      const payload = readGzipJson(path.join(cityDir, '13', String(tile.x), `${tile.y}.json.gz`));
      expect(payload.type).toBe('FeatureCollection');
      expect(payload.features).toHaveLength(tile.count);
      expect(payload.properties).toEqual(fixture().properties);
    }
  });

  test('produces byte-identical gzip output for the same input', () => {
    const root = tempRoot();
    const inputDir = writeSource(root);
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });

    buildCity({ city: 'Bonn', inputDir, outputDir: first, zoom: 13 });
    buildCity({ city: 'Bonn', inputDir, outputDir: second, zoom: 13 });

    const firstRoot = path.join(first, 'accidenttiles', 'bonn');
    const secondRoot = path.join(second, 'accidenttiles', 'bonn');
    expect(listFiles(firstRoot)).toEqual(listFiles(secondRoot));
    for (const file of listFiles(firstRoot)) {
      expect(fs.readFileSync(path.join(firstRoot, file)))
        .toEqual(fs.readFileSync(path.join(secondRoot, file)));
    }
  });

  test('rejects duplicate identities before replacing an existing city tree', () => {
    const root = tempRoot();
    const duplicate = fixture();
    duplicate.features[1].properties.id = 'a';
    const inputDir = writeSource(root, duplicate);
    const outputDir = path.join(root, 'output');
    const existing = path.join(outputDir, 'accidenttiles', 'bonn');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'sentinel.txt'), 'keep');

    expect(() => buildCity({ city: 'Bonn', inputDir, outputDir, zoom: 13 }))
      .toThrow(/duplicate feature identity/);
    expect(fs.readFileSync(path.join(existing, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  test('rolls back the previous city tree when installation fails', () => {
    const root = tempRoot();
    const inputDir = writeSource(root);
    const outputDir = path.join(root, 'output');
    const existing = path.join(outputDir, 'accidenttiles', 'bonn');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'sentinel.txt'), 'previous');

    expect(() => buildCity({
      city: 'Bonn', inputDir, outputDir, zoom: 13,
      hooks: { beforeInstall: () => { throw new Error('synthetic install failure'); } },
    })).toThrow(/synthetic install failure/);
    expect(fs.readFileSync(path.join(existing, 'sentinel.txt'), 'utf8')).toBe('previous');
  });

  test('slippy coordinate helpers match the generated plan', () => {
    const geojson = fixture();
    const plan = buildTilePlan(geojson, 'Bonn', 13);
    const [lon, lat] = geojson.features[0].geometry.coordinates;
    expect(plan.tiles.some(tile => tile.x === lonToTileX(lon, 13)
      && tile.y === latToTileY(lat, 13))).toBe(true);
  });
});
