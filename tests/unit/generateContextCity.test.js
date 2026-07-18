'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const generator = require('../../scripts/generate-context-city');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
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

  test('installs verified city files and replaces the tile directory', () => {
    const staged = path.join(root, 'staged');
    const out = path.join(root, 'out');
    write(path.join(staged, 'output_all_years_bonn.geojson.gz'), 'new-geo');
    write(path.join(staged, 'ways_bonn.json.gz'), 'new-ways');
    write(path.join(staged, 'output_all_years_bonn.enrichment.meta.json.gz'), 'new-meta');
    write(path.join(staged, 'ctxtiles', 'bonn', 'index.json.gz'), 'new-index');
    write(path.join(staged, 'ctxtiles', 'bonn', '4200', '2750.json.gz'), 'new-tile');

    write(path.join(out, 'output_all_years_bonn.geojson'), 'stale-raw');
    write(path.join(out, 'ctxtiles', 'bonn', 'old.json.gz'), 'old-tile');

    generator.installGeneratedCity(staged, out, 'bonn');

    expect(fs.readFileSync(path.join(out, 'output_all_years_bonn.geojson.gz'), 'utf8')).toBe('new-geo');
    expect(fs.readFileSync(path.join(out, 'ways_bonn.json.gz'), 'utf8')).toBe('new-ways');
    expect(fs.existsSync(path.join(out, 'output_all_years_bonn.geojson'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'ctxtiles', 'bonn', 'old.json.gz'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'ctxtiles', 'bonn', 'index.json.gz'), 'utf8')).toBe('new-index');
  });
});
