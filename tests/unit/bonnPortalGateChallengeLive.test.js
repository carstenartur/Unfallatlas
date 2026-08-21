'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-portal-gate-challenge.json');
const CHALLENGE_URL = 'https://www.bonn.sitzung-online.de/public/_gate/challenge';
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;

jest.setTimeout(60_000);

function requestText(urlValue, redirectCount = 0) {
  const url = new URL(urlValue);
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, {
      timeout: 25_000,
      headers: {
        Accept: 'application/json, */*;q=0.1',
        'User-Agent': 'Unfallwerkbank-Bonn-Gate-Contract/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      },
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects for ${url.href}`));
          return;
        }
        requestText(new URL(response.headers.location, url).href, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) {
          req.destroy(new Error(`Challenge response exceeds 1 MiB: ${url.href}`));
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve({
        url: url.href,
        status,
        contentType: String(response.headers['content-type'] || ''),
        cacheControl: String(response.headers['cache-control'] || ''),
        setCookie: Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [],
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${url.href}`)));
    req.on('error', reject);
  });
}

function safeJson(text) {
  try { return JSON.parse(String(text || '').replace(/^\uFEFF/, '')); }
  catch (_) { return null; }
}

describe('official Bonn portal proof-of-work gate', () => {
  liveTest('publishes a machine-readable ALTCHA challenge contract', async () => {
    const response = await requestText(CHALLENGE_URL);
    const challenge = safeJson(response.text);
    const evidence = {
      schemaVersion: 'unfallwerkbank.bonnPortalGateChallenge.v1',
      collectedAt: new Date().toISOString(),
      response: {
        url: response.url,
        status: response.status,
        contentType: response.contentType,
        cacheControl: response.cacheControl,
        setsCookie: response.setCookie.length > 0,
        responseBytes: Buffer.byteLength(response.text),
      },
      challenge,
      bodyPrefix: challenge ? null : response.text.slice(0, 4_000),
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    console.log('[bonn-portal-gate-challenge]', JSON.stringify(evidence));

    expect(response.status).toBe(200);
    expect(challenge).toBeTruthy();
    expect(typeof challenge).toBe('object');
  });
});
