'use strict';

/**
 * tests/unit/uaFetchGz.test.js
 *
 * Unit tests for js/ua.fetch_gz.js — the browser-side gzip fetch utility.
 *
 * jsdom does not ship DecompressionStream; tests inject a `decompress`
 * function or fake fetch that simulates the decompressed response so the
 * test suite stays deterministic without actually running gzip.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  loadModule('../../js/ua.fetch_gz.js', win);
  return win.UA;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Simulate the decompressed result of a .gz file.
 * Returns a fake `fetch` that responds to the .gz URL with compressed bytes,
 * plus a `decompress` function that returns the original text.
 */
function makeGzFetch(urlGz, text) {
  const buf = zlib.gzipSync(Buffer.from(text, 'utf8'));
  const fakeFetch = async (url) => {
    if (url !== urlGz) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  const fakeDecompress = async (ab) => {
    const raw = Buffer.from(ab);
    return zlib.gunzipSync(raw).toString('utf8');
  };
  return { fakeFetch, fakeDecompress };
}

function makeRawFetch(url, body) {
  return async (fetchUrl) => {
    if (fetchUrl !== url) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => body };
  };
}

// ---------------------------------------------------------------------------
// UA.fetchJsonGz
// ---------------------------------------------------------------------------

describe('UA.fetchJsonGz', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  test('fetches, decompresses, and parses a .gz URL', async () => {
    const data = { city: 'Bonn', count: 42 };
    const { fakeFetch, fakeDecompress } = makeGzFetch(
      'out/output_all_years_bonn.geojson.gz',
      JSON.stringify(data)
    );

    const result = await UA.fetchJsonGz('out/output_all_years_bonn.geojson.gz', {
      fetch: fakeFetch,
      decompress: fakeDecompress,
    });

    expect(result).toEqual(data);
  });

  test('throws on HTTP error', async () => {
    const fakeFetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(
      UA.fetchJsonGz('out/missing.json.gz', { fetch: fakeFetch, decompress: async b => '' })
    ).rejects.toThrow(/HTTP 404/);
  });

  test('throws on network error', async () => {
    const fakeFetch = async () => { throw new Error('network failure'); };
    await expect(
      UA.fetchJsonGz('out/data.json.gz', { fetch: fakeFetch, decompress: async b => '' })
    ).rejects.toThrow(/network error/);
  });

  test('throws on decompression failure', async () => {
    const fakeFetch = async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    });
    const badDecompress = async () => { throw new Error('bad gzip data'); };
    await expect(
      UA.fetchJsonGz('out/data.json.gz', { fetch: fakeFetch, decompress: badDecompress })
    ).rejects.toThrow(/decompression failed/);
  });

  test('throws on invalid JSON after decompression', async () => {
    const { fakeFetch } = makeGzFetch('out/bad.json.gz', 'not-json{{');
    const fakeDecompress = async () => 'not-json{{';
    await expect(
      UA.fetchJsonGz('out/bad.json.gz', { fetch: fakeFetch, decompress: fakeDecompress })
    ).rejects.toThrow(/JSON parse error/);
  });

  test('passes arrayBuffer body to decompress function', async () => {
    const data = { test: true };
    const gzBuf = zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8'));
    let receivedBuf = null;
    const fakeFetch = async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => gzBuf.buffer.slice(gzBuf.byteOffset, gzBuf.byteOffset + gzBuf.byteLength),
    });
    const fakeDecompress = async (ab) => {
      receivedBuf = ab;
      return JSON.stringify(data);
    };
    await UA.fetchJsonGz('out/data.json.gz', { fetch: fakeFetch, decompress: fakeDecompress });
    expect(receivedBuf).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UA.fetchJsonCompressed — gz path
// ---------------------------------------------------------------------------

describe('UA.fetchJsonCompressed — loads .gz variant', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  test('appends .gz suffix and decompresses', async () => {
    const data = { type: 'FeatureCollection', features: [] };
    const { fakeFetch, fakeDecompress } = makeGzFetch(
      'out/output_all_years_bonn.geojson.gz',
      JSON.stringify(data)
    );
    const result = await UA.fetchJsonCompressed('out/output_all_years_bonn.geojson', {
      fetch: fakeFetch,
      decompress: fakeDecompress,
    });
    expect(result).toEqual(data);
  });

  test('does not double-append .gz when URL already ends with .gz', async () => {
    const data = { v: 1 };
    const { fakeFetch, fakeDecompress } = makeGzFetch('out/data.json.gz', JSON.stringify(data));
    const result = await UA.fetchJsonCompressed('out/data.json.gz', {
      fetch: fakeFetch,
      decompress: fakeDecompress,
    });
    expect(result).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// UA.fetchJsonCompressed — fallback to raw
// ---------------------------------------------------------------------------

describe('UA.fetchJsonCompressed — fallback to raw (gzipOnly=false)', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  test('falls back to raw URL when .gz fetch fails', async () => {
    const data = { fallback: true };
    let callCount = 0;
    const fakeFetch = async (url) => {
      callCount++;
      if (url.endsWith('.gz')) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => data };
    };
    const fakeDecompress = async () => { throw new Error('decomp-never-called'); };

    const result = await UA.fetchJsonCompressed('out/data.json', {
      fetch: fakeFetch,
      decompress: fakeDecompress,
      gzipOnly: false,
    });

    expect(result).toEqual(data);
    expect(callCount).toBe(2); // .gz + raw
  });

  test('gzipOnly=true: throws without trying the raw URL', async () => {
    let callCount = 0;
    const fakeFetch = async (url) => {
      callCount++;
      if (url.endsWith('.gz')) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({ raw: true }) };
    };
    const fakeDecompress = async () => { throw new Error('no decomp'); };

    await expect(
      UA.fetchJsonCompressed('out/data.json', {
        fetch: fakeFetch,
        decompress: fakeDecompress,
        gzipOnly: true,
      })
    ).rejects.toBeDefined();

    // Only the .gz URL should have been requested
    expect(callCount).toBe(1);
  });

  test('re-throws .gz error even when raw URL is also 404', async () => {
    const fakeFetch = async () => ({ ok: false, status: 404 });
    const fakeDecompress = async () => { throw new Error('not called'); };
    await expect(
      UA.fetchJsonCompressed('out/missing.json', {
        fetch: fakeFetch,
        decompress: fakeDecompress,
        gzipOnly: false,
      })
    ).rejects.toThrow(/HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// UA.fetchJsonCompressed — gzipOnly default from global mode
// ---------------------------------------------------------------------------

describe('UA.fetchJsonCompressed — respects <meta> gzip-only mode', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  test('treats missing meta as gzip-optional (allows fallback)', async () => {
    // jsdom has no <meta> by default → globalDataMode returns 'default'
    const data = { raw: true };
    const fakeFetch = async (url) => {
      if (url.endsWith('.gz')) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => data };
    };
    const fakeDecompress = async () => { throw new Error(); };
    const result = await UA.fetchJsonCompressed('out/data.json', {
      fetch: fakeFetch,
      decompress: fakeDecompress,
    });
    expect(result).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('ua.fetch_gz module shape', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  test('exposes UA.fetchJsonGz as a function', () => {
    expect(typeof UA.fetchJsonGz).toBe('function');
  });

  test('exposes UA.fetchJsonCompressed as a function', () => {
    expect(typeof UA.fetchJsonCompressed).toBe('function');
  });
});
