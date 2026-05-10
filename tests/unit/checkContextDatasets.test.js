'use strict';

/**
 * Tests for scripts/check-context-datasets.js — the build-time validator
 * that catches the original "Bielefeld + mapLayer=slope shows empty
 * legend / empty tile index" class of bugs before they ship.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { validateAll } = require('../../scripts/check-context-datasets.js');

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

// Build a complete, internally consistent v3 city dataset on disk so
// the happy path can isolate exactly which invariant is being broken
// in each negative test below.
function writeGoodCity(repoRoot, slug) {
  const outDir = path.join(repoRoot, 'out');
  const baseDir = path.join(outDir, 'ctxtiles', slug);
  // Two tiles, each with one way; manifest references both.
  writeJson(path.join(baseDir, '100', '200.json'), {
    schemaVersion: 3,
    ways: { W1: { highway: 0 } },
    geometries: { W1: [50, 7, 50.001, 7.001] },
  });
  writeJson(path.join(baseDir, '101', '200.json'), {
    schemaVersion: 3,
    ways: { W2: { highway: 0 } },
    geometries: { W2: [50.01, 7.01, 50.02, 7.02] },
  });
  writeJson(path.join(baseDir, 'index.json'), {
    schemaVersion: 3,
    citySlug: slug,
    tileScheme: 'slippy-z13',
    coverage: 'full',
    z: 13,
    tiles: [
      { x: 100, y: 200, wayCount: 1, bytes: 50 },
      { x: 101, y: 200, wayCount: 1, bytes: 50 },
    ],
    bbox: [7, 50, 7.1, 50.1],
    wayIndex: { W1: [100, 200], W2: [101, 200] },
    dicts: { highway: ['residential'] },
    generatedAt: '2026-01-01T00:00:00Z',
  });
  writeJson(path.join(outDir, `ways_${slug}.json`), {
    schemaVersion: 3,
    coverage: 'full',
    tileIndexUrl: `out/ctxtiles/${slug}/index.json`,
    generatedAt: '2026-01-01T00:00:00Z',
  });
  writeJson(path.join(outDir, `output_all_years_${slug}.enrichment.meta.json`), {
    schemaVersion: 3,
    citySlug: slug,
    generatedAt: '2026-01-01T00:00:00Z',
    sources: { osm: { source: 'OSM', producerVersion: '1.2.0' } },
    counts: { features: 2, contextTiles: 2 },
    tileIndexPath: `ctxtiles/${slug}/index.json`,
  });
}

describe('check-context-datasets', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxval-')); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('passes for a fully consistent v3 city', () => {
    writeGoodCity(tmpRoot, 'goodcity');
    const r = validateAll(tmpRoot);
    expect(r.summary.total).toBe(1);
    expect(r.summary.failed).toBe(0);
    expect(r.cities[0]).toEqual({ slug: 'goodcity', ok: true, problems: [] });
  });

  test('skips non-v3 cities (legacy v1/v2 ways files have no tileIndexPath)', () => {
    writeJson(path.join(tmpRoot, 'out', 'output_all_years_legacy.enrichment.meta.json'), {
      schemaVersion: 2,
      citySlug: 'legacy',
      generatedAt: '2026-01-01T00:00:00Z',
      sources: {},
    });
    const r = validateAll(tmpRoot);
    expect(r.summary.total).toBe(0);
    expect(r.summary.skippedNonV3).toBe(1);
  });

  test('fails when the tile index is missing (root cause of "alte Datenversion")', () => {
    writeGoodCity(tmpRoot, 'broken');
    fs.unlinkSync(path.join(tmpRoot, 'out', 'ctxtiles', 'broken', 'index.json'));
    const r = validateAll(tmpRoot);
    expect(r.cities[0].ok).toBe(false);
    expect(r.cities[0].problems.join('\n')).toMatch(/tile index missing/);
  });

  test('fails when the tile index has zero tiles (would render an empty slope layer)', () => {
    writeGoodCity(tmpRoot, 'empty');
    const indexFile = path.join(tmpRoot, 'out', 'ctxtiles', 'empty', 'index.json');
    const m = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    m.tiles = [];
    fs.writeFileSync(indexFile, JSON.stringify(m));
    const r = validateAll(tmpRoot);
    expect(r.cities[0].ok).toBe(false);
    expect(r.cities[0].problems.join('\n')).toMatch(/no tiles/);
  });

  test('fails when the tile index is missing the dicts block (slope classifier returns null)', () => {
    writeGoodCity(tmpRoot, 'nodicts');
    const indexFile = path.join(tmpRoot, 'out', 'ctxtiles', 'nodicts', 'index.json');
    const m = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    delete m.dicts;
    fs.writeFileSync(indexFile, JSON.stringify(m));
    const r = validateAll(tmpRoot);
    expect(r.cities[0].ok).toBe(false);
    expect(r.cities[0].problems.join('\n')).toMatch(/dicts/);
  });

  test('fails when a referenced tile file is missing on disk', () => {
    writeGoodCity(tmpRoot, 'misstile');
    fs.unlinkSync(path.join(tmpRoot, 'out', 'ctxtiles', 'misstile', '101', '200.json'));
    const r = validateAll(tmpRoot);
    expect(r.cities[0].ok).toBe(false);
    expect(r.cities[0].problems.join('\n')).toMatch(/tile file\(s\) missing/);
  });

  test('fails when the companion ways envelope and the meta sidecar disagree on the index path', () => {
    writeGoodCity(tmpRoot, 'mismatch');
    const waysFile = path.join(tmpRoot, 'out', 'ways_mismatch.json');
    const w = JSON.parse(fs.readFileSync(waysFile, 'utf8'));
    w.tileIndexUrl = 'out/ctxtiles/somewhere-else/index.json';
    fs.writeFileSync(waysFile, JSON.stringify(w));
    const r = validateAll(tmpRoot);
    expect(r.cities[0].ok).toBe(false);
    expect(r.cities[0].problems.join('\n')).toMatch(/tileIndexUrl resolves to/);
  });

  test('fails when the companion ways envelope is not v3 while the meta sidecar declares v3', () => {
    writeGoodCity(tmpRoot, 'wrongver');
    const waysFile = path.join(tmpRoot, 'out', 'ways_wrongver.json');
    fs.writeFileSync(waysFile, JSON.stringify({
      schemaVersion: 2, ways: {}, geometries: {},
    }));
    const r = validateAll(tmpRoot);
    expect(r.cities[0].ok).toBe(false);
    expect(r.cities[0].problems.join('\n')).toMatch(/schemaVersion is 2, expected 3/);
  });
});
