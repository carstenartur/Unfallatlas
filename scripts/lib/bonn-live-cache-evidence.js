'use strict';

const http = require('node:http');
const https = require('node:https');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { URL, urlToHttpOptions } = require('node:url');
const OPARL_ORIGIN = 'https://www.bonn.sitzung-online.de';

function publicOparlRequest(transport, args) {
  try {
    const input = args[0];
    const base = typeof input === 'string' || input instanceof URL ? urlToHttpOptions(new URL(input)) : input;
    const extra = args[1] && typeof args[1] === 'object' ? args[1] : {};
    const options = { ...base, ...extra };
    const protocol = options.protocol || (transport === https ? 'https:' : 'http:');
    const host = options.hostname || options.host || '';
    if (transport !== https || protocol !== 'https:' || !host || /[\s\\]/u.test(host) || options.auth || options.socketPath) return false;
    const origin = new URL(`${protocol}//${host}`);
    if (options.port !== undefined) origin.port = String(options.port);
    const requestPath = options.path || '/';
    if (typeof requestPath !== 'string' || !requestPath.startsWith('/') || requestPath.startsWith('//') || /[\s\\]/u.test(requestPath)) return false;
    const rawPath = requestPath.split('?')[0];
    if (!rawPath.startsWith('/oparl/') || /[%\\#]|\/{2}|(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath)) return false;
    const url = new URL(requestPath, origin);
    return origin.origin === OPARL_ORIGIN && !origin.username && !origin.password
      && url.origin === OPARL_ORIGIN && url.pathname.startsWith('/oparl/') && !/[\\%]/u.test(url.pathname);
  } catch (_) { return false; }
}

const errorView = error => ({ name: error?.name || 'Error', code: error?.code || null,
  message: String(error?.message || error).slice(0, 500) });
const termKey = terms => JSON.stringify(terms.map(t => t.trim().toLocaleLowerCase('de-DE')).sort());
function reuseTerms(terms) {
  const used = new Set([termKey(terms)]);
  return [['Oxfordstraße'], ['Adenauerallee'], ['Radverkehr'], ['Bonn']].filter(candidate => {
    const key = termKey(candidate);
    if (used.has(key)) return false;
    used.add(key); return true;
  }).slice(0, 2);
}

function validateReuse(cases) {
  const errors = [];
  const source = cases.cold.result?.meta?.catalogueCache;
  if (!Number.isSafeInteger(source?.pages) || source.pages < 1 || !Number.isSafeInteger(source?.items) || source.items < 0
      || typeof source?.sourceUrl !== 'string' || !source.sourceUrl
      || source.sourceUrl !== cases.cold.result?.meta?.sourceUrl) errors.push('cold: catalogue counts or source identity are unknown.');
  for (const [label, status] of [['cold', 'miss'], ['coalesced', 'coalesced'], ['warm', 'hit']]) {
    const current = cases[label], meta = current.result?.meta, cache = meta?.catalogueCache;
    if (current.error || current.status === 'not-run') errors.push(`${label}: search did not complete (${current.error?.message || current.reason}).`);
    if (cache?.status !== status) errors.push(`${label}: expected catalogue ${status}, got ${cache?.status || 'missing'}.`);
    if (!['results-found', 'searched-no-results'].includes(meta?.searchStatus) || meta?.truncated !== false
        || cache?.truncated !== false || cache?.refreshFailure !== null) errors.push(`${label}: incomplete or failed catalogue cannot pass reuse acceptance.`);
    if (!Number.isFinite(current.elapsedMs) || current.elapsedMs < 0) errors.push(`${label}: missing actual monotonic duration.`);
    if (!source?.refreshedAt || !Number.isFinite(Date.parse(source.refreshedAt))
        || cache?.refreshedAt !== source.refreshedAt || cache?.sourceUrl !== source.sourceUrl
        || cache?.pages !== source.pages || cache?.items !== source.items) errors.push(`${label}: catalogue source clock/identity/counts changed or are unknown.`);
    if (label === 'cold') {
      if (cache?.layer !== 'source-pages' || !Number.isSafeInteger(cache?.networkRequests) || cache.networkRequests < 1
          || current.networkRequests < 1) errors.push('cold: no actual initial source acquisition was observed.');
    } else if (cache?.layer !== 'catalogue' || cache?.networkRequests !== 0 || cache?.misses !== 0
        || cache?.hits !== 1 || current.networkRequests !== 0) errors.push(`${label}: additional source requests or missing catalogue hit evidence.`);
    if (current.blockedNetworkRequests) errors.push(`${label}: ${current.blockedNetworkRequests} unexpected network attempt(s) blocked before transmission.`);
  }
  return errors;
}

function installPublicOparlGuard(context) {
  const originals = [http, https].flatMap(transport => ['get', 'request'].map(method => [transport, method, transport[method]]));
  // QA-only tripwire: public OParl acquisition only; join/hit never recrawls.
  // Production fetchers/keys remain untouched, including injected-fetch isolation.
  for (const [transport, method, original] of originals) transport[method] = function(...args) {
    const active = context.getStore();
    // Validate every entry, including delegated calls, before counting it.
    // A failed primary must never enter an HTML access-check fallback.
    if (active && (active.label !== 'cold' || !publicOparlRequest(transport, args))) {
      active.record.blockedNetworkRequests++;
      throw Object.assign(new Error(`Blocked ${active.label} request: only initial official HTTPS /oparl/ acquisition is permitted.`), { code: active.label === 'cold' ? 'QA_OPARL_BOUNDARY' : 'QA_UNEXPECTED_SOURCE_REQUEST' });
    }
    // GET may synchronously delegate to request(); that is one I/O entry.
    if (!active || active.transportDepth) return original.apply(this, args);
    active.record.networkRequests++;
    active.transportDepth = 1;
    try { return original.apply(this, args); }
    finally { active.transportDepth = 0; }
  };
  return () => { for (const [transport, method, original] of originals) transport[method] = original; };
}

async function runCatalogueReuse({ search, parameters, terms }) {
  const context = new AsyncLocalStorage();
  const cases = {};
  const restore = installPublicOparlGuard(context);
  async function timed(label, searchTerms) {
    const record = cases[label] = { terms: searchTerms, startedAt: new Date().toISOString(), networkRequests: 0, blockedNetworkRequests: 0 };
    const start = performance.now();
    try { record.result = await context.run({ label, record }, () => search({ ...parameters, searchTerms, useCache: false })); }
    catch (error) { record.error = errorView(error); }
    record.elapsedMs = performance.now() - start;
    record.completedAt = new Date().toISOString();
    return record;
  }
  try {
    const [joinedTerms, warmTerms] = reuseTerms(terms);
    await Promise.all([timed('cold', terms), timed('coalesced', joinedTerms)]);
    const cold = cases.cold.result?.meta, joined = cases.coalesced.result?.meta;
    if (cases.cold.error || cases.coalesced.error || cold?.truncated !== false || joined?.truncated !== false
        || cold?.catalogueCache?.status !== 'miss' || joined?.catalogueCache?.status !== 'coalesced'
        || cases.coalesced.blockedNetworkRequests) {
      cases.warm = { status: 'not-run', terms: warmTerms, networkRequests: 0, blockedNetworkRequests: 0,
        reason: 'Cold/join evidence failed; no further source acquisition is permitted.' };
    } else await timed('warm', warmTerms);
  } finally { restore(); }
  const validationErrors = validateReuse(cases);
  return { ...cases, passed: validationErrors.length === 0, validationErrors };
}

async function collectSnapshotEvidence({ options, retryDelayMs = 3000, onRetry = () => {} }) {
  const { collectBonnCatalogue } = require('../../server/political-context/providers/bonnOparlClient');
  const context = new AsyncLocalStorage();
  const transport = { networkRequests: 0, blockedNetworkRequests: 0 };
  const restore = installPublicOparlGuard(context);
  const checkBoundary = () => {
    // The production collector may catch a failed discovery/redirect and recover
    // public papers. Such recovery cannot erase a forbidden transport attempt.
    if (transport.blockedNetworkRequests) throw Object.assign(
      new Error(`Snapshot acquisition blocked ${transport.blockedNetworkRequests} non-public-OParl request attempt(s).`),
      { code: 'QA_OPARL_BOUNDARY' }
    );
  };
  try {
    return await context.run({ label: 'cold', record: transport }, async () => {
      let catalogue = await collectBonnCatalogue(options);
      checkBoundary();
      if (!catalogue.records.length) {
        onRetry(catalogue);
        await delay(retryDelayMs);
        catalogue = await collectBonnCatalogue(options);
        checkBoundary();
      }
      return { catalogue, transport };
    });
  } catch (error) {
    error.transport = { ...transport };
    throw error;
  } finally {
    restore();
  }
}

module.exports = { runCatalogueReuse, validateReuse, collectSnapshotEvidence };
