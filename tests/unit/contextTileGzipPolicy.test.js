'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function loadModule() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.fetch_gz.js'), 'utf8');
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
  return win.UA;
}

describe('context tile gzip-only policy', () => {
  test('recognises both current and documented context tile paths, but not the manifest', () => {
    const UA = loadModule();
    expect(UA._isImplicitGzipOnlyUrl('out/ctxtiles/bonn/4256/2751.json')).toBe(true);
    expect(UA._isImplicitGzipOnlyUrl('out/ctxtiles/bonn/13/4256/2751.json')).toBe(true);
    expect(UA._isImplicitGzipOnlyUrl('/out/ctxtiles/bonn/4256/2751.json?cache=1')).toBe(true);
    expect(UA._isImplicitGzipOnlyUrl('out/ctxtiles/bonn/index.json')).toBe(false);
    expect(UA._isImplicitGzipOnlyUrl('out/ways_bonn.json')).toBe(false);
  });

  test('requests only the .json.gz tile and never falls back to raw JSON', async () => {
    const UA = loadModule();
    const calls = [];
    const payload = { schemaVersion: 3, ways: { W1: {} }, geometries: { W1: [50, 7, 50.1, 7.1] } };
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    const fakeFetch = async url => {
      calls.push(url);
      if (url === 'out/ctxtiles/bonn/4256/2751.json.gz') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => compressed.buffer.slice(
            compressed.byteOffset,
            compressed.byteOffset + compressed.byteLength,
          ),
        };
      }
      return { ok: false, status: 404, json: async () => null };
    };
    const decompress = async buffer => zlib.gunzipSync(Buffer.from(buffer)).toString('utf8');

    const result = await UA.fetchJsonCompressed('out/ctxtiles/bonn/4256/2751.json', {
      fetch: fakeFetch,
      decompress,
      // Deliberately omit gzipOnly: the path itself must enforce it.
    });

    expect(result).toEqual(payload);
    expect(calls).toEqual(['out/ctxtiles/bonn/4256/2751.json.gz']);
  });

  test('missing context tile reports the gzip error without a raw request', async () => {
    const UA = loadModule();
    const calls = [];
    const fakeFetch = async url => {
      calls.push(url);
      return { ok: false, status: 404 };
    };

    await expect(UA.fetchJsonCompressed('out/ctxtiles/bonn/4256/2751.json', {
      fetch: fakeFetch,
      decompress: async () => '',
    })).rejects.toThrow(/2751\.json\.gz/);

    expect(calls).toEqual(['out/ctxtiles/bonn/4256/2751.json.gz']);
  });
});
