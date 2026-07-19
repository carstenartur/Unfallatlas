'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isAllowedDataRequestPath,
  normalizeRequestPath,
  resolveDataRoot,
} = require('../../server/lib/staticDataOverlay');

describe('mutable static data overlay confinement', () => {
  test.each([
    '/output_all_years_bonn.geojson.gz',
    '/poi_koeln.geojson.gz',
    '/ways_berlin.json.gz',
    '/output_all_years_bonn.enrichment.meta.json.gz',
    '/data-manifest.json',
    '/ctxtiles/bonn/index.json.gz',
    '/ctxtiles/bonn/4256/2751.json.gz',
    '/accidenttiles/bonn/13/4256/2751.json.gz',
  ])('allows the declared public data shape %s', requestPath => {
    expect(isAllowedDataRequestPath(requestPath)).toBe(true);
  });

  test.each([
    '/',
    '/qa/media-validation.json',
    '/.enrichment-size-baseline.json',
    '/package.json',
    '/../package.json',
    '/%2e%2e/package.json',
    '/ctxtiles/.git/config',
    '/ctxtiles/bonn/tmp.json',
    '/output_all_years_bonn.csv.gz',
    '/output_all_years_bonn.geojson.gz/extra',
    '/ways_bonn.json.gz?download=1',
    '/ways_bonn.json.gz\\..\\secret',
  ])('rejects undeclared, hidden, temporary or escaping data path %s', requestPath => {
    expect(isAllowedDataRequestPath(requestPath)).toBe(false);
  });

  test('normalization decodes once and rejects malformed or dot segments', () => {
    expect(normalizeRequestPath('/poi_bonn.geojson.gz')).toBe('poi_bonn.geojson.gz');
    expect(normalizeRequestPath('/%E0%A4%A')).toBeNull();
    expect(normalizeRequestPath('/ctxtiles/../secret')).toBeNull();
  });

  test('data root rejects filesystem/repository roots and accepts a dedicated directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-data-root-'));
    const dedicated = path.join(root, 'out');
    fs.mkdirSync(dedicated);
    try {
      expect(resolveDataRoot(root)).toBe(dedicated);
      expect(() => resolveDataRoot(root, path.parse(root).root)).toThrow(/Refusing unsafe/);
      expect(() => resolveDataRoot(root, root)).toThrow(/Refusing unsafe/);
      expect(() => resolveDataRoot(path.join(root, 'repository'), root)).toThrow(/Refusing unsafe/);

      const file = path.join(root, 'not-a-directory');
      fs.writeFileSync(file, 'x');
      expect(() => resolveDataRoot(root, file)).toThrow(/not a directory/);

      const linked = path.join(root, 'linked-data');
      fs.symlinkSync(dedicated, linked, 'dir');
      expect(() => resolveDataRoot(root, linked)).toThrow(/symbolic link/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
