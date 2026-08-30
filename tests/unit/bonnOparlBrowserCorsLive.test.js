'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-oparl-browser-cors.json');
const COLLECTION =
  'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=1&limit=1&size=1';
const ORIGIN = 'https://carstenartur.github.io';
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;

jest.setTimeout(60_000);

function requestCollection() {
  return new Promise((resolve, reject) => {
    const request = https.get(COLLECTION, {
      timeout: 25_000,
      headers: {
        Accept: 'application/json, application/ld+json;q=0.9',
        Origin: ORIGIN,
        'User-Agent':
          'Unfallwerkbank-Bonn-Browser-CORS-QA/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) {
          request.destroy(new Error('Bonn OParl CORS probe exceeded 4 MiB.'));
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve({
        status: Number(response.statusCode || 0),
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Bonn OParl CORS probe timed out.')));
    request.on('error', reject);
  });
}

describe('official Bonn OParl browser CORS contract', () => {
  liveTest('allows the public Unfallwerkbank origin to read the Paper collection', async () => {
    const response = await requestCollection();
    let json = null;
    let parseError = null;
    try {
      json = JSON.parse(response.text.replace(/^\uFEFF/, ''));
    } catch (error) {
      parseError = error.message;
    }

    const allowOrigin = String(response.headers['access-control-allow-origin'] || '');
    const evidence = {
      schemaVersion: 'unfallwerkbank.bonnOparlBrowserCors.v1',
      collectedAt: new Date().toISOString(),
      request: { url: COLLECTION, origin: ORIGIN, method: 'GET' },
      response: {
        status: response.status,
        contentType: String(response.headers['content-type'] || ''),
        accessControlAllowOrigin: allowOrigin,
        vary: String(response.headers.vary || ''),
        bytes: Buffer.byteLength(response.text),
        jsonParsed: Boolean(json),
        itemCount: Array.isArray(json && json.data) ? json.data.length : null,
        parseError,
      },
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

    expect(response.status).toBe(200);
    expect(json).toBeTruthy();
    expect(Array.isArray(json.data)).toBe(true);
    expect([ORIGIN, '*']).toContain(allowOrigin);
  });
});
