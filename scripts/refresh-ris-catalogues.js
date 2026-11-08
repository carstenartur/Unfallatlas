#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const zlib = require('node:zlib');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const { readRisSnapshot, writeRisSnapshot, enumerateSnapshotAssets, RIS_FALLBACK_MAX_AGE_MS } = require('../server/political-context/services/risSnapshot');
const { enrichRisLocations } = require('../server/political-context/services/risLocation');
const { createRisSourceCache } = require('../server/political-context/services/risSourceCache');
const { createRisSourceCheckpoint } = require('../server/political-context/services/risSourceCheckpoint');
const { collectionProvenance } = require('../server/political-context/services/risProvenance');

const ROOT = path.resolve(__dirname, '..');
const DIRECTORY = path.join(ROOT, 'data', 'ris');
const PUBLISHED_DIRECTORY = 'https://carstenartur.github.io/Unfallatlas/data/ris/';
const DAY_MS = 24 * 60 * 60 * 1000;
// Allow the weekly workflow to start a few hours earlier than its previous run.
const REFRESH_AFTER_MS = 6.5 * DAY_MS;
const SOURCE_LIMIT_MS = { bonn: 20 * 60_000, hannover: 60 * 60_000 };
const CITIES = Object.keys(SOURCE_LIMIT_MS);
const HANNOVER_DISTRICT = 'Stadtbezirksrat Linden-Limmer';
const HANNOVER_ARCHIVE_BODIES = new Set(['ratsversammlung', HANNOVER_DISTRICT.toLowerCase()]);
const LOCATION_REVISION = 3;
const HISTORY_START_YEAR = 2014;
const SOURCE_RETRY_MS = 6 * 60 * 60_000;
const MANIFEST_BYTES = 256 * 1024;
const ASSET_BYTES = 16 * 1024 * 1024;
// Public manifests must not carry raw errors from source responses or local filesystem paths.
const PUBLIC_REFRESH_FAILURE = 'Die letzte Aktualisierung der amtlichen Ratsdaten ist fehlgeschlagen.';

async function collectOfficial(city, now, { previousCoverage, historyStartYear = HISTORY_START_YEAR, workBudget,
  maxDurationMs, sourceDirectory = path.join(ROOT, '.cache', 'ris-sources'), report = () => {} } = {}) {
  const sourceCache = createRisSourceCache({ directory: sourceDirectory, now: () => now.getTime() });
  const checkpoint = createRisSourceCheckpoint({ directory: sourceDirectory });
  const progress = event => report({ ...event, cache: sourceCache.stats });
  if (city === 'bonn') {
    const { collectBonnCatalogue } = require('../server/political-context/providers/bonnOparlClient');
    const catalogue = await collectBonnCatalogue({
      now, lookbackYears: now.getUTCFullYear() - historyStartYear, maxPages: 300, pageLimit: 100,
      checkpoint, sourceCache, workBudget, maxDurationMs: maxDurationMs ?? 18 * 60_000,
      requestOptions: { timeoutMs: 20_000, maxRedirects: 0, maxBytes: 4 * 1024 * 1024 },
    });
    return withCollectionSettings(catalogue, { maxPages: 300, pageSize: 100, workBudget, maxDurationMs: maxDurationMs ?? 18 * 60_000 },
      { requestedFrom: `${historyStartYear}-01-01`, requestedTo: null });
  }
  const { collectHannoverCatalogue } = require('../server/political-context/providers/hannoverSimCatalogue');
  const requestedFrom = `${historyStartYear}-01-01`;
  const from = previousCoverage?.from && previousCoverage.from < requestedFrom ? previousCoverage.from : requestedFrom;
  const catalogue = await collectHannoverCatalogue({
    now, from, discovery: 'search', strict: true, maxDocuments: 50_000,
    concurrency: 8, maxDurationMs: maxDurationMs ?? 58 * 60_000, timeoutMs: 20_000,
    includeLocationEvidence: true, sourceCache, checkpoint, workBudget, report: progress,
  });
  return withCollectionSettings(catalogue, { maxDocuments: 50_000, workBudget, maxDurationMs: maxDurationMs ?? 58 * 60_000 });
}

function withCollectionSettings(catalogue, limits, scope = {}) {
  return { ...catalogue, provenance: { ...catalogue.provenance, collection: { ...scope, ...catalogue.provenance?.collection, limits } } };
}

async function collectFromSource(city, now, { report = () => {}, ...options } = {}) {
  // A worker bounds the wall clock even if a source keeps a connection alive.
  const worker = new Worker(__filename, { workerData: { city, now: now.toISOString(), options } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Source crawl exceeded ${SOURCE_LIMIT_MS[city] / 60_000} minutes`)), SOURCE_LIMIT_MS[city]);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Source worker exited without a catalogue (${code})`)));
      worker.on('message', ({ catalogue, error, progress }) => {
        if (progress) report(progress);
        else if (error) reject(new Error(error));
        else resolve(catalogue);
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

async function listDirectory(directory) {
  try {
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`RIS path is not a regular directory: ${directory}`);
    return await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function snapshotFiles(directory, manifest) {
  const assets = await enumerateSnapshotAssets(directory, manifest);
  return [...assets.map(asset => asset.path), `${manifest.city}.json`];
}

function assertUnexpiredSnapshot(manifest, now) {
  const expiry = Date.parse(manifest.generatedAt) + RIS_FALLBACK_MAX_AGE_MS;
  if (expiry <= now.getTime()) {
    throw new Error(`${manifest.city}: RIS snapshot expired at ${new Date(expiry).toISOString()}`);
  }
}

async function validateRisDirectory(directory, { requireAll = false, now = new Date() } = {}) {
  const names = await listDirectory(directory);
  const cities = CITIES.filter(city => names.includes(`${city}.json`));
  if (requireAll && cities.length !== CITIES.length) {
    throw new Error(`Missing required RIS snapshot(s): ${CITIES.filter(city => !cities.includes(city)).join(', ')}`);
  }
  const manifests = [];
  for (const city of cities) {
    const { manifest } = await readRisSnapshot(directory, city);
    assertUnexpiredSnapshot(manifest, now);
    manifests.push(manifest);
  }
  const files = new Set((await Promise.all(manifests.map(manifest => snapshotFiles(directory, manifest)))).flat());
  const unexpected = names.find(name => !files.has(name));
  if (unexpected) throw new Error(`Unreferenced file in RIS publication: ${unexpected}`);
  return manifests;
}

async function fetchPublishedFile(fetch, filename, { manifest = false } = {}) {
  const url = new URL(filename, PUBLISHED_DIRECTORY).href;
  const response = await fetch(url, {
    redirect: 'error', credentials: 'omit', cache: manifest ? 'no-cache' : 'force-cache',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (manifest && response.status === 404) return null;
    throw new Error(`Published RIS file ${filename}: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error(`Published RIS file ${filename} has no response body`);
  const maximum = manifest ? MANIFEST_BYTES : ASSET_BYTES;
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maximum) throw new Error(`Published RIS file ${filename} exceeds its size limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function restorePublished(directory, city, fetch) {
  const manifestBytes = await fetchPublishedFile(fetch, `${city}.json`, { manifest: true });
  if (!manifestBytes) return null;
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.city !== city || ![1, 2].includes(manifest.schemaVersion)) throw new Error('Published RIS manifest has the wrong city or version');
  await fs.mkdir(directory, { recursive: true });
  // Enumeration validates the manifest and every content-addressed directory
  // before following its children, including all lazy v2 record/index assets.
  await enumerateSnapshotAssets(directory, manifest, { loadAsset: async ({ path: filename }) => {
    const bytes = await fetchPublishedFile(fetch, filename);
    const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b ? bytes : await gzip(bytes);
    await fs.writeFile(path.join(directory, filename), compressed);
  } });
  await fs.writeFile(path.join(directory, `${city}.json`), manifestBytes);
  return readRisSnapshot(directory, city);
}

async function inspect(directory, load, now) {
  try {
    const snapshot = await load();
    if (!snapshot) return { directory };
    const generated = Date.parse(snapshot.manifest.generatedAt);
    if (generated - now.getTime() > 5 * 60_000) throw new Error('RIS snapshot timestamp is in the future');
    return { directory, manifest: snapshot.manifest, generated };
  } catch (error) {
    return { directory, error };
  }
}

async function installSnapshot(output, { directory, manifest, rewriteManifest }) {
  const manifestName = `${manifest.city}.json`;
  const manifestBytes = rewriteManifest ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) : null;
  if (manifestBytes?.length > MANIFEST_BYTES) throw new Error('RIS manifest exceeds its size limit');
  await fs.mkdir(output, { recursive: true });
  // Replace the manifest last, after both verified assets are present.
  for (const filename of await snapshotFiles(directory, manifest)) {
    if (directory === output && filename !== manifestName) continue;
    const temporary = path.join(output, `.${filename}.${randomUUID()}.tmp`);
    try {
      if (manifestBytes && filename === manifestName) await fs.writeFile(temporary, manifestBytes, { flag: 'wx' });
      else await fs.copyFile(path.join(directory, filename), temporary);
      await fs.rename(temporary, path.join(output, filename));
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

async function pruneCity(directory, city, manifest) {
  const keep = new Set(manifest ? await snapshotFiles(directory, manifest) : []);
  // Stop new readers from seeing an expired manifest before removing its assets.
  if (!manifest) await fs.rm(path.join(directory, `${city}.json`), { force: true });
  for (const name of await listDirectory(directory)) {
    if (!keep.has(name) && (name.startsWith(`${city}.`) || name.startsWith(`.${city}.`))) {
      await fs.rm(path.join(directory, name), { force: true });
    }
  }
}

function latestSnapshot(local, published) {
  if (!local.manifest || published.generated > local.generated) return published;
  // A failed refresh updates the manifest without changing its original generation time.
  if (published.generated === local.generated && published.manifest.refreshFailure &&
      (!local.manifest.refreshFailure || published.manifest.refreshFailure.attemptedAt > local.manifest.refreshFailure.attemptedAt)) {
    return published;
  }
  return local;
}

const recordCount = manifest => manifest?.records?.count ?? manifest?.recordCount;
const mapCount = manifest => manifest?.map?.count ?? manifest?.geometryCount;

function rejectCoverageDowngrade(next, previous) {
  const coverage = next.coverage;
  const old = previous.coverage;
  if ((old.complete && !coverage.complete) || (old.from && coverage.from > old.from) ||
      (old.to && coverage.to < old.to)) throw new Error('Official coverage is narrower than the previous snapshot');
  if (old.scope === 'citywide' && coverage.scope !== 'citywide') {
    throw new Error('Citywide discovery was reduced to selected councils');
  }
  const scopeBodies = ({ city, coverage: { bodies } }) => bodies.map(body => {
    const label = body.toLowerCase();
    return city === 'bonn' && /^(?:(?:bundes)?stadt )?bonn$/.test(label) ? 'bonn' : label;
  }).filter(body => next.city !== 'hannover' || HANNOVER_ARCHIVE_BODIES.has(body));
  const nextBodies = new Set(scopeBodies(next));
  if (coverage.scope !== 'citywide' && scopeBodies(previous).some(body => !nextBodies.has(body))) {
    throw new Error('An official council is missing from the new snapshot');
  }
  // Hannover's daily RSS can legitimately lose a recent council name as its window rolls.
  // The archive and feed URLs capture the source scope independently of that window.
  if (next.city === 'hannover' && coverage.scope !== 'citywide' && previous.sources.some(source => !next.sources.includes(source))) {
    throw new Error('An official archive or feed is missing from the new snapshot');
  }
  if (recordCount(next) < recordCount(previous) * 0.9) {
    throw new Error(`Official record count fell from ${recordCount(previous)} to ${recordCount(next)}`);
  }
}

async function loadGazetteer(city) {
  const folder = path.join(ROOT, 'config', 'ris-locations');
  let curated;
  try {
    curated = JSON.parse(await fs.readFile(path.join(folder, `${city}.json`), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (city !== 'hannover') return curated;
  const compressed = await fs.readFile(path.join(folder, 'hannover-atkis.json.gz'));
  const atkis = JSON.parse((await gunzip(compressed, { maxOutputLength: ASSET_BYTES })).toString('utf8'));
  if (atkis.city !== city || !atkis.attribution || !Array.isArray(atkis.entries) || !atkis.entries.length) {
    throw new Error('Invalid Hannover ATKIS gazetteer');
  }
  const key = entry => entry.name.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss');
  const names = new Set(atkis.entries.map(key));
  const additional = (curated?.entries || []).filter(entry => !names.has(key(entry)))
    .map(entry => ({ ...entry, attribution: entry.attribution ?? curated.attribution }));
  return { ...atkis, entries: [...atkis.entries, ...additional] };
}

function snapshotInputs({ records, features }) {
  const byRecord = new Map();
  for (const feature of features.features) {
    const list = byRecord.get(feature.properties.recordId) || [];
    list.push(feature); byRecord.set(feature.properties.recordId, list);
  }
  return records.map(record => {
    const own = byRecord.get(record.id) || [];
    const official = own.find(feature => feature.properties.accuracy === 'official');
    const document = [...new Set((record.locations || []).filter(location => location.evidence.source === 'document').map(location => location.evidence.text))];
    return { ...record,
      ...(document.length ? { locationEvidence: document, locationEvidenceTruncated: true } : {}),
      locations: (record.locations || []).map((location, index) => {
        const feature = own.find(item => item.properties.locationIndex === index);
        // Published records omit attribution and extent; the verified feature
        // label retains both without having to reverse-parse display text.
        return feature ? { ...location, geometry: feature.geometry, mapLabel: feature.properties.label } : location;
      }),
      ...(official ? { geometry: official.geometry, locationSource: 'official', locationLabel: official.properties.label } : {}),
    };
  });
}

async function prepareCandidate(directory, city, now, collect, previous, report, sourceOptions = {}) {
  const catalogue = await collect(city, now, { ...sourceOptions, previousCoverage: previous?.manifest.coverage, report });
  let coverage = catalogue?.coverage;
  if (!catalogue?.records?.length || !coverage?.from || !coverage.to || !coverage.bodies?.length ||
      (city === 'bonn' && !coverage.complete)) {
    throw new Error(coverage?.warnings?.join(' ') || 'The official source did not return a usable catalogue');
  }
  let inputs = catalogue.records;
  const retainedDetails = new Map();
  // Checkpoint evidence can outlive a published snapshot. Its original detail
  // clock must constrain publication even when no previous manifest exists.
  const retainedClocks = inputs.filter(record => record.locationEvidenceUnavailable && record.detailVerifiedAt)
    .map(record => record.detailVerifiedAt);
  if (previous?.manifest && catalogue.history) {
    const old = await readRisSnapshot(previous.directory, city);
    const priorRecords = new Map(snapshotInputs(old).map(record => [record.id, record]));
    for (const next of inputs) {
      const prior = priorRecords.get(next.id);
      const unavailable = next.locationEvidenceUnavailable === true;
      const verifiedDetail = prior && (prior.geometry || prior.locations?.length || prior.relatedTo || prior.locationAssessment?.sources.includes('document'));
      if (unavailable && verifiedDetail) {
        // Year-list fields can be newer than the last successful detail. Keep
        // independently verified detail evidence and relationships verbatim.
        const merged = { ...prior, locationEvidenceUnavailable: true };
        for (const field of ['title', 'number', 'date', 'type', 'url', 'source']) {
          if (next[field] !== undefined) merged[field] = next[field];
        }
        if (next.gremium) merged.gremium = next.gremium;
        if (prior.locationAssessment) merged.locationAssessment = { ...prior.locationAssessment,
          status: ['mapped', 'partial'].includes(prior.locationAssessment.status) ? 'partial' : prior.locationAssessment.status,
          reasons: [...new Set([...prior.locationAssessment.reasons, 'document_text_unavailable'])] };
        retainedDetails.set(next.id, merged);
        priorRecords.set(next.id, merged);
      } else priorRecords.set(next.id, next);
    }
    inputs = [...priorRecords.values()];
    coverage = { ...coverage, from: [coverage.from, old.manifest.coverage.from].filter(Boolean).sort()[0],
      to: [coverage.to, old.manifest.coverage.to].filter(Boolean).sort().at(-1),
      bodies: [...new Set([...old.manifest.coverage.bodies, ...coverage.bodies])], complete: false,
      warnings: [...new Set([...coverage.warnings, ...(catalogue.history.pending ? ['Historische Quellenarbeit ist fortsetzbar; Jahrgänge bleiben offen.'] : []),
        ...(retainedDetails.size ? [`${retainedDetails.size} Detailabrufe sind nicht aktuell verfügbar; der zuletzt verifizierte Detailstand vom ${old.manifest.generatedAt} bleibt erhalten.`] : [])])] };
  }
  const gazetteer = await loadGazetteer(city);
  const records = enrichRisLocations(inputs.filter(record => !retainedDetails.has(record.id)), { city, gazetteer, maxLocationsPerRecord: Infinity });
  for (const record of retainedDetails.values()) records.push(record);
  if (previous?.manifest && (catalogue.history?.interrupted || retainedDetails.size)) retainedClocks.push(previous.manifest.generatedAt);
  const retainedAt = retainedClocks.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (retainedAt) coverage = { ...coverage, warnings: [...new Set([...coverage.warnings,
    `Nicht aktuell verfügbare Details behalten ihren zuletzt verifizierten Stand vom ${retainedAt}.`])] };
  const sourceClock = [catalogue.generatedAt, retainedAt, ...inputs.map(record => record.detailVerifiedAt)].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || now.toISOString();
  const retainedSource = { generatedAt: sourceClock,
    ...(retainedAt && previous?.manifest.refreshFailure ? { refreshFailure: { ...previous.manifest.refreshFailure,
      expiresAt: new Date(Date.parse(sourceClock) + RIS_FALLBACK_MAX_AGE_MS).toISOString() } } : {}) };
  const provenance = collectionProvenance({ catalogue, city, records, sourceRecords: inputs, sourceVerifiedAt: sourceClock, now, sourceOptions });
  await writeRisSnapshot(directory, city, { ...catalogue, ...retainedSource, provenance, coverage, records, locationRevision: LOCATION_REVISION }, { now, schemaVersion: 2 });
  const { manifest } = await readRisSnapshot(directory, city);
  if (manifest.locationAssessment?.attempted !== recordCount(manifest)) throw new Error('Not every indexed record received a location assessment');
  assertUnexpiredSnapshot(manifest, now);
  if (previous?.manifest) rejectCoverageDowngrade(manifest, previous.manifest);
  return { directory, manifest };
}

function needsLocationAssessment(manifest) {
  return (manifest?.locationRevision ?? 0) < LOCATION_REVISION ||
    manifest?.locationAssessment?.attempted !== recordCount(manifest);
}

async function prepareLocalAssessment(directory, selected, builtAt) {
  const source = selected.manifest;
  const original = await readRisSnapshot(selected.directory, source.city);
  if (!needsLocationAssessment(source)) {
    const manifest = await writeRisSnapshot(directory, source.city, { ...source, records: original.records, features: original.features },
      { now: builtAt, schemaVersion: 2 });
    return { directory, manifest };
  }
  const { features } = original;
  const records = snapshotInputs(original);
  const official = new Map(features.features.filter(feature => feature.properties.accuracy === 'official')
    .map(feature => [feature.properties.recordId, feature]));
  const inputs = records.map(record => {
    const document = [...new Set((record.locations || []).filter(location => location.evidence.source === 'document')
      .map(location => location.evidence.text))];
    const feature = official.get(record.id);
    return {
      ...record, locationEvidence: document,
      // A published snapshot stores selected quotations, never the full text.
      locationEvidenceTruncated: document.length > 0 || record.locationAssessment?.truncated === true,
      locationEvidenceUnavailable: !document.length || record.locationAssessment?.reasons.includes('document_text_unavailable') === true,
      ...(feature ? { geometry: feature.geometry, locationSource: 'official', locationLabel: feature.properties.label } : {}),
    };
  });
  const gazetteer = await loadGazetteer(source.city);
  const next = await writeRisSnapshot(directory, source.city, {
    sources: source.sources, coverage: source.coverage, locationRevision: LOCATION_REVISION,
    records: enrichRisLocations(inputs, { city: source.city, gazetteer, maxLocationsPerRecord: Infinity }),
    generatedAt: source.generatedAt, ...(source.provenance === undefined ? {} : { provenance: source.provenance }), ...(source.refreshFailure ? { refreshFailure: source.refreshFailure } : {}),
  }, { now: builtAt, schemaVersion: 2 });
  // Local analysis does not refresh the official source or its retry/expiry
  // clock. The writer deliberately omits refreshFailure, so restore and verify it.
  const preserved = { ...next, generatedAt: source.generatedAt,
    ...(source.refreshFailure ? { refreshFailure: source.refreshFailure } : {}) };
  await fs.writeFile(path.join(directory, `${source.city}.json`), `${JSON.stringify(preserved, null, 2)}\n`);
  const { manifest } = await readRisSnapshot(directory, source.city);
  if (needsLocationAssessment(manifest)) throw new Error('Not every retained record received a location assessment');
  return { directory, manifest };
}

async function refreshCity({ directory, city, startedAt, clock, fetchPublished, collect, restoreOnly, report, sourceOptions }) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `ris-refresh-${city}-`));
  try {
    const deployed = path.join(scratch, 'published');
    const [local, published] = await Promise.all([
      restoreOnly ? {} : inspect(directory, async () => {
        try { return await readRisSnapshot(directory, city); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }, startedAt),
      inspect(deployed, () => restorePublished(deployed, city, fetchPublished), startedAt),
    ]);
    if (restoreOnly && !published.manifest) {
      throw new Error(`${city}: ${published.error ? `Invalid or unavailable deployed snapshot: ${published.error.message}` : 'No deployed snapshot found'}`);
    }
    const previous = latestSnapshot(local, published);
    let selected = previous;
    let status = restoreOnly ? 'restored' : 'current';
    let reason;
    const lastFailure = previous.manifest?.refreshFailure?.attemptedAt;
    const upgradeLocations = needsLocationAssessment(previous.manifest);
    const upgradeHistory = city === 'hannover' && (previous.manifest?.coverage.scope !== 'citywide' ||
      previous.manifest?.coverage.from > `${sourceOptions.historyStartYear}-01-01` ||
      previous.manifest?.coverage.warnings.some(warning => /Quellenarbeit ist fortsetzbar/.test(warning)));
    const fallbackExpired = previous.manifest && startedAt.getTime() >= previous.generated + RIS_FALLBACK_MAX_AGE_MS;
    const canRetrySource = !lastFailure || fallbackExpired || startedAt.getTime() - Date.parse(lastFailure) >= SOURCE_RETRY_MS;
    const refreshDue = !previous.manifest || upgradeLocations || upgradeHistory || startedAt.getTime() - previous.generated >= REFRESH_AFTER_MS;
    if (!restoreOnly && refreshDue && canRetrySource) {
      try {
        selected = await prepareCandidate(path.join(scratch, 'candidate'), city, startedAt, collect, previous.manifest ? previous : null,
          progress => report({ city, status: 'collecting', ...progress }), sourceOptions);
        status = 'published';
      } catch (error) {
        reason = error?.message || 'Official RIS refresh failed';
        const expiry = previous.generated + RIS_FALLBACK_MAX_AGE_MS;
        if (previous.manifest && clock().getTime() < expiry) {
          const refreshFailure = {
            attemptedAt: startedAt.toISOString(), reason: PUBLIC_REFRESH_FAILURE, expiresAt: new Date(expiry).toISOString(),
          };
          selected = { ...previous, manifest: { ...previous.manifest, refreshFailure }, rewriteManifest: true };
          status = 'retained';
        } else {
          selected = {};
          status = 'unavailable';
          if (previous.manifest) reason += `; the last verified RIS snapshot expired at ${new Date(expiry).toISOString()}`;
          // A double failure must not remove a city that may already be deployed.
          if (published.error) {
            throw new Error(`${city}: ${reason}; could not verify the deployed fallback: ${published.error.message}`);
          }
        }
      }
    }

    if (!restoreOnly && selected.manifest && (needsLocationAssessment(selected.manifest) || selected.manifest.schemaVersion !== 2)) {
      assertUnexpiredSnapshot(selected.manifest, clock());
      try {
        selected = await prepareLocalAssessment(path.join(scratch, 'local-assessment'), selected, startedAt);
      } catch (error) {
        reason = [reason, `Local location reassessment failed: ${error?.message || 'Unknown error'}`].filter(Boolean).join('; ');
      }
    }

    const { manifest } = selected;
    if (manifest) {
      assertUnexpiredSnapshot(manifest, clock());
      if (selected.rewriteManifest || selected.directory !== directory) await installSnapshot(directory, selected);
    }
    await pruneCity(directory, city, manifest);
    return {
      city, status, ...(reason ? { reason } : {}),
      ...(manifest ? { generatedAt: manifest.generatedAt, records: recordCount(manifest), mapped: mapCount(manifest),
        locationAssessment: manifest.locationAssessment } : {}),
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function refreshRisCatalogues({ directory = DIRECTORY, cities = CITIES, now,
  fetchPublished = globalThis.fetch, collect = collectFromSource, restoreOnly = false, report = () => {},
  historyStartYear = HISTORY_START_YEAR, workBudget, maxDurationMs, sourceDirectory } = {}) {
  if (!Array.isArray(cities) || !cities.length || cities.some(city => !Object.hasOwn(SOURCE_LIMIT_MS, city))) {
    throw new Error('Supported RIS cities: bonn, hannover');
  }
  if (!Number.isInteger(historyStartYear) || historyStartYear < 1900 || historyStartYear > 9999) throw new TypeError('Invalid RIS historical start year');
  if (workBudget !== undefined && (!Number.isSafeInteger(workBudget) || workBudget < 0)) throw new TypeError('Invalid RIS work budget');
  const sourceOptions = { historyStartYear, workBudget, maxDurationMs, sourceDirectory };
  const clock = now === undefined ? () => new Date() : () => now;
  const startedAt = clock();
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) throw new Error('Invalid RIS refresh date');
  await listDirectory(directory);
  const outcomes = await Promise.allSettled([...new Set(cities)].map(async city => {
    const outcome = await refreshCity({ directory, city, startedAt, clock, fetchPublished, collect, restoreOnly, report, sourceOptions });
    report(outcome);
    return outcome;
  }));
  const errors = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  return outcomes.map(item => item.value);
}

async function main(args) {
  const usage = 'Usage: node scripts/refresh-ris-catalogues.js [--city bonn|hannover] [--restore-only] [--history-start-year 2014] [--work-budget N] [--max-duration-ms N]\n' +
    '       node scripts/refresh-ris-catalogues.js --validate <directory> [--require-all]';
  if (args[0] === '--validate') {
    if (!args[1] || args.length > 3 || (args[2] && args[2] !== '--require-all')) throw new Error(usage);
    const manifests = await validateRisDirectory(path.resolve(args[1]), { requireAll: args[2] === '--require-all' });
    console.log(`[ris] Validated ${manifests.length} snapshot(s) for Pages.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--restore-only' && !options.restoreOnly) options.restoreOnly = true;
    else if (args[i] === '--city' && !options.cities && args[i + 1]) options.cities = [args[++i]];
    else if (['--history-start-year', '--work-budget', '--max-duration-ms'].includes(args[i]) && /^\d+$/.test(args[i + 1] || '')) {
      const key = { '--history-start-year': 'historyStartYear', '--work-budget': 'workBudget', '--max-duration-ms': 'maxDurationMs' }[args[i]];
      if (options[key] !== undefined) throw new Error(usage);
      options[key] = Number(args[++i]);
    } else throw new Error(usage);
  }
  await refreshRisCatalogues({
    ...options,
    report({ city, status, generatedAt, records, mapped, reason, locationAssessment, ...progress }) {
      if (status === 'collecting') {
        console.log(`[ris] ${city}: ${JSON.stringify(progress)}`);
        return;
      }
      const assessment = locationAssessment ? `, ${locationAssessment.attempted} assessed, ` +
        `${locationAssessment.mapped + locationAssessment.partial} located records` : '';
      const detail = generatedAt ? ` (${generatedAt}; ${records} records, ${mapped} map features${assessment})` : '';
      console.log(`[ris] ${city}: ${status}${detail}${reason ? ` — ${reason}` : ''}`);
    },
  });
}

if (!isMainThread && workerData?.city) {
  collectOfficial(workerData.city, new Date(workerData.now), {
    ...workerData.options, report: progress => parentPort.postMessage({ progress }),
  }).then(
    catalogue => parentPort.postMessage({ catalogue }),
    error => parentPort.postMessage({ error: error.message }),
  );
} else if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[ris] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { refreshRisCatalogues, validateRisDirectory };
