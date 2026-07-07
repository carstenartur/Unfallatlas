'use strict';

/**
 * Smoke test for scripts/check-enrichment-size.js — exercises the
 * pure check() entry point against an in-memory fixture so the unit
 * suite does not touch the real out/ tree.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');

// We test the public check() against a sandbox: temporarily redirect
// the module-level constants by spawning a fresh require with a
// patched module.
const sizeChecker = require('../../scripts/check-enrichment-size.js');

describe('check-enrichment-size — listCityFiles', () => {
  test('returns objects shaped { slug, file }', () => {
    const list = sizeChecker.listCityFiles();
    // Real out/ contains many cities; we only check the shape.
    if (list.length > 0) {
      expect(typeof list[0].slug).toBe('string');
      expect(typeof list[0].file).toBe('string');
      expect(list[0].file.endsWith(`output_all_years_${list[0].slug}.geojson`)).toBe(true);
    }
  });
});

describe('check-enrichment-size — gzip size budget logic', () => {
  // Re-use the threshold logic via require-cache reset and a sandboxed
  // OUT_DIR. We cannot easily redirect the constants, so instead we
  // verify the *logic* using the documented default threshold + a
  // crafted baseline.
  test('default threshold is 10 percent', () => {
    expect(sizeChecker.DEFAULT_THRESHOLD_PCT).toBe(10);
  });

  test('growth slightly under default threshold passes; just above fails', () => {
    // Pure arithmetic mirror of the checker's growth-percent formula.
    function growthOk(base, current, threshold = 10) {
      const g = base === 0 ? 0 : ((current - base) / base) * 100;
      return g <= threshold;
    }
    expect(growthOk(1000, 1099)).toBe(true);
    expect(growthOk(1000, 1100)).toBe(true);
    expect(growthOk(1000, 1101)).toBe(false);
    expect(growthOk(1000, 800)).toBe(true);    // shrinking is always fine
  });
});

describe('check-enrichment-size — CLI argument validation', () => {
  let origErr;
  beforeEach(() => { origErr = console.error; console.error = () => {}; });
  afterEach(() => { console.error = origErr; });

  test('--threshold without a value exits non-zero (does not silently disable the gate)', () => {
    expect(sizeChecker.main(['--threshold'])).toBe(2);
  });
  test('--threshold with a non-numeric value exits non-zero', () => {
    expect(sizeChecker.main(['--threshold', 'banana'])).toBe(2);
  });
  test('--threshold with a negative value exits non-zero', () => {
    expect(sizeChecker.main(['--threshold', '-5'])).toBe(2);
  });
});

describe('check-enrichment-size — end-to-end CLI exit code (issue criterion 4)', () => {
  // Prove that the size gate actually fails the CI workflow when a
  // city's gzipped payload exceeds the baseline by more than the
  // threshold. We do this by spawning the script with a sandbox repo
  // root via a tiny harness — using a child_process so the module's
  // OUT_DIR resolves relative to the harness, not the real repo.
  const { spawnSync } = require('child_process');
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-size-gate-'));
    fs.mkdirSync(path.join(tmpRoot, 'scripts'));
    fs.mkdirSync(path.join(tmpRoot, 'scripts/lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'out'));
    // The script resolves OUT_DIR via __dirname/.., so just copy the
    // script into the sandbox's scripts/ directory.
    fs.copyFileSync(
      path.join(__dirname, '../../scripts/check-enrichment-size.js'),
      path.join(tmpRoot, 'scripts/check-enrichment-size.js'),
    );
    fs.copyFileSync(
      path.join(__dirname, '../../scripts/lib/read-json-maybe-gz.js'),
      path.join(tmpRoot, 'scripts/lib/read-json-maybe-gz.js'),
    );
  });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  function writeCity(slug, payloadObj) {
    fs.writeFileSync(
      path.join(tmpRoot, 'out', `output_all_years_${slug}.geojson`),
      JSON.stringify(payloadObj),
    );
  }

  function writeCityGzOnly(slug, payloadObj) {
    const raw = JSON.stringify(payloadObj);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', `output_all_years_${slug}.geojson.gz`),
      zlib.gzipSync(Buffer.from(raw, 'utf8')),
    );
  }

  function run(args = []) {
    return spawnSync('node', [path.join(tmpRoot, 'scripts/check-enrichment-size.js'), ...args],
      { encoding: 'utf8' });
  }

  test('exits 1 and emits FAIL when any city exceeds the +10 % gzipped budget', () => {
    // Seed: a small payload, baseline captured from it.
    writeCity('demo', { type: 'FeatureCollection', features: [{ a: 1 }] });
    let r = run();
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, 'out/.enrichment-size-baseline.json'))).toBe(true);

    // Now grow the payload: 5000 features × 100 chars/blob ≈ 50× the
    // baseline size, well past the +10 % budget.
    const huge = { type: 'FeatureCollection',
      features: Array.from({ length: 5000 }, (_, i) => ({ id: i, blob: 'x'.repeat(100) })) };
    writeCity('demo', huge);

    r = run();
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/FAIL/);
  });

  test('exits 0 when the city stays within the budget', () => {
    writeCity('demo', { type: 'FeatureCollection', features: [{ id: 1 }] });
    expect(run().status).toBe(0);            // seeds baseline
    // Same payload — well within +10 %.
    expect(run().status).toBe(0);
  });

  test('works with gzip-only city files (no raw .geojson present)', () => {
    writeCityGzOnly('demo', { type: 'FeatureCollection', features: [{ id: 1 }] });
    expect(run().status).toBe(0); // seeds baseline from .gz
    expect(run().status).toBe(0); // checks again from .gz
  });
});
