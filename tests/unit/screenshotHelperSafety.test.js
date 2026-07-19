'use strict';

const fs = require('fs');
const path = require('path');

function loadWaitForMapTiles() {
  const source = fs
    .readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8')
    .replace(/\bexport\s+/g, '');
  return new Function(`${source}\nreturn waitForMapTiles;`)();
}

function loadAssertScreenshotSnapshot() {
  const source = fs
    .readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8')
    .replace(/\bexport\s+/g, '');
  return new Function(`${source}\nreturn assertScreenshotSnapshot;`)();
}

function loadAssertStableScreenshotSnapshot() {
  const source = fs
    .readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8')
    .replace(/\bexport\s+/g, '');
  return new Function(`${source}\nreturn assertStableScreenshotSnapshot;`)();
}

describe('screenshot map-readiness helper', () => {
  const waitForMapTiles = loadWaitForMapTiles();

  test('fails closed when the public UA helper returns false', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        available: true,
        ok: false,
        lifecycle: { status: 'rendering' },
      }),
      waitForFunction: jest.fn(),
      waitForTimeout: jest.fn(),
    };

    await expect(waitForMapTiles(page, 1234)).rejects.toThrow(
      'UA.waitForMapFullyRendered returned false'
    );
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  test('fails closed when the public UA helper throws', async () => {
    const page = {
      evaluate: jest.fn()
        .mockRejectedValueOnce(new Error('context tile failed'))
        .mockResolvedValueOnce({ lifecycle: { status: 'rendering' }, tileImages: 1 }),
      waitForFunction: jest.fn(),
      waitForTimeout: jest.fn(),
    };

    await expect(waitForMapTiles(page, 1234)).rejects.toThrow(
      'UA.waitForMapFullyRendered failed: context tile failed'
    );
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  test('uses the DOM fallback only when the UA API is absent', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({ available: false }),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };

    await expect(waitForMapTiles(page, 1234)).resolves.toBeUndefined();
    expect(page.waitForFunction).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).toHaveBeenCalledWith(250);
  });

  test('requires at least one decoded tile from the UA helper', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8');
    expect(source).toMatch(/waitForMapFullyRendered\(map,\s*\{[\s\S]*?minTileImages:\s*1/);
  });

  test('refuses evidence for an empty accident-data snapshot', () => {
    const assertScreenshotSnapshot = loadAssertScreenshotSnapshot();
    const emptySnapshot = {
      status: 'ready',
      counts: { loaded: 0, filtered: 0, viewport: 0 },
      coverage: { complete: true },
      render: { revision: 1, completedRevision: 1, submitted: true, layers: {} },
    };

    expect(() => assertScreenshotSnapshot(emptySnapshot)).toThrow(
      'requires non-empty accident data'
    );
  });

  test('requires the requested city and a painted heatmap layer', () => {
    const assertScreenshotSnapshot = loadAssertScreenshotSnapshot();
    const snapshot = {
      status: 'ready',
      city: 'Bonn',
      counts: { loaded: 5, filtered: 4, viewport: 3 },
      coverage: { complete: true },
      render: {
        revision: 2,
        completedRevision: 2,
        submitted: true,
        layers: { heatmap: { requested: true, complete: true, visible: 3, painted: false } },
      },
    };

    expect(() => assertScreenshotSnapshot(snapshot, { city: 'Hannover' })).toThrow(
      'expected city Hannover, got Bonn'
    );
    expect(() => assertScreenshotSnapshot(snapshot, { city: 'Bonn', layers: ['heatmap'] })).toThrow(
      'requires visible completed layer heatmap'
    );
  });

  test('binds evidence to screenshot, build and data fingerprints', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8');
    expect(source).toContain("'_site', 'build-manifest.json'");
    expect(source).toMatch(/createHash\('sha256'\)[\s\S]*imageBytes/);
    expect(source).toContain('dataFingerprint: buildManifest.data.fingerprint');
    expect(source).toContain("'out', 'qa', 'screenshot-readiness'");
  });

  test('rejects a lifecycle revision change across pixel capture', () => {
    const assertStableScreenshotSnapshot = loadAssertStableScreenshotSnapshot();
    const snapshot = {
      status: 'ready', city: 'Bonn',
      counts: { loaded: 5, filtered: 4, viewport: 3 },
      coverage: { complete: true },
      render: {
        revision: 2, completedRevision: 2, submitted: true,
        layers: { cluster: { requested: true, complete: true, visible: 3 } },
      },
    };
    const changed = JSON.parse(JSON.stringify(snapshot));
    changed.render.revision = 3;
    changed.render.completedRevision = 3;

    expect(() => assertStableScreenshotSnapshot(snapshot, changed, {
      city: 'Bonn', layers: ['cluster']
    })).toThrow('lifecycle changed while pixels were captured');
  });

  test('publishes pixels atomically only after repeated lifecycle quiescence', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8');
    expect(source).toContain('stableObservations < 2');
    expect(source).toContain('for (let attempt = 1; attempt <= 3; attempt += 1)');
    expect(source).toContain('capture-${process.pid}-${Date.now()}');
    expect(source).toContain('await fs.rename(temporaryPath, options.path)');
    expect(source.indexOf('assertStableScreenshotSnapshot(beforeCapture, afterCapture'))
      .toBeLessThan(source.indexOf('await fs.rename(temporaryPath, options.path)'));
  });

  test('routes every canonical map screenshot through repository-owned SVG tiles', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../e2e/screenshots.spec.js'), 'utf8');
    const beforeEachBindings = source.match(/test\.beforeEach\([\s\S]*?setupDeterministicBasemapTiles\([\s\S]*?\n\s*\}\);/g) || [];
    expect(beforeEachBindings).toHaveLength(2);
    expect(source).toContain("tests/e2e/fixtures/map-tiles/standard.svg");
    expect(source).toContain("tests/e2e/fixtures/map-tiles/orthophoto.svg");
    expect(source).toContain("tests/e2e/fixtures/map-tiles/labels.svg");
    expect(source).toContain('tile\\.openstreetmap\\.org');
    expect(source).toContain('basemaps\\.cartocdn\\.com');
    expect(source).toContain('tests/e2e/fixtures/network/nominatim-reverse-bonn.json');
    expect(source).toContain('tests/e2e/fixtures/network/nominatim-reverse-hannover.json');
    expect(source).toContain('tests/e2e/fixtures/network/overpass-bonn.json');
    expect(source).toContain('tests/e2e/fixtures/network/overpass-hannover.json');
    expect(source).toContain('classifyNominatimFixture(request.url())');
    expect(source).toContain('request.postDataBuffer() || request.postData()');
    expect(source).not.toContain('route.continue()');
    expect(source).toContain("route.abort('blockedbyclient')");
    expect(source.match(/test\.afterEach\([\s\S]*?assertNoUnexpectedExternalRequests\(page\)/g)).toHaveLength(2);
  });
});
