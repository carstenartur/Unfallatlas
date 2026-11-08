'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createRisSourceCache } = require('../services/risSourceCache');
const { createRisSourceCheckpoint } = require('../services/risSourceCheckpoint');
const { classifyTrafficRelevance } = require('../services/trafficRelevanceService');

// Public ALLRIS documents are normalized once, regardless of whether their
// HTML was obtained by the portal session or replayed from a captured page.
const ORIGIN = 'https://ris.hannit.de';
const LIST_URL = `${ORIGIN}/public/vo040`;
const SOURCE = 'region-hannover-ris';
const REVISION = 'region-hannover-public-v1';
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const DAY = 86400000;
const CHECKPOINT_SCOPE = 'public-proposals';
const DISCOVERY_SCOPE = 'public-proposals-discovery';
const META_YEAR = 1900; // Storage bucket for discovery state and undated metadata.
const ATTRS = String.raw`((?:[^"'<>]|"[^"]*"|'[^']*')*)`;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', szlig: 'ß',
  ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', shy: '', euro: '€', sect: '§' };

function entities(value) {
  return String(value || '').replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*);/gi, (whole, key) => {
    if (key[0] !== '#') return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : whole;
    const point = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

function text(markup = '') {
  return entities(String(markup).replace(/<!--[\s\S]*?-->|<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')).replace(/[<>\p{Cf}\p{Cs}]/gu, '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

function elements(markup, tag) {
  return [...markup.matchAll(new RegExp(`<${tag}\\b${ATTRS}>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))];
}

function attributes(markup) {
  const result = Object.create(null);
  for (const [, name, double, single, bare] of String(markup).matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g)) {
    const key = name.toLowerCase();
    if (!Object.hasOwn(result, key)) result[key] = entities(double ?? single ?? bare ?? '');
  }
  return result;
}

function officialUrl(value, base = LIST_URL) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\s\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new Error('Invalid Region Hannover source URL');
  }
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  if (absolute && !/^https:\/\/ris\.hannit\.de(?:[/?#]|$)/.test(value)) throw new Error('Invalid Region Hannover source origin');
  const url = new URL(value, base);
  if (url.origin !== ORIGIN || url.username || url.password || url.port || !url.pathname.startsWith('/public/') || url.pathname.includes('//')) {
    throw new Error('Invalid Region Hannover source origin');
  }
  return url;
}

function proposalIdentity(value, base = LIST_URL) {
  const url = officialUrl(value, base);
  const ids = url.searchParams.getAll('VOLFDNR');
  if (url.pathname.toLowerCase() !== '/public/vo020' || ids.length !== 1 || !/^[1-9]\d{0,11}$/.test(ids[0])) {
    throw new Error('Invalid Region Hannover proposal URL');
  }
  return { id: `${SOURCE}:vo:${ids[0]}`, url: `${ORIGIN}/public/vo020?VOLFDNR=${ids[0]}` };
}

function sourceHtml(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_HTML_BYTES) throw new Error('Invalid Region Hannover source response size');
  if (/<altcha-widget\b|Zugriff\s+pruefen|Schutz vor automatisierten Zugriffen/i.test(value)) throw new Error('Region Hannover source access gate');
  return value;
}

function germanDate(value) {
  const match = String(value || '').match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

function semantics(kind) {
  // An administrative proposal is not a resolution, and an answer to an
  // inquiry is not itself an inquiry. Prefer the explicit portal category.
  if (/Antwort|Stellungnahme/i.test(kind)) return { type: 'Verwaltungsantwort', status: 'answer' };
  if (/Änderungsantrag/i.test(kind)) return { type: 'Änderungsantrag', status: 'proposal' };
  if (/Anfrage/i.test(kind)) return { type: 'Anfrage', status: 'proposal' };
  if (/Antrag/i.test(kind)) return { type: 'Antrag', status: 'proposal' };
  if (/Protokoll|Niederschrift/i.test(kind)) return { type: 'Protokoll', status: 'minutes' };
  return { type: 'Sonstige', status: /Beschlussvorlage|Beschlussempfehlung|Beschlussdrucksache/i.test(kind) ? 'proposal' : 'other' };
}

function sourceContext(kind, dates = {}) {
  return { level: 'region', publisher: 'Region Hannover', issuer: null, documentKind: kind || 'Vorlage',
    status: semantics(kind).status, publicationDate: null, documentDate: null, meetingDate: null, ...dates };
}

function ajaxCallbacks(markup) {
  const callbacks = [];
  // Only JSON callback descriptions are read. JavaScript from a source page
  // is never evaluated, including the surrounding Wicket initializer code.
  for (const [, serialized] of markup.matchAll(/Wicket\.Ajax\.ajax\((\{[^\r\n]*?\})\)/g)) {
    try {
      const value = JSON.parse(serialized);
      if (typeof value.u === 'string') callbacks.push(value);
    } catch (_) { /* Initializers with JavaScript expressions are not GET links. */ }
  }
  return callbacks;
}

function callbackRequest(callback, pageUrl) {
  if (!callback) return null;
  if (callback.m && callback.m !== 'GET') throw new Error('Unsupported Region Hannover list callback method');
  const url = officialUrl(callback.u, pageUrl);
  if (url.pathname !== '/public/vo040') throw new Error('Invalid Region Hannover list callback route');
  return { url: url.href, ajax: true };
}

function parseProposalListHtml(value, pageUrl = LIST_URL) {
  const url = officialUrl(pageUrl);
  if (url.pathname.toLowerCase() !== '/public/vo040') throw new Error('Invalid Region Hannover list URL');
  const html = sourceHtml(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const callbacks = ajaxCallbacks(html);
  const table = elements(html, 'table').find(([, , body]) => {
    const headings = elements(body, 'th').map(([, , cell]) => text(cell));
    return ['Nummer', 'Betreff', 'OE', 'Vorlage freigegeben', 'Art'].every((label, index) => headings[index] === label);
  });
  const range = text(html).match(/\bZeige\s+(\d+)\s+bis\s+(\d+)\s+von\s+([\d.]+)\b/i);
  if (!table || !range) {
    const timer = /Wicket\.Timer\.set\(/.test(html) && callbacks.find(callback => !callback.c);
    if (timer) return { documents: [], start: null, end: null, total: null, next: null,
      loading: callbackRequest(timer, pageUrl) };
    throw new Error('Unrecognised public Region Hannover proposal list');
  }
  const [start, end, total] = range.slice(1).map(v => Number(v.replace(/\./g, '')));
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || start > end || end > total) throw new Error('Invalid Region Hannover list range');
  const records = new Map();
  const tbody = elements(table[2], 'tbody')[0]?.[2];
  if (tbody === undefined) throw new Error('Missing Region Hannover proposal table body');
  const rows = elements(tbody, 'tr');
  if (rows.length !== (total ? end - start + 1 : 0)) throw new Error('Region Hannover raw row count does not match its range');
  for (const [, , row] of rows) {
    const cells = elements(row, 'td').map(([, , cell]) => cell);
    if (cells.length !== 5) throw new Error('Invalid Region Hannover proposal row');
    const link = elements(cells[1], 'a')[0];
    if (!link) throw new Error('Missing Region Hannover proposal link');
    const identity = proposalIdentity(attributes(link[1]).href, pageUrl);
    const title = text(link[2]), number = text(cells[0]), rawType = text(cells[4]);
    if (!title || !number || title.length > 4096 || rawType.length > 256) throw new Error('Invalid Region Hannover proposal metadata');
    const publicationDate = germanDate(text(cells[3]));
    records.set(identity.id, { ...identity, title, number, rawType, type: semantics(rawType).type,
      date: publicationDate, gremium: null, source: SOURCE, locationEvidenceUnavailable: true,
      sourceContext: sourceContext(rawType, { publicationDate }) });
  }
  if (total && !records.size) throw new Error('Empty Region Hannover list with advertised results');
  const nextButton = elements(html, 'button').find(([, value]) => {
    const attrs = attributes(value);
    return /(?:^|\s)next(?:\s|$)/.test(attrs.class || '') && !Object.hasOwn(attrs, 'disabled');
  });
  const nextId = nextButton && attributes(nextButton[1]).id;
  const next = end < total ? callbackRequest(callbacks.find(callback => callback.c === nextId && nextId), pageUrl) : null;
  const sizes = divs(html).find(block => block.attrs.id === 'objPerPage');
  const hundred = sizes && elements(sizes.content, 'a').find(([, attrs, label]) => text(label) === '100'
    && callbacks.some(callback => callback.c === attributes(attrs).id));
  const pageSizeRequest = hundred ? callbackRequest(callbacks.find(callback => callback.c === attributes(hundred[1]).id), pageUrl) : null;
  return { documents: [...records.values()], start, end, total, next, pageSizeRequest,
    ...(end < total && !next ? { paginationUnavailable: true } : {}) };
}

function visibleMarkup(value) {
  const markup = value.replace(/<!--[\s\S]*?-->|<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const tags = new RegExp(`<(/?)([a-z][\\w:-]*)\\b${ATTRS}>`, 'gi');
  const ignored = [];
  let cursor = 0, visible = '';
  for (const token of markup.matchAll(tags)) {
    const [whole, close, rawName, rawAttributes] = token;
    const name = rawName.toLowerCase(), end = token.index + whole.length;
    const voidTag = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) || /\/\s*>$/.test(whole);
    if (ignored.length) {
      if (close && ignored.at(-1) === name) ignored.pop();
      else if (!close && !voidTag) ignored.push(name);
      cursor = end;
      continue;
    }
    if (close) continue;
    const attrs = attributes(rawAttributes);
    if (/^(?:del|s|strike|blockquote)$/.test(name) || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden'] === 'true'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden|text-decoration[^:;]*:[^;]*line-through)/i.test(attrs.style || '')) {
      visible += `${markup.slice(cursor, token.index)} `;
      cursor = end;
      if (!voidTag) ignored.push(name);
    }
  }
  return visible + (ignored.length ? '' : markup.slice(cursor));
}

function divs(markup) {
  const stack = [], result = [];
  for (const token of markup.matchAll(new RegExp(`<(/?)div\\b${ATTRS}>`, 'gi'))) {
    if (!token[1]) stack.push({ index: token.index, start: token.index + token[0].length, attrs: attributes(token[2]) });
    else if (stack.length) {
      const open = stack.pop();
      result.push({ ...open, end: token.index + token[0].length, content: markup.slice(open.start, token.index) });
    }
  }
  return result.sort((a, b) => a.index - b.index);
}

function definitionLists(markup) {
  const fields = new Map();
  for (const [, , list] of elements(markup, 'dl')) {
    const term = elements(list, 'dt')[0], detail = elements(list, 'dd')[0];
    const key = text(term?.[2]).replace(/\s*:\s*$/, '');
    if (key && detail && !fields.has(key)) fields.set(key, text(detail[2]));
  }
  return fields;
}

function documentEvidence(main) {
  const headings = elements(main, 'h2');
  const paragraphs = [];
  let truncated = false, characters = 0;
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (!/^(?:Beschlussvorschlag|Sachverhalt|Begründung)\s*:?$/i.test(text(heading[2]))) continue;
    const section = main.slice(heading.index + heading[0].length, headings[i + 1]?.index);
    const blocks = divs(section).filter(block => /(?:^|\s)docPart(?:\s|$)/.test(block.attrs.class || ''));
    for (const block of blocks) {
      for (const paragraph of block.content.split(/<(?:br\b[^>]*|\/(?:p|li|div|tr)\s*)>/i).map(text).filter(Boolean)) {
        if (paragraph.length > 4000 || characters + paragraph.length > 256000 || paragraphs.length >= 1000) { truncated = true; continue; }
        paragraphs.push(paragraph); characters += paragraph.length;
      }
    }
  }
  return { locationEvidence: paragraphs,
    ...(!paragraphs.length ? { locationEvidenceUnavailable: true } : {}),
    ...(truncated ? { locationEvidenceTruncated: true } : {}) };
}

function consultations(main, pageUrl) {
  const table = elements(main, 'table').find(([, , content]) => text(elements(content, 'caption')[0]?.[2]) === 'Beratungsfolge');
  const events = [];
  let currentBody = null, firstBody = null;
  if (!table) return { events, gremium: null };
  const headers = elements(table[2], 'th').map(([, , content]) => text(content));
  if (!['Status', 'Datum', 'Gremium', 'Beschluss', 'PA'].every((label, index) => headers[index] === label)) {
    throw new Error('Unrecognised Region Hannover consultation table');
  }
  for (const [, , row] of elements(table[2], 'tr')) {
    const cells = elements(row, 'td').map(([, , content]) => content);
    if (!cells.length) continue;
    if (cells.length !== 5) throw new Error('Invalid Region Hannover consultation row');
    const date = germanDate(text(cells[1]));
    const label = text(cells[2]), outcome = text(cells[3]) || null;
    if (!date && label && !elements(cells[2], 'a').length) currentBody = label;
    const body = date ? currentBody || label || null : label || null;
    firstBody ||= body;
    // The parent rows describe a committee's role. Only the dated child rows
    // or an explicit other disposition describe an actual consultation event.
    if (!date && /^(?:Vorberatung|Entscheidung|Anhörung)$/i.test(outcome || '')) continue;
    if (!date && !body && !outcome) continue;
    let eventUrl = pageUrl;
    for (const cell of [cells[3], cells[4], cells[2]]) {
      for (const [, attrs] of elements(cell, 'a')) {
        try {
          const candidate = officialUrl(attributes(attrs).href, pageUrl);
          if (!/^\/public\/(?:to|si)0\d+$/i.test(candidate.pathname)) continue;
          eventUrl = candidate.href;
          break;
        } catch (_) { /* A non-official link is not evidence. */ }
      }
      if (eventUrl !== pageUrl) break;
    }
    const evidence = text(row);
    if (evidence.length > 16384) throw new Error('Region Hannover consultation evidence exceeds its bound');
    events.push({ date, body, outcome, url: eventUrl, evidence });
  }
  return { events, gremium: firstBody };
}

function parseProposalHtml(value, pageUrl) {
  const identity = proposalIdentity(pageUrl);
  const html = visibleMarkup(sourceHtml(value));
  const main = elements(html, 'main').find(([, attrs]) => attributes(attrs).id === 'pageContent')?.[2];
  if (!main) throw new Error('Unrecognised public Region Hannover proposal shape');
  const fields = definitionLists(main);
  const rawStatus = fields.get('Status') || '';
  if (/^(?:nicht[\s-]*öffentlich|vertraulich)(?:\s|$|[;(])/i.test(rawStatus)) {
    throw Object.assign(new Error('Region Hannover proposal is explicitly not öffentlich (public)'), { code: 'REGION_PROPOSAL_NOT_PUBLIC' });
  }
  if (!/^öffentlich(?:\s|$|[;(])/i.test(rawStatus)) throw new Error('Region Hannover proposal has no recognized public (öffentlich) status');
  const title = fields.get('Betreff'), rawType = fields.get('Vorlageart');
  const heading = text(elements(main, 'h1')[0]?.[2]);
  const prefix = `${rawType} - `;
  const number = heading.startsWith(prefix) ? heading.slice(prefix.length).trim() : null;
  if (!title || title.length > 4096 || !rawType || rawType.length > 256 || !number) throw new Error('Invalid Region Hannover public proposal metadata');
  const { events, gremium } = consultations(main, identity.url);
  let originalPdfUrl;
  for (const [, attrs, content] of elements(main, 'a')) {
    if (text(content) !== 'Vorlage') continue;
    try {
      const url = officialUrl(attributes(attrs).href, identity.url);
      if (/\.pdf$/i.test(url.pathname)) { originalPdfUrl = url.href; break; }
    } catch (_) { /* Ignore files outside the official source. */ }
  }
  return { ...identity, title, number, rawType, rawStatus, type: semantics(rawType).type,
    date: null, gremium, source: SOURCE,
    sourceContext: sourceContext(rawType, { issuer: fields.get('Federführend') || null }),
    ...documentEvidence(main), events, ...(originalPdfUrl ? { originalPdfUrl } : {}) };
}

function bound(value, fallback, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new TypeError(`Invalid Region Hannover ${name}`);
  return result;
}

function validDay(value) {
  return value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function validTimestamp(value, now) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) <= now.getTime();
}

function validStoredRecord(record) {
  try {
    if (!record || record.source !== SOURCE || typeof record.title !== 'string' || !record.title || record.title.length > 4096
      || typeof record.number !== 'string' || !record.number || typeof record.rawType !== 'string' || !validDay(record.date)
      || record.sourceContext?.level !== 'region' || !validDay(record.sourceContext.publicationDate)) return false;
    const identity = proposalIdentity(record.url);
    return identity.id === record.id && identity.url === record.url;
  } catch (_) { return false; }
}

function validStoredDetail(record, now) {
  return validStoredRecord(record) && /^öffentlich(?:\s|$|[;(])/i.test(record.rawStatus || '')
    && (record.detailVerifiedAt === undefined || validTimestamp(record.detailVerifiedAt, now))
    && Array.isArray(record.locationEvidence) && record.locationEvidence.length <= 1000
    && record.locationEvidence.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4000)
    && record.locationEvidence.reduce((length, value) => length + value.length, 0) <= 256000;
}

function accessDenial(error) {
  return [401, 403, 429].includes(error?.details?.status ?? error?.status)
    || /ALLRIS_PORTAL_(?:GATE_REJECTED|VERIFY_FAILED)$/.test(error?.code || '');
}

function yearOf(entry) {
  const date = entry.metadata?.sourceContext?.publicationDate || entry.metadata?.date;
  return date ? Number(date.slice(0, 4)) : META_YEAR;
}

function mergedRecord(entry) {
  const record = { ...entry.metadata, ...(entry.detail || {}) };
  if (entry.detail) {
    record.date = entry.detail.date || entry.metadata.date;
    record.sourceContext = { ...entry.metadata.sourceContext, ...entry.detail.sourceContext,
      publicationDate: entry.metadata.sourceContext.publicationDate };
    record.detailVerifiedAt = entry.detailVerifiedAt;
    if (record.locationEvidence?.length && !entry.detailUnavailable) delete record.locationEvidenceUnavailable;
    if (entry.detailUnavailable) record.locationEvidenceUnavailable = true;
  }
  return record;
}

async function collectRegionHannoverCatalogue(options = {}) {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid Region Hannover source clock');
  const from = options.from ?? '2014-01-01';
  if (!validDay(from) || from === null) throw new TypeError('Invalid Region Hannover requested start date');
  const maxDocuments = bound(options.maxDocuments, 50000, 1000000, 'document limit');
  const maxPages = bound(options.maxPages, 600, 10000, 'page limit');
  const maxDetails = bound(options.maxDetails, 2000, 100000, 'detail limit');
  const concurrency = bound(options.concurrency, 6, 16, 'concurrency');
  if (!concurrency) throw new TypeError('Region Hannover detail concurrency must be positive');
  const maxDurationMs = bound(options.maxDurationMs, 15 * 60_000, DAY, 'duration limit');
  const timeoutMs = bound(options.timeoutMs, 20000, 120000, 'request timeout');
  const workBudget = options.workBudget === undefined ? Infinity : bound(options.workBudget, 0, 1000000, 'work budget');
  const directory = options.sourceDirectory || path.resolve(__dirname, '../../../.cache/ris-sources');
  const sourceCache = options.sourceCache || createRisSourceCache({ directory, now: () => now.getTime() });
  const checkpoint = options.checkpoint || createRisSourceCheckpoint({ directory });
  const report = options.report || (() => {});
  const deadline = performance.now() + maxDurationMs;
  const entries = new Map(), dirty = new Set();
  let requests = 0, pages = 0, newPages = 0, failedDetails = 0, interrupted = false, accessDenied = false, discoveryDirty = false;
  const failures = [];
  const fresh = value => validTimestamp(value, now) && now.getTime() - Date.parse(value) < 7 * DAY;
  const canFetch = () => !accessDenied && requests < workBudget && performance.now() < deadline;
  const budgetError = () => Object.assign(new Error('Region Hannover source work budget exhausted'), { code: 'REGION_WORK_BUDGET' });
  let session;
  const requestHtml = options.fetchHtmlImpl || (async (url, requestOptions) => {
    session ||= require('./allrisPortalGateClient').createAllrisPortalSession({ portalBase: ORIGIN, timeoutMs, maxBytes: MAX_HTML_BYTES });
    return session.fetchHtml(url, requestOptions);
  });
  async function fetchPage(request) {
    if (!canFetch()) throw budgetError();
    requests++; pages++;
    const response = await requestHtml(request.url, { timeoutMs,
      ...(request.ajax ? { headers: { 'Wicket-Ajax': 'true', 'Wicket-Ajax-BaseURL': 'vo040', 'X-Requested-With': 'XMLHttpRequest' } } : {}) });
    const html = typeof response === 'string' ? response : response?.html;
    const retrievedAt = typeof response === 'string' ? now.toISOString() : response?.retrievedAt;
    if (!validTimestamp(retrievedAt, now)) throw new Error('Invalid Region Hannover captured retrieval timestamp');
    return { ...parseProposalListHtml(html, request.url), retrievedAt };
  }
  async function listPage(request) {
    let page = await fetchPage(request);
    for (let attempts = 0; page.loading && attempts < 8; attempts++) {
      if (!canFetch()) throw budgetError();
      // The observed public page schedules this loader one second after load.
      await new Promise(resolve => setTimeout(resolve, options.fetchHtmlImpl ? 0 : 1000));
      page = await fetchPage(page.loading);
    }
    if (page.loading) throw new Error('Region Hannover proposal list remained loading');
    return page;
  }
  for (const year of await checkpoint.years(SOURCE, CHECKPOINT_SCOPE)) {
    const stored = await checkpoint.read(SOURCE, CHECKPOINT_SCOPE, year, REVISION);
    if (!Array.isArray(stored?.records) || stored.records.length > 50000) continue;
    for (const entry of stored.records) {
      if (!validStoredRecord(entry?.metadata) || !validTimestamp(entry.metadataVerifiedAt, now)) continue;
      const next = { metadata: entry.metadata, metadataVerifiedAt: entry.metadataVerifiedAt };
      if (validTimestamp(entry.lastAttemptedAt, now)) next.lastAttemptedAt = entry.lastAttemptedAt;
      if (Number.isSafeInteger(entry.detailAttempts) && entry.detailAttempts >= 0 && entry.detailAttempts <= 1000000) next.detailAttempts = entry.detailAttempts;
      if (validStoredDetail(entry.detail, now) && entry.detail.id === entry.metadata.id && validTimestamp(entry.detailVerifiedAt, now)) {
        next.detail = entry.detail; next.detailVerifiedAt = entry.detailVerifiedAt;
        if (entry.detailUnavailable) next.detailUnavailable = true;
      }
      if (entry.exclusionReason === 'not-public' && validTimestamp(entry.excludedAt, now)) {
        next.excludedAt = entry.excludedAt; next.exclusionReason = 'not-public';
      }
      entries.set(next.metadata.id, next);
    }
  }
  const prior = await checkpoint.read(SOURCE, DISCOVERY_SCOPE, META_YEAR, REVISION);
  let discovery = prior && typeof prior.complete === 'boolean' && Number.isSafeInteger(prior.lastPosition)
    && prior.lastPosition >= 0 && Number.isSafeInteger(prior.total) && prior.total >= prior.lastPosition
    && validTimestamp(prior.verifiedAt, now) ? prior : { complete: false, lastPosition: 0, total: 0, verifiedAt: null };
  if (discovery.complete && !fresh(discovery.verifiedAt)) discovery = { ...discovery, complete: false, lastPosition: 0 };
  async function save() {
    for (const year of dirty) {
      await checkpoint.write(SOURCE, CHECKPOINT_SCOPE, year, REVISION, {
        records: [...entries.values()].filter(entry => yearOf(entry) === year) });
    }
    dirty.clear();
    if (discoveryDirty && discovery.verifiedAt) await checkpoint.write(SOURCE, DISCOVERY_SCOPE, META_YEAR, REVISION, discovery);
    discoveryDirty = false;
  }
  // An opaque Wicket cursor cannot survive a new session. Do not spend a small
  // finite budget endlessly replaying the same prefix when it can instead
  // verify missing details from the already observed public list.
  const navigationBudgetNeeded = entries.size && !discovery.complete ? 3 + Math.floor(discovery.lastPosition / 100) : 0;
  const insufficientNavigationBudget = navigationBudgetNeeded > workBudget;
  if (insufficientNavigationBudget && maxPages > 0) {
    interrupted = true;
    failures.push(`Das Netzbudget reicht nicht für die erneute Seitennavigation (mindestens ${navigationBudgetNeeded} Abrufe); vorhandene Vorlagen werden weiter geprüft.`);
  }
  if (!discovery.complete && !insufficientNavigationBudget && maxPages > 0 && maxDocuments > 0 && canFetch()) {
    const resumedThrough = discovery.lastPosition;
    let request = { url: LIST_URL }, previousEnd = 0, resized = false;
    try {
      while (request && canFetch()) {
        const page = await listPage(request);
        let capped = false;
        for (const metadata of page.documents) {
          const old = entries.get(metadata.id);
          if (!old && entries.size >= maxDocuments) { capped = true; interrupted = true; break; }
          const entry = { ...old, metadata, metadataVerifiedAt: page.retrievedAt };
          if (old) dirty.add(yearOf(old));
          entries.set(metadata.id, entry); dirty.add(yearOf(entry));
        }
        if (page.end > resumedThrough) newPages++;
        discovery = { complete: !capped && page.end >= page.total, lastPosition: Math.max(discovery.lastPosition, page.end),
          total: page.total, verifiedAt: page.retrievedAt };
        discoveryDirty = true;
        report({ source: SOURCE, phase: 'list', pages, discovered: entries.size, total: page.total, position: page.end });
        await save();
        if (discovery.complete || capped) break;
        if (newPages >= maxPages) { interrupted = true; break; }
        if (!resized && page.pageSizeRequest) {
          resized = true; request = page.pageSizeRequest; previousEnd = 0; continue;
        }
        if (page.end <= previousEnd) throw new Error('Region Hannover pagination did not advance');
        previousEnd = page.end;
        if (!page.next) { interrupted = true; break; }
        request = page.next;
      }
      if (!discovery.complete && !canFetch()) interrupted = true;
    } catch (error) {
      interrupted = true;
      if (accessDenial(error)) accessDenied = true;
      if (error.code !== 'REGION_WORK_BUDGET') failures.push('Öffentliche Vorlagenübersicht derzeit nur teilweise abrufbar.');
    }
  }
  let detailRequests = 0, lastReported = 0;
  const queue = [...entries.values()].filter(entry => !(entry.excludedAt && fresh(entry.excludedAt))
    && (!entry.detail || !fresh(entry.detailVerifiedAt) || entry.detailUnavailable))
    .map(entry => ({ entry, traffic: classifyTrafficRelevance(entry.metadata).trafficRelevanceScore }))
    .sort((a, b) => Number(!!a.entry.detail) - Number(!!b.entry.detail)
      || (a.entry.detail && b.entry.detail
        ? Date.parse(a.entry.lastAttemptedAt || a.entry.detailVerifiedAt) - Date.parse(b.entry.lastAttemptedAt || b.entry.detailVerifiedAt)
        : (a.entry.detailAttempts || 0) - (b.entry.detailAttempts || 0))
      || b.traffic - a.traffic || (b.entry.metadata.date || '').localeCompare(a.entry.metadata.date || '')
      || a.entry.metadata.id.localeCompare(b.entry.metadata.id));
  async function detail(entry) {
    const { metadata } = entry;
    try {
      const result = await sourceCache.getOrLoadWithMetadata(metadata.url, REVISION, async () => {
        if (!canFetch() || detailRequests >= maxDetails) throw budgetError();
        requests++; detailRequests++;
        entry.lastAttemptedAt = now.toISOString();
        entry.detailAttempts = Math.min(1000000, (entry.detailAttempts || 0) + 1);
        dirty.add(yearOf(entry));
        const response = await requestHtml(metadata.url, { timeoutMs });
        const html = typeof response === 'string' ? response : response?.html;
        const retrievedAt = typeof response === 'string' ? now.toISOString() : response?.retrievedAt;
        if (!validTimestamp(retrievedAt, now)) throw new Error('Invalid Region Hannover captured retrieval timestamp');
        let parsed;
        try { parsed = parseProposalHtml(html, metadata.url); }
        catch (error) { if (error.code === 'REGION_PROPOSAL_NOT_PUBLIC') error.verifiedAt = retrievedAt; throw error; }
        if (parsed.number !== metadata.number) throw new Error('Region Hannover detail number does not match its public list entry');
        return { ...parsed, detailVerifiedAt: retrievedAt };
      });
      if (!validStoredDetail(result.payload, now) || result.payload.id !== metadata.id) throw new Error('Invalid Region Hannover cached detail');
      const cachedAt = new Date(result.cachedAt).toISOString();
      if (!validTimestamp(cachedAt, now)) throw new Error('Invalid Region Hannover detail cache clock');
      const verifiedAt = validTimestamp(result.payload.detailVerifiedAt, now)
        ? [result.payload.detailVerifiedAt, cachedAt].sort()[0] : cachedAt;
      entry.detail = result.payload;
      entry.detailVerifiedAt = verifiedAt;
      delete entry.detailUnavailable; delete entry.excludedAt; delete entry.exclusionReason;
      dirty.add(yearOf(entry));
    } catch (error) {
      if (error.code === 'REGION_WORK_BUDGET') { interrupted = true; return; }
      if (error.code === 'REGION_PROPOSAL_NOT_PUBLIC' && validTimestamp(error.verifiedAt, now)) {
        entry.excludedAt = error.verifiedAt; entry.exclusionReason = 'not-public';
        dirty.add(yearOf(entry)); return;
      }
      failedDetails++;
      if (entry.detail) entry.detailUnavailable = true;
      if (accessDenial(error)) accessDenied = true;
      dirty.add(yearOf(entry));
    }
  }
  // Missing details precede stale ones. Only cache loaders consume network and
  // detail work, so restored cache hits can still complete after either budget.
  for (let index = 0; index < queue.length && performance.now() < deadline; index += concurrency) {
    await Promise.all(queue.slice(index, index + concurrency).map(({ entry }) => detail(entry)));
    await save();
    if (detailRequests - lastReported >= 25 || index + concurrency >= queue.length) {
      lastReported = detailRequests;
      report({ source: SOURCE, phase: 'details', requested: detailRequests,
        verifiedDetails: [...entries.values()].filter(entry => entry.detail && !entry.excludedAt).length,
        discovered: entries.size, failedDetails });
    }
  }
  if (failedDetails) failures.push(`${failedDetails} Detailabrufe nicht verfügbar; zuletzt verifizierte Inhalte behalten ihren ursprünglichen Stand.`);
  if (accessDenied) failures.push('Die öffentliche Quelle hat weitere Abrufe abgelehnt; gespeicherte Belege bleiben erhalten.');
  await save();
  const visible = [...entries.values()].filter(entry => !entry.excludedAt);
  const records = visible.map(mergedRecord);
  const clocks = visible.flatMap(entry => [entry.metadataVerifiedAt, ...(entry.detailVerifiedAt ? [entry.detailVerifiedAt] : [])]);
  const generatedAt = clocks.sort()[0] || null;
  const dates = records.map(record => record.date).filter(Boolean).sort();
  const verifiedDetails = visible.filter(entry => entry.detail).length;
  const pendingDetails = visible.length - verifiedDetails;
  const staleDetails = visible.filter(entry => entry.detail && !fresh(entry.detailVerifiedAt)).length;
  const pending = !discovery.complete || pendingDetails > 0 || staleDetails > 0 || failedDetails > 0;
  const warnings = [...failures,
    ...(!discovery.complete ? ['Öffentliche Vorlagenübersicht noch nicht vollständig erfasst; Sammlung ist fortsetzbar.'] : []),
    ...(pendingDetails ? [`${pendingDetails} öffentliche Vorlagen sind bislang nur mit ihren Listenmetadaten indexiert.`] : []),
    ...(staleDetails ? [`${staleDetails} verifizierte Detailstände warten auf erneute Prüfung.`] : [])];
  const coverage = { from: dates[0] || null, to: dates.at(-1) || null,
    bodies: [...new Set(['Regionsversammlung und Ausschüsse', ...records.map(record => record.gremium).filter(Boolean)])], complete: false, warnings };
  const sourceStatus = { source: SOURCE, status: accessDenied ? 'blocked' : failures.length && !records.length ? 'failed' : pending || failures.length ? 'partial' : 'available',
    url: LIST_URL, retrievedAt: generatedAt, from: coverage.from, to: coverage.to, recordCount: records.length,
    message: `${records.length} öffentlich gelistete Vorlagen; ${verifiedDetails} Details geprüft. ${discovery.complete ? 'Öffentliche Übersicht vollständig erfasst.' : 'Übersicht noch unvollständig.'}` };
  const exclusions = [...entries.values()].filter(entry => entry.excludedAt).map(entry => ({
    id: entry.metadata.id, url: entry.metadata.url, verifiedAt: entry.excludedAt, reason: 'not-public' }));
  return { records, exclusions, sources: [LIST_URL], generatedAt, coverage, sourceStatus, sourceStatuses: [sourceStatus],
    history: { pending, interrupted, pendingYears: [...new Set(visible.filter(entry => !entry.detail && entry.metadata.date)
      .map(entry => Number(entry.metadata.date.slice(0, 4))))].sort(), requestedFrom: from, requestedTo: null },
    collection: { listComplete: discovery.complete, discovered: entries.size, verifiedDetails, pendingDetails, staleDetails, failedDetails, pages, total: discovery.total || null },
    provenance: { collection: { pages, rawItems: discovery.lastPosition || null, requestedFrom: from, requestedTo: null,
      limits: { maxPages, maxDocuments, workBudget: workBudget === Infinity ? null : workBudget, maxDurationMs } } } };
}

module.exports = { ORIGIN, LIST_URL, SOURCE, REVISION, parseProposalHtml, parseProposalListHtml, collectRegionHannoverCatalogue };
