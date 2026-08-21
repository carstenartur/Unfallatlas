'use strict';

const http = require('http');
const https = require('https');

const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;
const CATALOGUE_SEARCH_URL = new URL('https://www.govdata.de/ckan/api/3/action/package_search');
CATALOGUE_SEARCH_URL.searchParams.set('q', 'title:"Ratsinformationssystem OParl-API"');
CATALOGUE_SEARCH_URL.searchParams.set('rows', '20');

jest.setTimeout(120_000);

function requestText(urlValue, options = {}, redirectCount = 0) {
  const url = new URL(urlValue);
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, {
      timeout: options.timeoutMs || 20_000,
      headers: {
        Accept: options.accept || 'application/json, */*;q=0.1',
        'User-Agent': 'Unfallwerkbank-GovData-Discovery/1.0 (+https://github.com/carstenartur/Unfallatlas)',
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
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > (options.maxBytes || 8 * 1024 * 1024)) {
          req.destroy(new Error(`Response too large for ${url.href}`));
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve({
        url: url.href,
        status,
        contentType: String(response.headers['content-type'] || ''),
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${url.href}`)));
    req.on('error', reject);
  });
}

function resourceUrls(resource) {
  return [
    resource && resource.url,
    resource && resource.access_url,
    resource && resource.download_url,
  ].flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => String(value || '').trim())
    .filter(value => /^https?:\/\//i.test(value));
}

function publisherText(dataset) {
  return [dataset && dataset.publisher, dataset && dataset.organization]
    .map(value => typeof value === 'string'
      ? value
      : [value && value.title, value && value.name].filter(Boolean).join(' '))
    .filter(Boolean).join(' ');
}

describe('official GovData catalogue discovery for Bonn OParl', () => {
  liveTest('publishes a directly probeable JSON resource', async () => {
    const catalogueResponse = await requestText(CATALOGUE_SEARCH_URL.href);
    expect(catalogueResponse.status).toBe(200);
    const catalogue = JSON.parse(catalogueResponse.text.replace(/^\uFEFF/, ''));
    expect(catalogue.success).toBe(true);

    const datasets = Array.isArray(catalogue.result && catalogue.result.results)
      ? catalogue.result.results
      : [];
    const exact = datasets.filter(dataset =>
      String(dataset && dataset.title || '').trim() === 'Ratsinformationssystem OParl-API'
    );
    expect(exact.length).toBeGreaterThan(0);

    const preferred = exact.find(dataset => /\bbonn\b/i.test(publisherText(dataset))) || exact[0];
    const resources = (Array.isArray(preferred.resources) ? preferred.resources : [])
      .flatMap(resource => resourceUrls(resource).map(url => ({
        id: resource.id || null,
        name: resource.name || resource.title || null,
        format: resource.format || resource.mimetype || null,
        modified: resource.last_modified || resource.created || null,
        url,
      })));
    expect(resources.length).toBeGreaterThan(0);

    const probes = [];
    for (const resource of resources.slice(0, 10)) {
      try {
        const response = await requestText(resource.url, { maxBytes: 2 * 1024 * 1024 });
        let jsonType = null;
        try {
          const parsed = JSON.parse(response.text.replace(/^\uFEFF/, ''));
          jsonType = parsed && parsed.type || null;
        } catch (_) { /* A catalogue landing page is still useful diagnostic evidence. */ }
        probes.push({
          ...resource,
          finalUrl: response.url,
          status: response.status,
          contentType: response.contentType,
          jsonType,
          prefix: response.text.slice(0, 80).replace(/\s+/g, ' '),
        });
      } catch (error) {
        probes.push({ ...resource, error: String(error && error.message || error).slice(0, 240) });
      }
    }

    console.log('[bonn-govdata-discovery]', JSON.stringify({
      dataset: {
        id: preferred.id || preferred.name || null,
        title: preferred.title || null,
        publisher: publisherText(preferred) || null,
        modified: preferred.metadata_modified || preferred.modified || null,
      },
      probes,
    }));

    expect(probes.some(probe => probe.status === 200 && probe.jsonType)).toBe(true);
  });
});
