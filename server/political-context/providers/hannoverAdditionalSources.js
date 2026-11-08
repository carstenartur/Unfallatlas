'use strict';

const https = require('node:https');
const path = require('node:path');
const { createRisSourceCache } = require('../services/risSourceCache');
const { createRisSourceCheckpoint } = require('../services/risSourceCheckpoint');
const { LANDTAG, REGION_INDEX, officialUrl, parseLandtagCatalogue, parseLandtagFeed,
  parseRegionIndex, parseRegionNotice, hasLocalTrafficEvidence } = require('./hannoverAdditionalFormats');

const REVISION = 'hannover-additional-v2';
const DAY = 86400000;
const MAX_RECORDS = 50000;
const CACHE_DIRECTORY = process.env.RIS_ADDITIONAL_SOURCE_DIRECTORY || path.resolve(__dirname, '../../../.cache/ris-additional-sources');
const FEEDS = [
  { source: 'landtag-rss-drucksachen', url: `${LANDTAG}/rss/drucksachen.xml` },
  { source: 'landtag-rss-steno', url: `${LANDTAG}/rss/stenoberichte.xml` },
];
const BLOCKED = Object.freeze({ source: 'region-hannover-ris', status: 'blocked', url: 'https://ris.hannit.de/public/',
  retrievedAt: null, from: null, to: null, recordCount: 0,
  message: 'Automatisierter Zugriff geschützt; amtliches RIS nur über den manuellen Link. Kein bestätigter öffentlicher Export.' });

function validateBound(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`Invalid ${name} bound`);
  return value;
}
function buildCatalogueUrl(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(k => !['year','month','period','number','importer','committee'].includes(k))) {
    throw new TypeError('Invalid catalogue filters');
  }
  const { year, month, period, number, committee, importer = 'printed_matter' } = filters;
  if (!['printed_matter', 'steno'].includes(importer) || (year !== undefined && (!Number.isInteger(year) || year < 1982 || year > 9999)) ||
      (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) ||
      (period !== undefined && (!Number.isInteger(period) || period < 10 || period > 99)) ||
      (number !== undefined && (typeof number !== 'string' || !/^\d{1,2}\/\d{1,6}$/.test(number))) ||
      (committee !== undefined && (typeof committee !== 'string' || !/^[A-Za-z0-9.]{1,30}$/.test(committee)))) throw new TypeError('Invalid catalogue filter');
  const params = new URLSearchParams({ 'tx_nltdocuments_documents[action]': 'filter', 'nltdocuments-importer': importer });
  for (const [name, value] of Object.entries({ year, month, period, number, committee })) if (value !== undefined) params.set(`nltdocuments-${name}`, String(value));
  return `${LANDTAG}/dokumentensuche/?${params}`;
}
function requestOfficial(url) {
  officialUrl(url);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 10000, headers: { 'Accept': 'text/html, application/xml', 'User-Agent': 'Unfallwerkbank-public-documents/1.0' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Official source HTTP ${response.statusCode}`)); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) response.destroy(new Error('Official source response exceeds limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Official source timeout')));
    request.on('error', reject);
  });
}
function clock(options) {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid source clock');
  return now;
}
function dependencies(options, now) {
  return { request: options.request || requestOfficial,
    sourceCache: options.sourceCache || createRisSourceCache({ directory: CACHE_DIRECTORY, now: () => now.getTime(), maxAgeMs: 60 * 60_000 }),
    checkpoint: options.checkpoint || createRisSourceCheckpoint({ directory: CACHE_DIRECTORY }) };
}
function oldest(values) { return values.filter(Boolean).sort()[0] || null; }
function bounds(records) {
  const dates = records.flatMap(r => [r.sourceContext.publicationDate, r.sourceContext.documentDate, r.sourceContext.meetingDate]).filter(Boolean).sort();
  return { from: dates[0] || null, to: dates.at(-1) || null };
}
function status(source, url, records, retrievedAt, state, message, range = bounds(records)) {
  return { source, status: state, url, retrievedAt, ...range, recordCount: records.length, message };
}
async function cached(cache, key, parse, request, now) {
  officialUrl(key);
  const result = await cache.getOrLoadWithMetadata(key, REVISION, async () => parse(await request(key), key));
  return { value: result.payload, retrievedAt: new Date(result.cachedAt).toISOString() };
}
function validateCheckpoint(work) {
  if (!work || !Array.isArray(work.records) || work.records.length > MAX_RECORDS ||
      !Array.isArray(work.seen) || work.seen.length > MAX_RECORDS || !Array.isArray(work.visited) || work.visited.length > 10000 ||
      !Number.isFinite(Date.parse(work.retrievedAt))) return null;
  // Disk state is resumable work, not a licence to issue arbitrary requests.
  if (work.nextUrl) {
    officialUrl(work.nextUrl, LANDTAG, 'www.landtag-niedersachsen.de');
    if (new URL(work.nextUrl).pathname !== '/dokumentensuche/') throw new Error('Invalid checkpoint continuation');
  }
  if (work.records.some(r => !r || !r.sourceContext || !hasLocalTrafficEvidence(r) || !officialUrl(r.url))) return null;
  return work;
}

async function collectLandtagCatalogue(options = {}) {
  const now = clock(options), { request, sourceCache, checkpoint } = dependencies(options, now);
  const maxPages = validateBound(options.workBudget === 0 ? 0 : options.maxPages ?? 2, 100, 'catalogue page');
  const filters = options.filters || { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const initial = buildCatalogueUrl(filters), scope = `catalogue:${new URL(initial).search}`, year = filters.year || now.getUTCFullYear();
  const source = 'landtag-catalogue';
  let work = null;
  let pagesFetched = 0;
  try {
    work = validateCheckpoint(await checkpoint.read(source, scope, year, REVISION));
    // Re-enumerate exhausted partitions after seven days; interrupted work
    // must survive weekly builds so bounded historical backfill can advance.
    if (work && !work.nextUrl && now.getTime() - Date.parse(work.retrievedAt) >= 7 * DAY) work = null;
    if (!work) work = { records: [], nextUrl: initial, seen: [], visited: [], total: null, retrievedAt: null, complete: false };
    const records = new Map(work.records.map(r => [r.id, r]));
    const seen = new Set(work.seen), visited = new Set(work.visited);
    while (work.nextUrl && pagesFetched < maxPages) {
      const url = work.nextUrl;
      if (visited.has(url)) throw new Error('Cyclic catalogue pagination');
      const page = await cached(sourceCache, url, parseLandtagCatalogue, request, now);
      const { records: rows, total, nextUrl } = page.value;
      if (!Array.isArray(rows) || !Number.isSafeInteger(total)) throw new Error('Invalid cached catalogue page');
      const rangeChanged = work.total !== null && work.total !== total;
      for (const row of rows) {
        seen.add(row.url);
        if (hasLocalTrafficEvidence(row)) records.set(row.id, row);
      }
      if (seen.size > MAX_RECORDS) throw new Error('Catalogue partition exceeds record limit');
      visited.add(url);
      const retrievedAt = oldest([work.retrievedAt, page.retrievedAt]);
      work = { records: [...records.values()], seen: [...seen], visited: [...visited], nextUrl, total, retrievedAt,
        complete: !nextUrl && !rangeChanged && seen.size === total,
        unstable: work.unstable || rangeChanged };
      work.complete = work.complete && !work.unstable;
      pagesFetched++;
      await checkpoint.write(source, scope, year, REVISION, work);
    }
    return { records: work.records, pagesFetched, continuation: work.nextUrl, partitionComplete: work.complete,
      sourceStatus: status(source, initial, work.records, work.visited.length ? work.retrievedAt : null, 'partial',
        work.complete ? 'Angegebene Dokumentpartition erfasst; weitere Jahrgänge und Dokumentarten sind nicht vollständig erschlossen.' : 'Begrenzte Dokumentpartition; Fortsetzung und weitere Jahrgänge bleiben offen.') };
  } catch (_) {
    // Include successful pages from this attempt as well as earlier work.
    const records = work?.records || [];
    return { records, pagesFetched, continuation: work?.nextUrl || initial, partitionComplete: false,
      sourceStatus: status(source, initial, records, work?.visited?.length ? work.retrievedAt : null, 'failed',
        'Dokumentpartition nicht vollständig erreichbar; zuletzt verifizierte Datensätze und Fortsetzung bleiben erhalten.') };
  }
}

async function collectRolling(feed, options) {
  const now = clock(options), { request, sourceCache, checkpoint } = dependencies(options, now), year = now.getUTCFullYear();
  let prior = await checkpoint.read(feed.source, 'rolling', year, REVISION);
  if (!prior) prior = await checkpoint.read(feed.source, 'rolling', year - 1, REVISION);
  if (options.workBudget === 0) {
    const records = Array.isArray(prior?.records) ? prior.records : [];
    return { records, sourceStatus: status(feed.source, feed.url, records, prior?.sourceStatus?.retrievedAt || null, 'partial',
      'Arbeitsbudget ausgeschöpft; kein neuer RSS-Abruf.', prior?.sourceStatus ? { from: prior.sourceStatus.from, to: prior.sourceStatus.to } : undefined) };
  }
  try {
    const loaded = await cached(sourceCache, feed.url, parseLandtagFeed, request, now);
    const all = loaded.value;
    const records = all.filter(hasLocalTrafficEvidence);
    const sourceStatus = status(feed.source, feed.url, records, loaded.retrievedAt, 'partial',
      'Rollierender RSS-Ausschnitt; keine Archivvollständigkeit und keine belegte Feed-Paginierung.', bounds(all));
    await checkpoint.write(feed.source, 'rolling', year, REVISION, { records, sourceStatus });
    return { records, sourceStatus };
  } catch (_) {
    const records = Array.isArray(prior?.records) ? prior.records : [];
    return { records, sourceStatus: status(feed.source, feed.url, records, prior?.sourceStatus?.retrievedAt || null, 'failed',
      'RSS nicht erreichbar; letzter verifizierter Ausschnitt bleibt erhalten.', prior?.sourceStatus ? { from: prior.sourceStatus.from, to: prior.sourceStatus.to } : undefined) };
  }
}

async function collectRegionNotices(options = {}) {
  const now = clock(options), { request, sourceCache, checkpoint } = dependencies(options, now), year = now.getUTCFullYear();
  const maxNotices = validateBound(options.maxNotices ?? 4, 20, 'Region notice');
  const source = 'region-hannover-bekanntmachungen';
  const prior = await checkpoint.read(source, 'current-notices', year, REVISION);
  if (options.workBudget === 0 || maxNotices === 0) {
    const records = Array.isArray(prior?.records) ? prior.records : [];
    return { records, sourceStatus: status(source, REGION_INDEX, records, prior?.sourceStatus?.retrievedAt || null, 'partial',
      'Arbeitsbudget ausgeschöpft; keine neuen Bekanntmachungen abgerufen.') };
  }
  let records = [], clocks = [], failed = false;
  try {
    const index = await cached(sourceCache, REGION_INDEX, parseRegionIndex, request, now);
    clocks.push(index.retrievedAt);
    for (const url of index.value.slice(0, maxNotices)) {
      try {
        const notice = await cached(sourceCache, url, parseRegionNotice, request, now);
        clocks.push(notice.retrievedAt);
        records.push(...notice.value.filter(hasLocalTrafficEvidence));
      } catch (_) { failed = true; }
    }
    if (failed) throw new Error('A Region notice is unavailable');
    const sourceStatus = status(source, REGION_INDEX, records, oldest(clocks), 'partial',
      'Öffentliche aktuelle Tagesordnungen; kein Vorlagen-/Beschlussarchiv. Historische Abdeckung unbekannt.');
    await checkpoint.write(source, 'current-notices', year, REVISION, { records, sourceStatus });
    return { records, sourceStatus };
  } catch (_) {
    const merged = new Map((prior?.records || []).map(r => [r.id, r]));
    for (const r of records) merged.set(r.id, r);
    records = [...merged.values()];
    return { records, sourceStatus: status(source, REGION_INDEX, records, oldest([prior?.sourceStatus?.retrievedAt, ...clocks]), 'failed',
      'Bekanntmachungen teilweise nicht erreichbar; verifizierte Tagesordnungen bleiben erhalten.') };
  }
}

async function collectHannoverAdditionalSources(options = {}) {
  const now = clock(options), deps = dependencies(options, now), params = { ...options, ...deps, now };
  const tasks = [...FEEDS.map(feed => () => collectRolling(feed, params)), () => collectRegionNotices(params),
    ...(options.includeCatalogue === false ? [] : [() => collectLandtagCatalogue(params)])];
  const outcomes = await Promise.allSettled(tasks.map(run => run()));
  const collected = outcomes.map((outcome, i) => outcome.status === 'fulfilled' ? outcome.value : {
    records: [], sourceStatus: status(FEEDS[i]?.source || (i === 2 ? 'region-hannover-bekanntmachungen' : 'landtag-catalogue'),
      FEEDS[i]?.url || (i === 2 ? REGION_INDEX : buildCatalogueUrl(params.filters)), [], null, 'failed', 'Quelle derzeit nicht verfügbar.') });
  const records = [...new Map(collected.flatMap(outcome => outcome.records).map(r => [r.id, r])).values()];
  const sourceStatuses = [...collected.map(c => c.sourceStatus), { ...BLOCKED }];
  const range = bounds(records);
  return { records, sources: [...new Set(sourceStatuses.map(s => s.url))], sourceStatuses,
    generatedAt: oldest(sourceStatuses.map(s => s.retrievedAt)) || now.toISOString(),
    coverage: { ...range, bodies: ['Regionsversammlung und Ausschüsse', 'Niedersächsischer Landtag'], complete: false,
      warnings: sourceStatuses.map(s => `${s.source}: ${s.message}`) } };
}

module.exports = { collectHannoverAdditionalSources, collectLandtagCatalogue, collectRegionNotices,
  buildCatalogueUrl, requestOfficial, BLOCKED };
