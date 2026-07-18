'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const generator = require('../../scripts/generate-context-city');
const preflight = require('../../scripts/check-enrichment-inputs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeStagedCity(staged, slug, prefix) {
  write(path.join(staged, `output_all_years_${slug}.geojson.gz`), `${prefix}-geo`);
  write(path.join(staged, `ways_${slug}.json.gz`), `${prefix}-ways`);
  write(path.join(staged, `output_all_years_${slug}.enrichment.meta.json.gz`), `${prefix}-meta`);
  write(path.join(staged, 'ctxtiles', slug, 'index.json.gz'), `${prefix}-index`);
  write(path.join(staged, 'ctxtiles', slug, '4200', '2750.json.gz'), `${prefix}-tile`);
}

describe('generate-context-city helpers', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-context-city-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('resolves only canonical cities from cities.txt', () => {
    write(path.join(root, 'cities.txt'), 'Bonn\nDüsseldorf\n');
    expect(generator.resolveCanonicalCity(root, 'bonn')).toEqual({ city: 'Bonn', slug: 'bonn' });
    expect(generator.resolveCanonicalCity(root, 'Düsseldorf')).toEqual({ city: 'Düsseldorf', slug: 'duesseldorf' });
    expect(() => generator.resolveCanonicalCity(root, 'Shell; rm -rf /')).toThrow(/Unknown city/);
  });

  test('gzipGeneratedTree compresses generated JSON and removes raw files', () => {
    const dir = path.join(root, 'out');
    const file = path.join(dir, 'ctxtiles', 'bonn', '1', '2.json');
    write(file, '{"ok":true}');
    generator.gzipGeneratedTree(dir);
    expect(fs.existsSync(file)).toBe(false);
    expect(JSON.parse(zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8'))).toEqual({ ok: true });
  });

  test('recognises only producer data with current version and matching input fingerprint', () => {
    const file = path.join(root, 'osm_bonn.json');
    const fingerprint = 'a'.repeat(64);
    write(file, JSON.stringify({
      producerVersion: preflight.CURRENT_PRODUCER_VERSIONS.osm,
      inputFingerprint: fingerprint,
      coverage: 'full',
      ways: { W1: {} },
      wayGeometries: { W1: [{ lat: 50, lon: 7 }, { lat: 50.1, lon: 7.1 }] },
      index: [],
    }));
    expect(generator.producerDatasetIsCurrent(file, preflight.validateOsm, fingerprint)).toBe(true);
    expect(generator.producerDatasetIsCurrent(file, preflight.validateOsm, 'b'.repeat(64))).toBe(false);
  });

  test('installs verified city files and replaces the tile directory', () => {
    const staged = path.join(root, 'staged');
    const out = path.join(root, 'out');
    makeStagedCity(staged, 'bonn', 'new');

    write(path.join(out, 'output_all_years_bonn.geojson'), 'stale-raw');
    write(path.join(out, 'ctxtiles', 'bonn', 'old.json.gz'), 'old-tile');

    generator.installGeneratedCity(staged, out, 'bonn');

    expect(fs.readFileSync(path.join(out, 'output_all_years_bonn.geojson.gz'), 'utf8')).toBe('new-geo');
    expect(fs.readFileSync(path.join(out, 'ways_bonn.json.gz'), 'utf8')).toBe('new-ways');
    expect(fs.existsSync(path.join(out, 'output_all_years_bonn.geojson'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'ctxtiles', 'bonn', 'old.json.gz'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'ctxtiles', 'bonn', 'index.json.gz'), 'utf8')).toBe('new-index');
  });

  test('rolls back the complete city dataset when a commit step fails', () => {
    const staged = path.join(root, 'staged');
    const out = path.join(root, 'out');
    makeStagedCity(staged, 'bonn', 'new');

    write(path.join(out, 'output_all_years_bonn.geojson.gz'), 'old-geo');
    write(path.join(out, 'ways_bonn.json.gz'), 'old-ways');
    write(path.join(out, 'output_all_years_bonn.enrichment.meta.json.gz'), 'old-meta');
    write(path.join(out, 'output_all_years_bonn.geojson'), 'old-raw');
    write(path.join(out, 'ctxtiles', 'bonn', 'index.json.gz'), 'old-index');
    write(path.join(out, 'ctxtiles', 'bonn', 'old.json.gz'), 'old-tile');

    expect(() => generator.installGeneratedCity(staged, out, 'bonn', {
      onCommitStep({ step }) {
        if (step === 2) throw new Error('synthetic rename failure');
      },
    })).toThrow(/synthetic rename failure/);

    expect(fs.readFileSync(path.join(out, 'output_all_years_bonn.geojson.gz'), 'utf8')).toBe('old-geo');
    expect(fs.readFileSync(path.join(out, 'ways_bonn.json.gz'), 'utf8')).toBe('old-ways');
    expect(fs.readFileSync(path.join(out, 'output_all_years_bonn.enrichment.meta.json.gz'), 'utf8')).toBe('old-meta');
    expect(fs.readFileSync(path.join(out, 'output_all_years_bonn.geojson'), 'utf8')).toBe('old-raw');
    expect(fs.readFileSync(path.join(out, 'ctxtiles', 'bonn', 'index.json.gz'), 'utf8')).toBe('old-index');
    expect(fs.readFileSync(path.join(out, 'ctxtiles', 'bonn', 'old.json.gz'), 'utf8')).toBe('old-tile');
    expect(fs.existsSync(path.join(out, 'ctxtiles', 'bonn', '4200', '2750.json.gz'))).toBe(false);
  });
});
