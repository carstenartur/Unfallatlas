'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-portal-gate-solve.json');
const BASE = 'https://www.bonn.sitzung-online.de';
const CHALLENGE_URL = `${BASE}/public/_gate/challenge`;
const VERIFY_URL = `${BASE}/public/_gate/verify`;
const NEXT_PATH = '/public/tr010';
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;

jest.setTimeout(90_000);

function requestText(urlValue, options = {}) {
  const url = new URL(urlValue);
  const transport = url.protocol === 'http:' ? http : https;
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body == null ? null : Buffer.from(String(options.body));
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: options.accept || 'text/html, application/json;q=0.9, */*;q=0.1',
      'User-Agent': 'Unfallwerkbank-Bonn-Gate-Client/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      ...(options.headers || {}),
    };
    if (body) headers['Content-Length'] = String(body.length);
    const req = transport.request(url, { method, timeout: 25_000, headers }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) {
          req.destroy(new Error(`Response exceeds 8 MiB: ${url.href}`));
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve({
        url: url.href,
        status: Number(response.statusCode || 0),
        contentType: String(response.headers['content-type'] || ''),
        location: response.headers.location
          ? new URL(response.headers.location, url).href
          : null,
        setCookie: Array.isArray(response.headers['set-cookie'])
          ? response.headers['set-cookie']
          : [],
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${url.href}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(response) {
  try { return JSON.parse(response.text.replace(/^\uFEFF/, '')); }
  catch (error) {
    throw new Error(`Invalid challenge JSON (${response.status} ${response.contentType}): ${error.message}`);
  }
}

function nodeHashAlgorithm(value) {
  const normalized = String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!['sha1', 'sha256', 'sha512'].includes(normalized)) {
    throw new Error(`Unsupported ALTCHA v1 algorithm: ${value}`);
  }
  return normalized;
}

function solveChallenge(challenge) {
  const algorithm = nodeHashAlgorithm(challenge.algorithm);
  const maxnumber = Number(challenge.maxnumber);
  if (!Number.isInteger(maxnumber) || maxnumber < 0 || maxnumber > 1_000_000) {
    throw new Error(`Unsafe ALTCHA maxnumber: ${challenge.maxnumber}`);
  }
  const started = Date.now();
  for (let number = 0; number <= maxnumber; number++) {
    const digest = crypto.createHash(algorithm)
      .update(String(challenge.salt || '') + number, 'utf8')
      .digest('hex');
    if (digest === challenge.challenge) {
      return { number, tookMs: Date.now() - started };
    }
  }
  throw new Error(`No ALTCHA solution found in 0..${maxnumber}`);
}

function payloadBase64(challenge, solution) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number: solution.number,
    salt: challenge.salt,
    signature: challenge.signature,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function cookieHeader(setCookie) {
  return setCookie.map(value => String(value).split(';', 1)[0]).filter(Boolean).join('; ');
}

function titleOf(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

function responseEvidence(response) {
  return {
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    location: response.location,
    cookieNames: response.setCookie.map(value => String(value).split('=', 1)[0]).filter(Boolean),
    responseBytes: Buffer.byteLength(response.text),
    title: titleOf(response.text),
    bodyPrefix: response.text.slice(0, 4_000),
  };
}

describe('official Bonn portal ALTCHA flow', () => {
  liveTest('solves the challenge and receives an ungated portal session', async () => {
    const challengeResponse = await requestText(CHALLENGE_URL, { accept: 'application/json, */*;q=0.1' });
    expect(challengeResponse.status).toBe(200);
    const challenge = parseJson(challengeResponse);
    const solution = solveChallenge(challenge);
    const altcha = payloadBase64(challenge, solution);
    const form = new URLSearchParams({ next: NEXT_PATH, altcha });
    const verifyResponse = await requestText(VERIFY_URL, {
      method: 'POST',
      body: form.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${BASE}${NEXT_PATH}`,
      },
    });
    const cookie = cookieHeader(verifyResponse.setCookie);
    const target = verifyResponse.location || `${BASE}${NEXT_PATH}`;
    const portalResponse = await requestText(target, {
      headers: cookie ? { Cookie: cookie, Referer: `${BASE}${NEXT_PATH}` } : {},
    });

    const evidence = {
      schemaVersion: 'unfallwerkbank.bonnPortalGateSolve.v1',
      collectedAt: new Date().toISOString(),
      challenge: {
        algorithm: challenge.algorithm,
        maxnumber: challenge.maxnumber,
        saltParameters: String(challenge.salt || '').split('?')[1] || null,
      },
      solution,
      verify: responseEvidence(verifyResponse),
      portal: responseEvidence(portalResponse),
      ungated: !/Zugriff\s+pruefen/i.test(`${titleOf(portalResponse.text) || ''} ${portalResponse.text.slice(0, 1_000)}`),
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    console.log('[bonn-portal-gate-solve]', JSON.stringify(evidence));

    expect(solution.number).toBeGreaterThanOrEqual(0);
    expect([200, 201, 202, 204, 302, 303]).toContain(verifyResponse.status);
    expect(evidence.ungated).toBe(true);
  });
});
