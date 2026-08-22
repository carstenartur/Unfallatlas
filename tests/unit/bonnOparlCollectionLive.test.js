'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-oparl-collection-probes.json');
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;
const COLLECTION_URL = 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers';
const LOOKBACK_Z = '2014-01-01T00:00:00Z';
const LOOKBACK_UTC_OFFSET = '2014-01-01T00:00:00+00:00';
const LOOKBACK_BERLIN_OFFSET = '2014-01-01T00:00:00+01:00';
const LIVE_TERMS = ['adenauerallee', 'radverkehr'];

jest.setTimeout(180_000);

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
      timeout: 35_000,
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
        if (bytes > 32 * 1024 * 1024) {
          const error = new Error(`Response exceeds 32 MiB: ${url.href}`);
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

function paperSearchText(paper) {
  const locations = Array.isArray(paper && paper.location)
    ? paper.location.map(location => location && (
      location.description || location.streetAddress || location.locality
    ))
    : [];
  return [
    paper && paper.name,
    paper && paper.reference,
    paper && paper.paperType,
    ...(Array.isArray(paper && paper.keyword) ? paper.keyword : []),
    ...locations,
    paper && paper.mainFile && paper.mainFile.name,
    paper && paper.mainFile && paper.mainFile.fileName,
  ].filter(Boolean).join(' | ').toLowerCase();
}

function matchingPapers(data) {
  const matches = [];
  for (const paper of data) {
    const text = paperSearchText(paper);
    const terms = LIVE_TERMS.filter(term => text.includes(term));
    if (terms.length) matches.push({ ...summarizePaper(paper), terms });
    if (matches.length >= 50) break;
  }
  return matches;
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
    responseBytes: Buffer.byteLength(response.text),
    jsonParsed: true,
    topLevelKeys: json && typeof json === 'object' && !Array.isArray(json)
      ? Object.keys(json).slice(0, 30)
      : [],
    count: data.length,
    pagination: json && json.pagination || null,
    links: json && json.links || null,
    termMatches: matchingPapers(data),
    first: data.slice(0, 3).map(summarizePaper),
    last: data.slice(-3).map(summarizePaper),
  };
}

describe('official Bonn OParl Paper collection semantics', () => {
  liveTest('retains evidence for optional filters, page size and live-term coverage', async () => {
    const variants = [
      ['unfiltered', COLLECTION_URL],
      ['page-1', `${COLLECTION_URL}?page=1`],
      ['page-2', `${COLLECTION_URL}?page=2`],
      ['limit-100', `${COLLECTION_URL}?page=1&limit=100`],
      ['size-100', `${COLLECTION_URL}?page=1&size=100`],
      ['size-500', `${COLLECTION_URL}?page=1&size=500`],
      ['size-1000', `${COLLECTION_URL}?page=1&size=1000`],
      ['size-2000', `${COLLECTION_URL}?page=1&size=2000`],
      ['size-1000-page-24', `${COLLECTION_URL}?page=24&size=1000`],
      ['size-1000-page-25', `${COLLECTION_URL}?page=25&size=1000`],
      ['size-100-date-desc', `${COLLECTION_URL}?page=1&size=100&sort=date,desc`],
      ['size-100-id-desc', `${COLLECTION_URL}?page=1&size=100&sort=id,desc`],
      ['size-100-reference-desc', `${COLLECTION_URL}?page=1&size=100&sort=reference,desc`],
      ['size-100-q-adenauerallee', `${COLLECTION_URL}?page=1&size=100&q=Adenauerallee`],
      ['size-100-search-adenauerallee', `${COLLECTION_URL}?page=1&size=100&search=Adenauerallee`],
      ['omit-internal', `${COLLECTION_URL}?page=1&omit_internal=true&limit=100`],
      ['created-since-z', `${COLLECTION_URL}?page=1&created_since=${encodeURIComponent(LOOKBACK_Z)}&omit_internal=true&limit=100`],
      ['created-since-utc-offset', `${COLLECTION_URL}?page=1&created_since=${encodeURIComponent(LOOKBACK_UTC_OFFSET)}&omit_internal=true&limit=100`],
      ['created-since-berlin-offset', `${COLLECTION_URL}?page=1&created_since=${encodeURIComponent(LOOKBACK_BERLIN_OFFSET)}&omit_internal=true&limit=100`],
      ['created-since-date', `${COLLECTION_URL}?page=1&created_since=2014-01-01&omit_internal=true&limit=100`],
      ['modified-since-utc-offset', `${COLLECTION_URL}?page=1&modified_since=${encodeURIComponent(LOOKBACK_UTC_OFFSET)}&omit_internal=true&limit=100`],
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
