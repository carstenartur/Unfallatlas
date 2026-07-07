'use strict';

/**
 * tests/unit/readJsonMaybeGz.test.js
 *
 * Unit tests for scripts/lib/read-json-maybe-gz.js
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');

const { readJsonMaybeGz, readTextMaybeGz } = require('../../scripts/lib/read-json-maybe-gz');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ua-read-gz-test-'));
}

function writeRaw(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

function writeGz(dir, name, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const buf  = zlib.gzipSync(Buffer.from(text, 'utf8'));
  const p    = path.join(dir, `${name}.gz`);
  fs.writeFileSync(p, buf);
  return p;
}

// ---------------------------------------------------------------------------
// readTextMaybeGz — raw-ok mode
// ---------------------------------------------------------------------------

describe('readTextMaybeGz — raw-ok mode (default)', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('reads a raw file when it exists', () => {
    writeRaw(dir, 'hello.txt', 'world');
    const result = readTextMaybeGz(path.join(dir, 'hello.txt'));
    expect(result).toBe('world');
  });

  test('falls back to .gz when raw is absent', () => {
    writeGz(dir, 'hello.txt', 'compressed-world');
    const result = readTextMaybeGz(path.join(dir, 'hello.txt'));
    expect(result).toBe('compressed-world');
  });

  test('prefers raw over .gz when both exist', () => {
    writeRaw(dir, 'hello.txt', 'raw-content');
    writeGz(dir, 'hello.txt', 'gz-content');
    const result = readTextMaybeGz(path.join(dir, 'hello.txt'));
    expect(result).toBe('raw-content');
  });

  test('throws ENOENT when neither raw nor .gz exists', () => {
    const p = path.join(dir, 'missing.txt');
    expect(() => readTextMaybeGz(p)).toThrow(/file not found/i);
  });

  test('throws with informative message including both paths', () => {
    const p = path.join(dir, 'missing.txt');
    expect(() => readTextMaybeGz(p)).toThrow(p);
  });

  test('works with explicit mode: raw-ok', () => {
    writeRaw(dir, 'data.txt', 'explicit-raw-ok');
    const result = readTextMaybeGz(path.join(dir, 'data.txt'), { mode: 'raw-ok' });
    expect(result).toBe('explicit-raw-ok');
  });
});

// ---------------------------------------------------------------------------
// readTextMaybeGz — gzip-only mode
// ---------------------------------------------------------------------------

describe('readTextMaybeGz — gzip-only mode', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('reads the .gz file when it exists', () => {
    writeGz(dir, 'data.txt', 'gz-only-content');
    const result = readTextMaybeGz(path.join(dir, 'data.txt'), { mode: 'gzip-only' });
    expect(result).toBe('gz-only-content');
  });

  test('throws ENOENT_GZ when only the raw file exists', () => {
    writeRaw(dir, 'data.txt', 'raw-content');
    const p = path.join(dir, 'data.txt');
    let err;
    try { readTextMaybeGz(p, { mode: 'gzip-only' }); }
    catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('ENOENT_GZ');
    expect(err.message).toMatch(/gzip-only/);
    expect(err.message).toMatch(/only raw file exists/);
  });

  test('throws ENOENT_GZ when neither file exists', () => {
    const p = path.join(dir, 'missing.txt');
    let err;
    try { readTextMaybeGz(p, { mode: 'gzip-only' }); }
    catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('ENOENT_GZ');
  });
});

// ---------------------------------------------------------------------------
// readTextMaybeGz — UNFALLATLAS_DATA_MODE env
// ---------------------------------------------------------------------------

describe('readTextMaybeGz — UNFALLATLAS_DATA_MODE env override', () => {
  let dir;
  const originalEnv = process.env.UNFALLATLAS_DATA_MODE;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    // Restore env
    if (originalEnv === undefined) delete process.env.UNFALLATLAS_DATA_MODE;
    else process.env.UNFALLATLAS_DATA_MODE = originalEnv;
  });

  test('env=gzip-only makes raw-absent file fail', () => {
    process.env.UNFALLATLAS_DATA_MODE = 'gzip-only';
    writeRaw(dir, 'data.txt', 'raw');
    const p = path.join(dir, 'data.txt');
    expect(() => readTextMaybeGz(p)).toThrow();
  });

  test('explicit mode option overrides env', () => {
    process.env.UNFALLATLAS_DATA_MODE = 'gzip-only';
    writeRaw(dir, 'data.txt', 'raw-wins');
    const result = readTextMaybeGz(path.join(dir, 'data.txt'), { mode: 'raw-ok' });
    expect(result).toBe('raw-wins');
  });
});

// ---------------------------------------------------------------------------
// readJsonMaybeGz
// ---------------------------------------------------------------------------

describe('readJsonMaybeGz', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('parses JSON from a raw file', () => {
    writeRaw(dir, 'data.json', { city: 'Bonn', count: 42 });
    const result = readJsonMaybeGz(path.join(dir, 'data.json'));
    expect(result).toEqual({ city: 'Bonn', count: 42 });
  });

  test('parses JSON from a .gz file', () => {
    writeGz(dir, 'data.json', { city: 'Berlin', count: 99 });
    const result = readJsonMaybeGz(path.join(dir, 'data.json'));
    expect(result).toEqual({ city: 'Berlin', count: 99 });
  });

  test('throws on invalid JSON', () => {
    writeRaw(dir, 'bad.json', 'not-json{{{');
    expect(() => readJsonMaybeGz(path.join(dir, 'bad.json'))).toThrow(/JSON parse error/);
  });

  test('parses a GeoJSON FeatureCollection from .gz', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7, 50] }, properties: { id: 1 } },
      ],
    };
    writeGz(dir, 'accidents.geojson', fc);
    const result = readJsonMaybeGz(path.join(dir, 'accidents.geojson'));
    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toHaveLength(1);
  });

  test('gzip-only mode returns parsed JSON', () => {
    writeGz(dir, 'ways.json', { schemaVersion: 3 });
    const result = readJsonMaybeGz(path.join(dir, 'ways.json'), { mode: 'gzip-only' });
    expect(result.schemaVersion).toBe(3);
  });
});
