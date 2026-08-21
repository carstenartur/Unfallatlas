'use strict';

const http = require('http');
const https = require('https');

const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;
const DATASET_ID = '6674f347-94ee-4482-962b-8d0aa32f4c01';
const DATASET_SLUG = 'ratsinformationssystem-oparl-api';
const CATALOGUE_URLS = [
  {
    kind: 'package-show-id',
    url: `https://opendata.bonn.de/api/3/action/package_show?id=${DATASET_ID}&page=0`,
  },
  {
    kind: 'package-show-slug',
    url: `https://opendata.bonn.de/api/3/action/package_show?id=${DATASET_SLUG}&page=0`,
  },
  {
    kind: 'package-search',
    url: 'https://opendata.bonn.de/api/3/action/package_search?q=Ratsinformationssystem%20OParl-API&rows=20',
  },
  {
    kind: 'dcat-data-json',
    url: 'https://opendata.bonn.de/data.json',
  },
];
const OFFICIAL_RESOURCE_HOSTS = new Set([
  'opendata.bonn.de',
  'www.bonn.sitzung-online.de',
  'bonn.sitzung-online.de',
  'www2.bonn.de',
]);

jest.setTimeout(180_000);

function requestText(urlValue, options = {}, redirectCount = 0) {
  const url = new URL(urlValue);
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, {
      timeout: options.timeoutMs || 25_000,
      headers: {
        Accept: options.accept || 'application/json, application/ld+json;q=0.9, */*;q=0.1',
        'User-Agent': 'Unfallwerkbank-Bonn-Catalogue-Discovery/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      },
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects for ${url.href}`));
          return;
        }
        requestText(new URL(response.headers.location, url).href, options, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      response.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > (options.maxBytes || 16 * 1024 * 1024)) {
          const error = new Error(`Response too large for ${url.href}`);
          response.destroy(error);
          fail(error);
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
      response.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${url.href}`)));
    req.on('error', reject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function flattenStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenStrings);
}

function datasetCandidates(payload) {
  const result = payload && payload.result;
  const candidates = [
    ...(Array.isArray(result && result.results) ? result.results : []),
    ...(result && typeof result === 'object' && !Array.isArray(result) ? [result] : []),
    ...(Array.isArray(payload && payload.dataset) ? payload.dataset : []),
    ...(Array.isArray(payload && payload.datasets) ? payload.datasets : []),
    ...(Array.isArray(payload && payload['dcat:dataset']) ? payload['dcat:dataset'] : []),
  ];
  return candidates.filter(candidate => candidate && typeof candidate === 'object');
}

function datasetText(dataset) {
  return flattenStrings([
    dataset && dataset.id,
    dataset && dataset.identifier,
    dataset && dataset.name,
    dataset && dataset.title,
    dataset && dataset.description,
  ]).join(' ');
}

function resourceCandidates(dataset) {
  return [
    ...(Array.isArray(dataset && dataset.resources) ? dataset.resources : []),
    ...(Array.isArray(dataset && dataset.distribution) ? dataset.distribution : []),
    ...(Array.isArray(dataset && dataset['dcat:distribution']) ? dataset['dcat:distribution'] : []),
  ].filter(resource => resource && typeof resource === 'object');
}

function resourceUrls(resource, baseUrl) {
  const values = [
    resource && resource.url,
    resource && resource.uri,
    resource && resource.accessURL,
    resource && resource.access_url,
    resource && resource.downloadURL,
    resource && resource.download_url,
    resource && resource['dcat:accessURL'],
    resource && resource['dcat:downloadURL'],
  ].flatMap(flattenStrings);
  const urls = [];
  for (const value of values) {
    try {
      const url = new URL(String(value || '').trim(), baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (!OFFICIAL_RESOURCE_HOSTS.has(url.hostname.toLowerCase())) continue;
      if (!urls.includes(url.href)) urls.push(url.href);
    } catch (_) { /* Ignore non-URL catalogue values. */ }
  }
  return urls;
}

describe('official Bonn catalogue discovery for OParl', () => {
  liveTest('publishes a directly probeable JSON resource', async () => {
    const catalogueAttempts = [];
    const datasets = [];

    for (const candidate of CATALOGUE_URLS) {
      try {
        const response = await requestText(candidate.url);
        const payload = parseJson(response.text);
        const found = payload ? datasetCandidates(payload) : [];
        catalogueAttempts.push({
          kind: candidate.kind,
          requestedUrl: candidate.url,
          finalUrl: response.url,
          status: response.status,
          contentType: response.contentType,
          json: Boolean(payload),
          success: payload && payload.success,
          datasetCount: found.length,
          topLevelKeys: payload && typeof payload === 'object'
            ? Object.keys(payload).slice(0, 20)
            : [],
          prefix: response.text.slice(0, 100).replace(/\s+/g, ' '),
        });
        datasets.push(...found.map(dataset => ({ dataset, sourceUrl: response.url })));
      } catch (error) {
        catalogueAttempts.push({
          kind: candidate.kind,
          requestedUrl: candidate.url,
          error: String(error && error.message || error).slice(0, 300),
        });
      }
    }

    const matchingDatasets = datasets.filter(entry => {
      const text = datasetText(entry.dataset);
      return text.includes(DATASET_ID)
        || /ratsinformationssystem/i.test(text) && /oparl/i.test(text);
    });
    const selectedDatasets = matchingDatasets.length ? matchingDatasets : datasets;
    const resources = [];
    for (const entry of selectedDatasets) {
      for (const resource of resourceCandidates(entry.dataset)) {
        for (const url of resourceUrls(resource, entry.sourceUrl)) {
          if (resources.some(existing => existing.url === url)) continue;
          resources.push({
            datasetId: entry.dataset.id || entry.dataset.identifier || entry.dataset.name || null,
            datasetTitle: entry.dataset.title || entry.dataset.name || null,
            id: resource.id || resource.identifier || null,
            name: resource.name || resource.title || resource.description || null,
            format: resource.format || resource.mimetype || resource.mediaType || null,
            modified: resource.last_modified || resource.modified || resource.created || null,
            url,
          });
        }
      }
    }

    const probes = [];
    for (const resource of resources.slice(0, 15)) {
      try {
        const response = await requestText(resource.url, { maxBytes: 4 * 1024 * 1024 });
        const parsed = parseJson(response.text);
        probes.push({
          ...resource,
          finalUrl: response.url,
          status: response.status,
          contentType: response.contentType,
          json: Boolean(parsed),
          jsonType: parsed && parsed.type || null,
          topLevelKeys: parsed && typeof parsed === 'object'
            ? Object.keys(parsed).slice(0, 20)
            : [],
          prefix: response.text.slice(0, 100).replace(/\s+/g, ' '),
        });
      } catch (error) {
        probes.push({
          ...resource,
          error: String(error && error.message || error).slice(0, 300),
        });
      }
    }

    console.log('[bonn-official-catalogue-discovery]', JSON.stringify({
      catalogueAttempts,
      matchingDatasetCount: matchingDatasets.length,
      resourceCount: resources.length,
      resources,
      probes,
    }));

    expect(catalogueAttempts.some(attempt => attempt.status === 200 && attempt.json)).toBe(true);
    expect(resources.length).toBeGreaterThan(0);
    expect(probes.some(probe => probe.status === 200 && probe.json)).toBe(true);
  });
});
