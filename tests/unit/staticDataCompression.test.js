'use strict';

/**
 * tests/unit/staticDataCompression.test.js
 *
 * Unit tests for scripts/lib/static-data-compression.js
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  compressArtifact,
  compressArtifacts,
  writeJsonArtifact,
  writeTextArtifact,
  DEFAULT_MAX_RAW_BYTES,
  DETERMINISTIC_MTIME,
} = require('../../scripts/lib/static-data-compression');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ua-compress-test-'));
}

function writeFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
  return abs;
}

function readGz(gzPath) {
  const buf = fs.readFileSync(gzPath);
  return zlib.gunzipSync(buf).toString('utf8');
}

// ---------------------------------------------------------------------------
// compressArtifact
// ---------------------------------------------------------------------------

describe('compressArtifact', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('creates a .gz file next to the source', () => {
    const src = writeFile(dir, 'out/ways_bonn.json', JSON.stringify({ schemaVersion: 2 }));
    compressArtifact(src, { root: dir });
    expect(fs.existsSync(`${src}.gz`)).toBe(true);
  });

  test('gzip output decompresses to original content', () => {
    const content = JSON.stringify({ type: 'FeatureCollection', features: [] });
    const src = writeFile(dir, 'out/data.geojson', content);
    compressArtifact(src, { root: dir });
    expect(readGz(`${src}.gz`)).toBe(content);
  });

  test('returns a SizeEntry with correct fields', () => {
    const content = 'x'.repeat(1000);
    const src = writeFile(dir, 'out/large.json', content);
    const entry = compressArtifact(src, { root: dir });
    expect(entry.rawBytes).toBe(1000);
    expect(entry.gzBytes).toBeGreaterThan(0);
    expect(entry.gzBytes).toBeLessThan(entry.rawBytes);
    expect(entry.savingBytes).toBe(entry.rawBytes - entry.gzBytes);
    expect(entry.savingPct).toBeGreaterThan(0);
    expect(entry.deletedRaw).toBe(false);
    expect(entry.relPath).toMatch(/\.gz$/);
  });

  test('deletes the raw file when deleteRaw=true', () => {
    const src = writeFile(dir, 'out/ways_bonn.json', '{"v":1}');
    compressArtifact(src, { root: dir, deleteRaw: true });
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(`${src}.gz`)).toBe(true);
  });

  test('keeps the raw file when deleteRaw=false (default)', () => {
    const src = writeFile(dir, 'out/ways_bonn.json', '{"v":1}');
    compressArtifact(src, { root: dir });
    expect(fs.existsSync(src)).toBe(true);
  });

  test('reports deletedRaw=true when deleteRaw=true', () => {
    const src = writeFile(dir, 'out/data.json', '{"v":1}');
    const entry = compressArtifact(src, { root: dir, deleteRaw: true });
    expect(entry.deletedRaw).toBe(true);
  });

  test('dry-run: does not write .gz file', () => {
    const src = writeFile(dir, 'out/data.json', '{"v":1}');
    compressArtifact(src, { root: dir, dryRun: true });
    expect(fs.existsSync(`${src}.gz`)).toBe(false);
  });

  test('dry-run: does not delete raw file even with deleteRaw=true', () => {
    const src = writeFile(dir, 'out/data.json', '{"v":1}');
    compressArtifact(src, { root: dir, dryRun: true, deleteRaw: true });
    expect(fs.existsSync(src)).toBe(true);
  });

  test('produces deterministic output (same input → same .gz bytes)', () => {
    const content = '{"x":1}';
    const src1 = writeFile(dir, 'out/a.json', content);
    const src2 = writeFile(dir, 'out/b.json', content);
    compressArtifact(src1, { root: dir });
    compressArtifact(src2, { root: dir });
    const gz1 = fs.readFileSync(`${src1}.gz`);
    const gz2 = fs.readFileSync(`${src2}.gz`);
    expect(Buffer.compare(gz1, gz2)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// compressArtifacts
// ---------------------------------------------------------------------------

describe('compressArtifacts', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('compresses all matching files and returns summary', () => {
    const largeContent = 'x'.repeat(DEFAULT_MAX_RAW_BYTES + 1);
    writeFile(dir, 'out/output_all_years_bonn.geojson', largeContent);
    writeFile(dir, 'out/ways_bonn.json', largeContent);

    const policy = {
      compress: ['out/**/*.geojson', 'out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz', 'out/**/*.tmp'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    };

    const result = compressArtifacts(dir, policy, {});

    expect(result.entries).toHaveLength(2);
    expect(result.totalRaw).toBeGreaterThan(0);
    expect(result.totalGz).toBeGreaterThan(0);
    expect(result.totalGz).toBeLessThan(result.totalRaw);
    expect(result.savingPct).toBeGreaterThan(0);
    expect(result.top20).toHaveLength(2);
  });

  test('skips files below maxRawBytes threshold', () => {
    writeFile(dir, 'out/small.json', '{"v":1}'); // 7 bytes
    const policy = {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: 100, // threshold above 7 bytes
    };
    const result = compressArtifacts(dir, policy, {});
    expect(result.entries).toHaveLength(0);
  });

  test('respects keepRaw list', () => {
    const large = 'x'.repeat(DEFAULT_MAX_RAW_BYTES + 1);
    writeFile(dir, 'out/gzip-summary.json', large);

    const policy = {
      compress: ['out/**/*.json'],
      keepRaw: ['out/gzip-summary.json'],
      skip: ['out/**/*.gz'],
      maxRawBytes: 0,
    };
    const result = compressArtifacts(dir, policy, {});
    expect(result.entries).toHaveLength(0);
  });

  test('deleteRaw removes raw files after compression', () => {
    const large = 'x'.repeat(DEFAULT_MAX_RAW_BYTES + 1);
    const src = writeFile(dir, 'out/ways_bonn.json', large);

    const policy = {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    };
    compressArtifacts(dir, policy, { deleteRaw: true });
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(`${src}.gz`)).toBe(true);
  });

  test('deleteStale removes stale .gz files', () => {
    const large = 'x'.repeat(DEFAULT_MAX_RAW_BYTES + 1);
    const src = writeFile(dir, 'out/ways_bonn.json', large);
    // Compress first
    compressArtifacts(dir, {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    }, {});

    // Delete the raw source
    fs.unlinkSync(src);

    // Now run again with deleteStale
    const result = compressArtifacts(dir, {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    }, { deleteStale: true });

    expect(result.staleRemoved).toHaveLength(1);
    expect(fs.existsSync(`${src}.gz`)).toBe(false);
  });

  test('deleteStale is skipped by default when deleteRaw=true (gzip-only safety)', () => {
    const large = 'x'.repeat(DEFAULT_MAX_RAW_BYTES + 1);
    const src = writeFile(dir, 'out/ways_bonn.json', large);

    // First run creates .gz and deletes raw.
    compressArtifacts(dir, {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    }, { deleteRaw: true });

    // Second run in same replace-raw mode should NOT remove existing .gz
    // even though raw is absent.
    const result = compressArtifacts(dir, {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    }, { deleteRaw: true, deleteStale: true });

    expect(result.entries).toHaveLength(0);
    expect(result.staleRemoved).toHaveLength(0);
    expect(fs.existsSync(`${src}.gz`)).toBe(true);
  });

  test('deleteStale can be explicitly re-enabled in deleteRaw mode', () => {
    const large = 'x'.repeat(DEFAULT_MAX_RAW_BYTES + 1);
    const src = writeFile(dir, 'out/ways_bonn.json', large);

    compressArtifacts(dir, {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    }, { deleteRaw: true });

    const result = compressArtifacts(dir, {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    }, { deleteRaw: true, deleteStale: true, allowDeleteStaleWithoutRaw: true });

    expect(result.staleRemoved).toHaveLength(1);
    expect(fs.existsSync(`${src}.gz`)).toBe(false);
  });

  test('top20 is sorted by gzBytes descending', () => {
    const policy = {
      compress: ['out/**/*.json'],
      keepRaw: [],
      skip: ['out/**/*.gz'],
      maxRawBytes: 0,
    };
    // Write files of different sizes (all above threshold 0)
    writeFile(dir, 'out/big.json', 'x'.repeat(5000));
    writeFile(dir, 'out/medium.json', 'x'.repeat(2000));
    writeFile(dir, 'out/small.json', 'x'.repeat(500));

    const result = compressArtifacts(dir, policy, {});
    expect(result.top20[0].gzBytes).toBeGreaterThanOrEqual(result.top20[1].gzBytes);
    if (result.top20.length > 2) {
      expect(result.top20[1].gzBytes).toBeGreaterThanOrEqual(result.top20[2].gzBytes);
    }
  });
});

// ---------------------------------------------------------------------------
// writeJsonArtifact
// ---------------------------------------------------------------------------

describe('writeJsonArtifact', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('gzip-only mode: writes .gz and deletes raw', () => {
    const targetPath = path.join(dir, 'out', 'ways_bonn.json');
    writeJsonArtifact(targetPath, { schemaVersion: 3 }, { compression: 'gzip-only', root: dir });

    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(`${targetPath}.gz`)).toBe(true);
    expect(readGz(`${targetPath}.gz`)).toBe(JSON.stringify({ schemaVersion: 3 }));
  });

  test('raw mode: writes raw file only', () => {
    const targetPath = path.join(dir, 'out', 'manifest.json');
    writeJsonArtifact(targetPath, { summary: true }, { compression: 'raw', root: dir });

    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.existsSync(`${targetPath}.gz`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({ summary: true });
  });

  test('returns SizeEntry with correct rawBytes', () => {
    const value = { type: 'FeatureCollection', features: [] };
    const expectedText = JSON.stringify(value);
    const targetPath = path.join(dir, 'out', 'data.json');
    const entry = writeJsonArtifact(targetPath, value, { compression: 'gzip-only', root: dir });

    expect(entry.rawBytes).toBe(Buffer.byteLength(expectedText, 'utf8'));
    expect(entry.gzBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// writeTextArtifact
// ---------------------------------------------------------------------------

describe('writeTextArtifact', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('gzip-only mode: writes .gz and deletes raw', () => {
    const targetPath = path.join(dir, 'out', 'data.csv');
    writeTextArtifact(targetPath, 'col1,col2\n1,2\n', { compression: 'gzip-only', root: dir });

    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(`${targetPath}.gz`)).toBe(true);
    expect(readGz(`${targetPath}.gz`)).toBe('col1,col2\n1,2\n');
  });
});
