'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-oparl-collection-probes.json');
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;
const COLLECTION_URL = 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers';
const LOOKBACK = '2014-01-01T00:00:00Z';

jest.setTimeout(120_000);

function requestText(urlValue, redirectCount = 0) {
  const url = new URL(urlValue);
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = transport.get(url, {
      timeout: 25_000,
      headers: {
        Accept: 'application/json, application/ld+json;q=0.9, */*;q=0.1',
        'User-Agent': 'Unfallwerkbank-Bonn-OParl-Probe/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      },
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          finishReject(new Error(`Too many redirects for ${url.href}`));
          return;
        }
        requestText(new URL(response.headers.location, url).href, redirectCount + 1)
          .then(resolve, finishReject);
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1024 * 1024) {
          const error = new Error(`Response exceeds 16 MiB: ${url.href}`);
          response.destroy(error);
          finishReject(error);
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          url: url.href,
          status,
          contentType: String(response.headers['content-type'] || ''),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', finishReject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${url.href}`)));
    req.on('error', finishReject);
  });
}

function safeError(error) {
  return {
    name: String(error && error.name || 'Error'),
    code: error && error.code ? String(error.code) : null,
    message: String(error && error.message || error || 'Unknown error').slice(0, 500),
  };
}

function summarizePaper(paper) {
  return {
    id: paper && paper.id || null,
    name: paper && paper.name || null,
    reference: paper && paper.reference || null,
    date: paper && paper.date || null,
    created: paper && paper.created || null,
    modified: paper && paper.modified || null,
    deleted: paper && paper.deleted === true,
  };
}

function collectionSummary(label, response) {
  let json = null;
  try {
    json = JSON.parse(response.text.replace(/^\uFEFF/, ''));
  } catch (_) {
    return {
      label,
      url: response.url,
      status: response.status,
      contentType: response.contentType,
      jsonParsed: false,
      bodyPrefix: response.text.slice(0, 500).replace(/\s+/g, ' '),
    };
  }
  const data = Array.isArray(json)
    ? json
    : (Array.isArray(json && json.data) ? json.data : []);
  return {
    label,
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    jsonParsed: true,
    topLevelKeys: json && typeof json === 'object' && !Array.isArray(json)
      ? Object.keys(json).slice(0, 30)
      : [],
    count: data.length,
    pagination: json && json.pagination || null,
    links: json && json.links || null,
    first: data.slice(0, 3).map(summarizePaper),
    last: data.slice(-3).map(summarizePaper),
  };
}

describe('official Bonn OParl Paper collection semantics', () => {
  liveTest('retains evidence for optional filters and pagination', async () => {
    const variants = [
      ['unfiltered', COLLECTION_URL],
      ['page-1', `${COLLECTION_URL}?page=1`],
      ['page-2', `${COLLECTION_URL}?page=2`],
      ['limit-100', `${COLLECTION_URL}?page=1&limit=100`],
      ['omit-internal', `${COLLECTION_URL}?page=1&omit_internal=true&limit=100`],
      ['created-since-timestamp', `${COLLECTION_URL}?page=1&created_since=${encodeURIComponent(LOOKBACK)}&omit_internal=true&limit=100`],
      ['created-since-date', `${COLLECTION_URL}?page=1&created_since=2014-01-01&omit_internal=true&limit=100`],
      ['modified-since-timestamp', `${COLLECTION_URL}?page=1&modified_since=${encodeURIComponent(LOOKBACK)}&omit_internal=true&limit=100`],
    ];
    const probes = [];
    for (const [label, url] of variants) {
      try {
        probes.push(collectionSummary(label, await requestText(url)));
      } catch (error) {
        probes.push({ label, url, error: safeError(error) });
      }
    }

    const evidence = {
      schemaVersion: 'unfallwerkbank.bonnOparlCollectionProbe.v1',
      collectedAt: new Date().toISOString(),
      collectionUrl: COLLECTION_URL,
      probes,
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    console.log('[bonn-oparl-collection-probes]', JSON.stringify(probes));

    expect(probes.some(probe => probe.status === 200 && probe.jsonParsed)).toBe(true);
  });
});
