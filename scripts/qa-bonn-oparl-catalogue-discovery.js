#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-official-catalogue-discovery.json');
const DATASET_ID = '6674f347-94ee-4482-962b-8d0aa32f4c01';
const DATASET_SLUG = 'ratsinformationssystem-oparl-api';
const CATALOGUE_REQUESTS = [
  {
    kind: 'package-show-id',
    url: `https://opendata.bonn.de/api/3/action/package_show?id=${DATASET_ID}`,
  },
  {
    kind: 'package-show-slug',
    url: `https://opendata.bonn.de/api/3/action/package_show?id=${DATASET_SLUG}`,
  },
  {
    kind: 'package-search',
    url: 'https://opendata.bonn.de/api/3/action/package_search?q=Ratsinformationssystem%20OParl-API&rows=20',
  },
  {
    kind: 'dcat-ap-dataset',
    url: `https://opendata.bonn.de/dcatapde/dataset/${DATASET_SLUG}.json`,
  },
  {
    kind: 'dataset-page',
    url: `https://opendata.bonn.de/dataset/${DATASET_SLUG}`,
    accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1',
  },
];
const PROBE_HOSTS = new Set([
  'opendata.bonn.de',
  'www.bonn.sitzung-online.de',
  'bonn.sitzung-online.de',
  'www2.bonn.de',
]);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDED_BODY_CHARS = 4 * 1024 * 1024;
const MAX_PROBES = 30;
const MAX_REDIRECTS = 5;

function requestText(urlValue, options = {}, redirectState = null) {
  const currentUrl = new URL(urlValue);
  const state = redirectState && typeof redirectState === 'object'
    ? {
        requestedUrl: String(redirectState.requestedUrl || currentUrl.href),
        redirectCount: Number(redirectState.redirectCount) || 0,
        redirectChain: Array.isArray(redirectState.redirectChain)
          ? redirectState.redirectChain.slice()
          : [],
      }
    : {
        requestedUrl: currentUrl.href,
        redirectCount: Number(redirectState) || 0,
        redirectChain: [],
      };
  const transport = currentUrl.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = transport.get(currentUrl, {
      timeout: options.timeoutMs || 25_000,
      headers: {
        Accept: options.accept || 'application/json, application/ld+json;q=0.9, text/html;q=0.3, */*;q=0.1',
        'User-Agent': 'Unfallwerkbank-Bonn-Catalogue-Discovery/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      },
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (state.redirectCount >= MAX_REDIRECTS) {
          finishReject(new Error(`Too many redirects for ${state.requestedUrl}`));
          return;
        }
        const nextUrl = new URL(response.headers.location, currentUrl).href;
        requestText(nextUrl, options, {
          requestedUrl: state.requestedUrl,
          redirectCount: state.redirectCount + 1,
          redirectChain: [...state.redirectChain, {
            status,
            fromUrl: currentUrl.href,
            toUrl: nextUrl,
          }],
        }).then(resolve, finishReject);
        return;
      }

      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > (options.maxBytes || MAX_RESPONSE_BYTES)) {
          const error = new Error(`Response exceeds ${options.maxBytes || MAX_RESPONSE_BYTES} bytes: ${currentUrl.href}`);
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
          requestedUrl: state.requestedUrl,
          finalUrl: currentUrl.href,
          redirectChain: state.redirectChain.slice(),
          status,
          headers: {
            contentType: String(response.headers['content-type'] || ''),
            contentLength: String(response.headers['content-length'] || ''),
            lastModified: String(response.headers['last-modified'] || ''),
            etag: String(response.headers.etag || ''),
          },
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', finishReject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${currentUrl.href}`)));
    req.on('error', finishReject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function normalizeUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || '').trim(), baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function collectJsonUrls(value, baseUrl, output = new Set(), depth = 0) {
  if (depth > 20 || value == null) return output;
  if (typeof value === 'string') {
    const url = normalizeUrl(value, baseUrl);
    if (url) output.add(url);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonUrls(item, baseUrl, output, depth + 1);
    return output;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectJsonUrls(item, baseUrl, output, depth + 1);
    }
  }
  return output;
}

function collectHtmlUrls(html, baseUrl) {
  const urls = new Set();
  const attributePattern = /\b(?:href|src|data-url|data-href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attributePattern.exec(String(html || ''))) !== null) {
    const url = normalizeUrl(match[1], baseUrl);
    if (url) urls.add(url);
  }
  return urls;
}

function isProbeCandidate(urlValue) {
  try {
    const url = new URL(urlValue);
    if (!PROBE_HOSTS.has(url.hostname.toLowerCase())) return false;
    const text = `${url.pathname} ${url.search}`.toLowerCase();
    if (/\/api\/3\/action\//.test(url.pathname)) return false;
    if (/\/dcatapde\/dataset\//.test(url.pathname)) return false;
    if (/\/dataset\//.test(url.pathname) && !/\/resource\//.test(url.pathname)) return false;
    return /oparl|sitzung|resource|\.json(?:$|\?)|\/api\//.test(text);
  } catch (_) {
    return false;
  }
}

function safeError(error) {
  return {
    name: error && error.name || 'Error',
    code: error && error.code || null,
    message: String(error && error.message || error || 'Unknown error').slice(0, 1_000),
    cause: error && error.cause ? String(error.cause).slice(0, 1_000) : null,
  };
}

function responseEvidence(kind, response) {
  const json = parseJson(response.text);
  const body = response.text.length <= MAX_RECORDED_BODY_CHARS
    ? response.text
    : response.text.slice(0, MAX_RECORDED_BODY_CHARS);
  return {
    kind,
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    redirectChain: Array.isArray(response.redirectChain) ? response.redirectChain : [],
    status: response.status,
    headers: response.headers,
    jsonParsed: Boolean(json),
    json,
    bodyTruncated: response.text.length > MAX_RECORDED_BODY_CHARS,
    body,
  };
}

async function main() {
  const evidence = {
    schemaVersion: 'unfallwerkbank.bonnOparlCatalogueDiscovery.v1',
    startedAt: new Date().toISOString(),
    dataset: { id: DATASET_ID, slug: DATASET_SLUG },
    catalogueAttempts: [],
    discoveredUrls: [],
    probes: [],
  };
  const discovered = new Set();

  for (const candidate of CATALOGUE_REQUESTS) {
    try {
      const response = await requestText(candidate.url, { accept: candidate.accept });
      const attempt = responseEvidence(candidate.kind, response);
      evidence.catalogueAttempts.push(attempt);
      if (attempt.json) {
        collectJsonUrls(attempt.json, response.finalUrl, discovered);
      } else {
        for (const url of collectHtmlUrls(response.text, response.finalUrl)) discovered.add(url);
      }
    } catch (error) {
      evidence.catalogueAttempts.push({
        kind: candidate.kind,
        requestedUrl: candidate.url,
        error: safeError(error),
      });
    }
  }

  evidence.discoveredUrls = [...discovered].sort();
  const candidates = evidence.discoveredUrls.filter(isProbeCandidate).slice(0, MAX_PROBES);
  for (const url of candidates) {
    try {
      const response = await requestText(url, { maxBytes: 4 * 1024 * 1024 });
      const json = parseJson(response.text);
      evidence.probes.push({
        requestedUrl: response.requestedUrl,
        finalUrl: response.finalUrl,
        redirectChain: response.redirectChain,
        status: response.status,
        headers: response.headers,
        jsonParsed: Boolean(json),
        jsonType: json && json.type || null,
        topLevelKeys: json && typeof json === 'object' ? Object.keys(json).slice(0, 50) : [],
        bodyPrefix: response.text.slice(0, 500).replace(/\s+/g, ' '),
      });
    } catch (error) {
      evidence.probes.push({ requestedUrl: url, error: safeError(error) });
    }
  }

  evidence.completedAt = new Date().toISOString();
  evidence.summary = {
    catalogueJsonResponses: evidence.catalogueAttempts.filter(attempt => attempt.jsonParsed).length,
    catalogueHttpResponses: evidence.catalogueAttempts.filter(attempt => Number.isInteger(attempt.status)).length,
    discoveredUrlCount: evidence.discoveredUrls.length,
    probeCount: evidence.probes.length,
    usableJsonProbeCount: evidence.probes.filter(probe => probe.status === 200 && probe.jsonParsed).length,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`[bonn-oparl-catalogue-discovery] evidence: ${OUTPUT}`);
  console.log(`[bonn-oparl-catalogue-discovery] ${JSON.stringify(evidence.summary)}`);
}

if (require.main === module) {
  main().catch(error => {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify({
      schemaVersion: 'unfallwerkbank.bonnOparlCatalogueDiscovery.v1',
      completedAt: new Date().toISOString(),
      fatalError: safeError(error),
    }, null, 2) + '\n', 'utf8');
    console.error('[bonn-oparl-catalogue-discovery] fatal:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  requestText,
  parseJson,
  normalizeUrl,
  collectJsonUrls,
  collectHtmlUrls,
  isProbeCandidate,
  responseEvidence,
  safeError,
  main,
};
