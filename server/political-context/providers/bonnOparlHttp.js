'use strict';

/** HTTP, pagination and SSRF guardrails for the official Bonn OParl client. */

const http = require('http');
const https = require('https');

const OParlClientErrorCode = Object.freeze({
  INVALID_URL: 'OPARL_INVALID_URL',
  HTTP_ERROR: 'OPARL_HTTP_ERROR',
  RESPONSE_TOO_LARGE: 'OPARL_RESPONSE_TOO_LARGE',
  INVALID_JSON: 'OPARL_INVALID_JSON',
  INVALID_LIST: 'OPARL_INVALID_LIST',
  PAGINATION_CYCLE: 'OPARL_PAGINATION_CYCLE',
  TOO_MANY_REDIRECTS: 'OPARL_TOO_MANY_REDIRECTS',
  UNTRUSTED_HOST: 'OPARL_UNTRUSTED_HOST',
});

const DEFAULT_TIMEOUT_MS = positiveInteger(process.env.PORTAL_SEARCH_TIMEOUT_MS, 10_000);
const DEFAULT_MAX_BYTES = positiveInteger(process.env.BONN_OPARL_MAX_BYTES, 16 * 1024 * 1024);
const DEFAULT_MAX_PAGES = positiveInteger(process.env.BONN_OPARL_MAX_PAGES, 12);
const DEFAULT_MAX_REDIRECTS = 5;
const OFFICIAL_BONN_HOSTS = new Set([
  'www.bonn.sitzung-online.de',
  'bonn.sitzung-online.de',
  'www2.bonn.de',
]);

class OParlClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OParlClientError';
    this.code = code;
    this.details = details;
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeUrl(value, baseUrl) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function isHttpUrl(value) {
  return Boolean(normalizeUrl(value));
}

function officialBonnUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return '';
  const url = new URL(normalized);
  return OFFICIAL_BONN_HOSTS.has(url.hostname.toLowerCase()) ? url.href : '';
}

function assertAllowedNetworkUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    throw new OParlClientError(
      OParlClientErrorCode.INVALID_URL,
      `Ungültige OParl-URL: ${String(value || '')}`,
      { url: String(value || '') }
    );
  }
  const url = new URL(normalized);
  if (!OFFICIAL_BONN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new OParlClientError(
      OParlClientErrorCode.UNTRUSTED_HOST,
      `Nicht vertrauenswürdiger Host im Bonner OParl-Pfad: ${url.hostname}`,
      { url: url.href, allowedHosts: [...OFFICIAL_BONN_HOSTS] }
    );
  }
  return url.href;
}

function requestText(urlValue, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    redirectCount = 0,
  } = options;

  let url;
  try { url = assertAllowedNetworkUrl(urlValue); }
  catch (error) { return Promise.reject(error); }

  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.get(url, {
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json, application/ld+json;q=0.9, */*;q=0.1',
        'User-Agent': 'Unfallwerkbank-OParl/1.0 (+https://github.com/carstenartur/Unfallatlas)',
      },
    }, res => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectCount >= maxRedirects) {
          reject(new OParlClientError(
            OParlClientErrorCode.TOO_MANY_REDIRECTS,
            `Zu viele Weiterleitungen beim OParl-Abruf: ${url}`,
            { url, status, redirectCount }
          ));
          return;
        }
        requestText(normalizeUrl(res.headers.location, url), {
          ...options,
          redirectCount: redirectCount + 1,
        }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new OParlClientError(
          OParlClientErrorCode.HTTP_ERROR,
          `OParl HTTP ${status || 'unbekannt'} für ${url}`,
          { url, status }
        ));
        return;
      }

      const chunks = [];
      let bytes = 0;
      let aborted = false;
      res.on('data', chunk => {
        if (aborted) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          aborted = true;
          const error = new OParlClientError(
            OParlClientErrorCode.RESPONSE_TOO_LARGE,
            `OParl-Antwort überschreitet ${maxBytes} Byte: ${url}`,
            { url, maxBytes }
          );
          res.destroy(error);
          reject(error);
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        if (!aborted) {
          resolve({
            url,
            status,
            contentType: String(res.headers['content-type'] || ''),
            text: Buffer.concat(chunks).toString('utf8'),
          });
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new OParlClientError(
        OParlClientErrorCode.HTTP_ERROR,
        `OParl-Timeout nach ${timeoutMs} ms: ${url}`,
        { url, timeoutMs }
      ));
    });
    req.on('error', reject);
  });
}

async function fetchJson(url, options = {}) {
  const response = await requestText(url, options);
  try {
    return JSON.parse(response.text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new OParlClientError(
      OParlClientErrorCode.INVALID_JSON,
      `Ungültiges JSON vom OParl-Endpunkt ${response.url}: ${error.message}`,
      { url: response.url, status: response.status, contentType: response.contentType }
    );
  }
}

function appendQuery(urlValue, params = {}) {
  const url = new URL(urlValue);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (!url.searchParams.has(key)) url.searchParams.set(key, String(value));
  }
  return url.href;
}

function parseListPage(payload, currentUrl) {
  if (Array.isArray(payload)) return { data: payload, next: '', pagination: {} };
  if (!payload || typeof payload !== 'object') {
    throw new OParlClientError(
      OParlClientErrorCode.INVALID_LIST,
      `OParl-Liste ist kein Objekt/Array: ${currentUrl}`,
      { url: currentUrl }
    );
  }
  if (Array.isArray(payload.data)) {
    const next = normalizeUrl(payload.links && payload.links.next, currentUrl);
    const pagination = payload.pagination && typeof payload.pagination === 'object'
      ? payload.pagination
      : {};
    const currentPage = Number(pagination.currentPage);
    const totalPages = Number(pagination.totalPages);
    if (!next && Number.isFinite(currentPage) && Number.isFinite(totalPages)
        && currentPage < totalPages) {
      throw new OParlClientError(
        OParlClientErrorCode.INVALID_LIST,
        `OParl-Liste meldet weitere Seiten, enthält aber keinen links.next: ${currentUrl}`,
        { url: currentUrl, currentPage, totalPages }
      );
    }
    return { data: payload.data, next, pagination };
  }
  if (payload.id || payload.type) return { data: [payload], next: '', pagination: {} };
  throw new OParlClientError(
    OParlClientErrorCode.INVALID_LIST,
    `OParl-Liste enthält kein data-Array: ${currentUrl}`,
    { url: currentUrl, keys: Object.keys(payload).slice(0, 20) }
  );
}

async function fetchExternalList(listUrl, options = {}) {
  const fetchJsonImpl = options.fetchJsonImpl || fetchJson;
  const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
  const visited = new Set();
  const items = [];
  const pages = [];
  let currentUrl = appendQuery(listUrl, options.query || {});
  let truncated = false;

  while (currentUrl) {
    if (visited.has(currentUrl)) {
      throw new OParlClientError(
        OParlClientErrorCode.PAGINATION_CYCLE,
        `OParl-Paginierung enthält einen Zyklus: ${currentUrl}`,
        { url: currentUrl, visited: [...visited] }
      );
    }
    if (pages.length >= maxPages) {
      truncated = true;
      break;
    }
    visited.add(currentUrl);
    const payload = await fetchJsonImpl(currentUrl, options.requestOptions || {});
    const page = parseListPage(payload, currentUrl);
    items.push(...page.data);
    pages.push({ url: currentUrl, count: page.data.length, pagination: page.pagination });
    currentUrl = page.next;
  }

  return {
    items,
    pages,
    pagesFetched: pages.length,
    truncated,
    nextUrl: truncated ? currentUrl : '',
  };
}

module.exports = {
  OParlClientError,
  OParlClientErrorCode,
  DEFAULT_MAX_PAGES,
  positiveInteger,
  normalizeUrl,
  isHttpUrl,
  officialBonnUrl,
  assertAllowedNetworkUrl,
  requestText,
  fetchJson,
  appendQuery,
  parseListPage,
  fetchExternalList,
};