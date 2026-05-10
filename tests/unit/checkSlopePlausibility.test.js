'use strict';

/**
 * Tests for scripts/check-slope-plausibility.js (PR-berlin-slope-qa).
 *
 * Covers: pass case, fail-on-very-steep, fail-on-flat-gentle, missing
 * meta, missing city in table (warning, not failure), and the
 * plausibility-table loader's tolerance of a missing/malformed file.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const checker = require('../../scripts/check-slope-plausibility.js');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slope-plaus-'));
}

function writeMeta(outDir, slug, slopeBlock) {
  fs.mkdirSync(outDir, { recursive: true });
  const meta = {
    schemaVersion: 3,
    citySlug: slug,
    slope: slopeBlock,
    tileIndexPath: `ctxtiles/${slug}/index.json`,
  };
  fs.writeFileSync(
    path.join(outDir, `output_all_years_${slug}.enrichment.meta.json`),
    JSON.stringify(meta)
  );
}

function writePlaus(file, table) {
  fs.writeFileSync(file, JSON.stringify(table));
}

describe('check-slope-plausibility — loadPlausibility', () => {
  test('returns ok=true and a non-empty cities map for a valid file', () => {
    const r = checker.loadPlausibility(path.resolve(__dirname, '../../scripts/slope-plausibility.json'));
    expect(r.ok).toBe(true);
    expect(r.cities.berlin).toEqual(expect.objectContaining({ maxVerySteepShare: expect.any(Number) }));
    expect(r._default).toEqual(expect.objectContaining({ maxVerySteepShare: expect.any(Number), minFlatGentleShare: expect.any(Number) }));
  });

  test('returns ok=false with permissive defaults when the file is missing', () => {
    const r = checker.loadPlausibility(path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.json'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read/);
    expect(r._default.maxVerySteepShare).toBe(30);
  });

  test('returns ok=false when the file is malformed JSON', () => {
    const tmp = mktmp();
    const f = path.join(tmp, 'bad.json');
    fs.writeFileSync(f, 'not-json');
    const r = checker.loadPlausibility(f);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid JSON/);
  });
});

describe('check-slope-plausibility — validateAll', () => {
  function setup(metas, plausTable) {
    const root = mktmp();
    const outDir = path.join(root, 'out');
    for (const [slug, slope] of Object.entries(metas)) {
      writeMeta(outDir, slug, slope);
    }
    const plausFile = path.join(root, 'slope-plausibility.json');
    writePlaus(plausFile, plausTable);
    return { root, plausFile };
  }

  test('passes when every city is within bounds', () => {
    const { root, plausFile } = setup({
      berlin:    { withSlope: 1000, classCounts: { flat: 600, gentle: 200, moderate: 100, steep: 80, very_steep: 20 }, verySteepShare: 2.0, flatGentleShare: 80.0 },
      stuttgart: { withSlope: 1000, classCounts: { flat: 200, gentle: 200, moderate: 200, steep: 250, very_steep: 150 }, verySteepShare: 15, flatGentleShare: 40 },
    }, {
      _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 },
      cities: {
        berlin:    { maxVerySteepShare: 5,  minFlatGentleShare: 60 },
        stuttgart: { maxVerySteepShare: 25, minFlatGentleShare: 25 },
      },
    });
    const r = checker.validateAll(root, { plausibilityFile: plausFile });
    expect(r.summary.failed).toBe(0);
    expect(r.summary.ok).toBe(2);
    expect(r.cities.every(c => c.ok)).toBe(true);
  });

  test('fails when verySteepShare exceeds the per-city upper bound', () => {
    const { root, plausFile } = setup({
      berlin: {
        withSlope: 1000,
        classCounts: { flat: 100, gentle: 100, moderate: 100, steep: 200, very_steep: 500 },
        verySteepShare: 50, flatGentleShare: 20,
      },
    }, {
      _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 },
      cities: { berlin: { maxVerySteepShare: 5, minFlatGentleShare: 60 } },
    });
    const r = checker.validateAll(root, { plausibilityFile: plausFile });
    expect(r.summary.failed).toBe(1);
    const berlin = r.cities.find(c => c.slug === 'berlin');
    expect(berlin.ok).toBe(false);
    expect(berlin.problems.join(' ')).toMatch(/verySteepShare=50% exceeds.*5%/);
  });

  test('fails when flatGentleShare is below the per-city lower bound', () => {
    const { root, plausFile } = setup({
      bremen: {
        withSlope: 1000,
        classCounts: { flat: 100, gentle: 100, moderate: 600, steep: 100, very_steep: 100 },
        verySteepShare: 10, flatGentleShare: 20,
      },
    }, {
      _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 },
      cities: { bremen: { maxVerySteepShare: 30, minFlatGentleShare: 60 } },
    });
    const r = checker.validateAll(root, { plausibilityFile: plausFile });
    expect(r.summary.failed).toBe(1);
    const bremen = r.cities.find(c => c.slug === 'bremen');
    expect(bremen.problems.join(' ')).toMatch(/flatGentleShare=20% below.*60%/);
  });

  test('skips cities without a slope block silently (still passes overall)', () => {
    const { root, plausFile } = setup({
      hannover: {},                                    // no withSlope → skip
      berlin:   { withSlope: 100, classCounts: { flat: 90, gentle: 5, moderate: 3, steep: 1, very_steep: 1 }, verySteepShare: 1, flatGentleShare: 95 },
    }, {
      _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 },
      cities: { berlin: { maxVerySteepShare: 5, minFlatGentleShare: 60 } },
    });
    const r = checker.validateAll(root, { plausibilityFile: plausFile });
    expect(r.summary.skippedNoSlope).toBe(1);
    expect(r.summary.failed).toBe(0);
    expect(r.cities.find(c => c.slug === 'berlin').ok).toBe(true);
  });

  test('emits a warning (not a failure) when a city is not listed in the table — falls back to _default', () => {
    const { root, plausFile } = setup({
      newcity: { withSlope: 100, classCounts: { flat: 50, gentle: 30, moderate: 10, steep: 5, very_steep: 5 }, verySteepShare: 5, flatGentleShare: 80 },
    }, {
      _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 },
      cities: { berlin: { maxVerySteepShare: 5, minFlatGentleShare: 60 } },
    });
    const r = checker.validateAll(root, { plausibilityFile: plausFile });
    expect(r.summary.skippedNoBounds).toBe(1);
    const c = r.cities.find(x => x.slug === 'newcity');
    expect(c.warnings.join(' ')).toMatch(/not listed/);
    expect(c.ok).toBe(true);                           // _default is permissive
  });

  test('falls back to _default and STILL fails when share exceeds the _default bound', () => {
    const { root, plausFile } = setup({
      newcity: { withSlope: 100, classCounts: { flat: 5, gentle: 5, moderate: 10, steep: 30, very_steep: 50 }, verySteepShare: 50, flatGentleShare: 10 },
    }, {
      _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 },
      cities: {},
    });
    const r = checker.validateAll(root, { plausibilityFile: plausFile });
    expect(r.summary.failed).toBe(1);
    const c = r.cities.find(x => x.slug === 'newcity');
    expect(c.problems.join(' ')).toMatch(/exceeds plausibility bound 30%/);
  });

  test('handles a missing meta sidecar gracefully (no crash, marked failed)', () => {
    const root = mktmp();
    const outDir = path.join(root, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'output_all_years_corrupt.enrichment.meta.json'), 'not json');
    const plausFile = path.join(root, 'p.json');
    writePlaus(plausFile, { _default: { maxVerySteepShare: 30, minFlatGentleShare: 30 }, cities: {} });
    const r = checker.validateAll(root, { plausibilityFile: plausFile });
    expect(r.summary.failed).toBe(1);
    expect(r.cities[0].problems[0]).toMatch(/unreadable|invalid JSON/);
  });

  test('returns a clean empty result when the out/ directory does not exist', () => {
    const root = mktmp();
    const r = checker.validateAll(root);
    expect(r.summary.total).toBe(0);
    expect(r.summary.failed).toBe(0);
    expect(r.cities).toEqual([]);
  });
});
