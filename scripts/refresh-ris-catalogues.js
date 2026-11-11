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
const { countCatalogueLevels } = require('../server/political-context/services/risPartitionedSnapshot');
const { enrichRisLocations, isPetitionerContactAddress } = require('../server/political-context/services/risLocation');
const { validLocationGeometry } = require('../js/ua.ris-catalogue').snapshotFormat;
const { createRisSourceCache } = require('../server/political-context/services/risSourceCache');
const { createRisSourceCheckpoint } = require('../server/political-context/services/risSourceCheckpoint');
const { collectionProvenance } = require('../server/political-context/services/risProvenance');
const { validateCheckpointRetry } = require('./ris-checkpoint-retry-options');
const { HANNOVER_HISTORY_START_YEAR, collectCombinedHannoverCatalogue, includesRegionSource, historicalCityStart } = require('../server/political-context/providers/hannoverCatalogue');

const ROOT = path.resolve(__dirname, '..');
const DIRECTORY = path.join(ROOT, 'data', 'ris');
const PUBLISHED_DIRECTORY = 'https://carstenartur.github.io/Unfallatlas/data/ris/';
const DAY_MS = 24 * 60 * 60 * 1000;
// Allow the weekly workflow to start a few hours earlier than its previous run.
const REFRESH_AFTER_MS = 6.5 * DAY_MS;
const SOURCE_LIMIT_MS = { bonn: 20 * 60_000, hannover: 60 * 60_000 };
const REFRESH_FINISH_MS = 5 * 60_000;
const SOURCE_FINISH_MS = 2 * 60_000;
const CITIES = Object.keys(SOURCE_LIMIT_MS);
const HANNOVER_DISTRICT = 'Stadtbezirksrat Linden-Limmer';
const HANNOVER_ARCHIVE_BODIES = new Set(['ratsversammlung', HANNOVER_DISTRICT.toLowerCase()]);
const LOCATION_REVISIONS = { bonn: 5, hannover: 10 };
const historyStartYears = { bonn: 2014, hannover: HANNOVER_HISTORY_START_YEAR };
const SOURCE_RETRY_MS = 6 * 60 * 60_000;
const MANIFEST_BYTES = 256 * 1024;
const ASSET_BYTES = 16 * 1024 * 1024;
// Public manifests must not carry raw errors from source responses or local filesystem paths.
const PUBLIC_REFRESH_FAILURE = 'Die letzte Aktualisierung der amtlichen Ratsdaten ist fehlgeschlagen.';

async function collectOfficial(city, now, { previousCoverage, previousSourceStatuses, historyStartYear = historyStartYears[city], workBudget,
  maxDurationMs, sourceDirectory = path.join(ROOT, '.cache', 'ris-sources'), report = () => {}, onExclusions = () => {}, checkpointOnly = false } = {}) {
  if (checkpointOnly && (city !== 'hannover' || workBudget !== 0)) throw new Error('Hannover checkpoint recovery requires zero source work');
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
  const requestedFrom = `${historyStartYear}-01-01`;
  const from = historicalCityStart(requestedFrom, previousCoverage, previousSourceStatuses);
  if (checkpointOnly) {
    for (let year = Number(from.slice(0, 4)); year <= now.getUTCFullYear(); year++) {
      const state = await checkpoint.read('hannover-sim', 'public-year-search:true', year, 'sim-history-v1');
      if (!Array.isArray(state?.catalogue?.records)) throw new Error(`Missing Hannover historical checkpoint for ${year}`);
    }
  }
  const catalogue = await collectCombinedHannoverCatalogue({
    now, from, maxDurationMs: maxDurationMs ?? 58 * 60_000,
    sourceCache, checkpoint, workBudget, report: progress, onExclusions, checkpointOnly,
  });
  return withCollectionSettings(catalogue, { workBudget, maxDurationMs: maxDurationMs ?? 58 * 60_000 });
}

function withCollectionSettings(catalogue, limits, scope = {}) {
  return { ...catalogue, provenance: { ...catalogue.provenance, collection: { ...scope, ...catalogue.provenance?.collection, limits } } };
}

async function collectFromSource(city, now, { report = () => {}, workerTimeoutMs = SOURCE_LIMIT_MS[city], ...options } = {}) {
  // A worker bounds the wall clock even if a source keeps a connection alive.
  const timeoutMs = Math.min(SOURCE_LIMIT_MS[city], workerTimeoutMs);
  const worker = new Worker(__filename, { workerData: { city, now: now.toISOString(), options } });
  let timer;
  let confirmedExclusions = [];
  const sourceError = error => Object.assign(error, { exclusions: confirmedExclusions });
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(sourceError(new Error(`Source crawl exceeded ${timeoutMs / 60_000} minutes`))), timeoutMs);
      worker.once('error', error => reject(sourceError(error)));
      worker.once('exit', code => reject(sourceError(new Error(`Source worker exited without a catalogue (${code})`))));
      worker.on('message', ({ catalogue, error, progress, exclusions }) => {
        if (exclusions) confirmedExclusions = exclusions;
        if (progress) report(progress);
        else if (error) reject(sourceError(new Error(error)));
        else if (catalogue) resolve(catalogue);
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
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(url, {
      redirect: 'error', credentials: 'omit', cache: manifest ? 'no-cache' : 'force-cache',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) break;
    await response.body?.cancel();
    if (manifest && response.status === 404) return null;
    // Retry only temporary HTTP failures, before accepting or reading any bytes.
    if ([502, 503, 504].includes(response.status) && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
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
    if (Date.parse(snapshot.manifest.withdrawalsRecordedAt) - now.getTime() > 5 * 60_000) throw new Error('RIS withdrawal timestamp is in the future');
    const { manifest } = snapshot;
    // Existing v2 trees already contain every record and mapped ID needed for
    // the footer. Derive the new summary without repacking the catalogue.
    const levelCounts = manifest.schemaVersion === 2 && !manifest.levelCounts
      ? countCatalogueLevels(snapshot.records, new Set(snapshot.features.features.map(feature => feature.properties.recordId)))
      : undefined;
    return { directory, manifest, generated, levelCounts };
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
  if (!local.manifest) return published;
  if (!published.manifest) return local;
  const withdrawnAt = value => value.manifest.withdrawalsRecordedAt ? Date.parse(value.manifest.withdrawalsRecordedAt) : -Infinity;
  // Withdrawal ordering is independent of the oldest retained source clock.
  // A later actual source verification can establish public availability again.
  if (withdrawnAt(published) > withdrawnAt(local) && withdrawnAt(published) >= local.generated) return published;
  if (withdrawnAt(local) > withdrawnAt(published) && withdrawnAt(local) >= published.generated) return local;
  if (published.generated > local.generated) return published;
  const regionalCount = manifest => manifest?.sourceStatuses?.find(source => source.source === 'region-hannover-ris')?.recordCount || 0;
  // A source expansion can retain the same clock, but a zero count can also
  // reflect confirmed withdrawals. Only an unqueried placeholder may lose to
  // the local expansion; a previously verified regional result is authoritative.
  if (published.generated === local.generated && regionalCount(local.manifest) > 0 && regionalCount(published.manifest) === 0) {
    const regionalStatus = published.manifest.sourceStatuses?.find(source => source.source === 'region-hannover-ris');
    const unqueried = !includesRegionSource(published.manifest.sources) || !regionalStatus || regionalStatus.retrievedAt === null;
    return unqueried ? local : published;
  }
  // A failed refresh updates the manifest without changing its original generation time.
  if (published.generated === local.generated && published.manifest.refreshFailure &&
      (!local.manifest.refreshFailure || published.manifest.refreshFailure.attemptedAt > local.manifest.refreshFailure.attemptedAt)) {
    return published;
  }
  return local;
}

const recordCount = manifest => manifest?.records?.count ?? manifest?.recordCount;
const mapCount = manifest => manifest?.map?.count ?? manifest?.geometryCount;

function rejectCoverageDowngrade(next, previous, excludedCount = 0) {
  const coverage = next.coverage;
  const old = previous.coverage;
  if (next.city === 'hannover' && includesRegionSource(previous.sources) && !includesRegionSource(next.sources)) {
    throw new Error('The previously indexed Region Hannover source is missing from the new snapshot');
  }
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
  if (recordCount(next) < (recordCount(previous) - excludedCount) * 0.9) {
    throw new Error(`Official record count fell from ${recordCount(previous)} to ${recordCount(next)}`);
  }
}

function verifiedRegionExclusions(catalogue, city, now) {
  const values = catalogue.exclusions ?? [];
  if (!Array.isArray(values) || values.length > 50_000) throw new Error('Invalid regional exclusion evidence');
  const ids = new Set();
  for (const value of values) {
    const match = /^region-hannover-ris:vo:(\d+)$/.exec(value?.id || '');
    let url;
    try { url = new URL(value.url); } catch (_) { /* rejected below */ }
    const verified = Date.parse(value?.verifiedAt);
    if (city !== 'hannover' || !match || value.reason !== 'not-public' ||
        !/^https:\/\/ris\.hannit\.de\/public\/vo020\?/.test(value.url || '') || url?.hash ||
        url?.searchParams.getAll('VOLFDNR').length !== 1 || url?.searchParams.get('VOLFDNR') !== match[1] ||
        !Number.isFinite(verified) || verified > now.getTime() || new Date(verified).toISOString() !== value.verifiedAt) {
      throw new Error('Invalid regional exclusion evidence');
    }
    ids.add(value.id);
  }
  return ids;
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
  return { ...atkis, entries: [...atkis.entries, ...additional], regionalProjectAddresses: curated?.regionalProjectAddresses,
    streetAliases: curated?.streetAliases, publicFacilities: curated?.publicFacilities,
    regionalTramStops: JSON.parse(await fs.readFile(path.join(folder, 'hannover-stadtbahn.json'), 'utf8')) };
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

function reassessRetainedLocations(records, city, gazetteer, checkpointEvidence = new Map()) {
  const inputs = records.map(record => {
    const checkpoint = checkpointEvidence.get(record.id);
    const document = checkpoint?.paragraphs || [...new Set((record.locations || []).filter(location => location.evidence.source === 'document')
      .map(location => location.evidence.text))];
    return {
      ...record, locationEvidence: document,
      locationTitleEvidence: [...new Set((record.locations || []).filter(location => location.evidence.source === 'title')
        .map(location => location.evidence.text))],
      // Stored quotations do not establish full document availability.
      locationEvidenceTruncated: checkpoint ? checkpoint.truncated : document.length > 0 || record.locationAssessment?.truncated === true,
      locationEvidenceUnavailable: record.locationEvidenceUnavailable === true || !document.length
        || record.locationAssessment?.reasons.includes('document_text_unavailable') === true,
    };
  });
  return enrichRisLocations(inputs, { city, gazetteer, maxLocationsPerRecord: Infinity }).map((record, index) => {
    let restoredAddress = false;
    const locations = record.locations.map(location => {
      const prior = records[index].locations?.find(old => old.kind === location.kind && old.label === location.label
        && old.evidence.source === location.evidence.source && old.evidence.text === location.evidence.text);
      // Keep the verified map evidence and its credit for unchanged matches.
      // A corrected range or a newly rejected marker must not inherit a point.
      if (!prior?.geometry || isPetitionerContactAddress(location)) return location;
      restoredAddress ||= location.kind === 'address';
      return { ...location, geometry: prior.geometry, ...(prior.mapLabel ? { mapLabel: prior.mapLabel } : {}) };
    });
    const reasons = record.locationAssessment.reasons.filter(reason =>
      !(reason === 'non_traffic_address' && restoredAddress)
      && !(reason === 'unmapped_location' && locations.every(location => validLocationGeometry(location.geometry, location.kind))));
    const mapped = record.locationSource === 'official' || locations.some(location => validLocationGeometry(location.geometry, location.kind));
    return { ...record, title: records[index].title, locations, locationAssessment: { ...record.locationAssessment, reasons,
      status: mapped ? (reasons.length ? 'partial' : 'mapped') : record.locationAssessment.status } };
  });
}

function retainedLegacyAssessment(record) {
  // Legacy snapshots can contain verified detail without assessment metadata.
  // Describe only that retained evidence; do not re-geocode it from the newer
  // list title or imply that the unavailable document was freshly inspected.
  const sources = ['title'];
  if (record.locations?.some(location => location.evidence.source === 'document')) sources.push('document');
  if (record.geometry && record.locationSource === 'official') sources.push('official');
  const mapped = sources.includes('official') || record.locations?.some(location => location.mapped);
  const truncated = record.locationEvidenceTruncated === true;
  return {
    status: mapped ? 'partial' : 'unresolved', sources,
    reasons: ['document_text_unavailable', ...(truncated ? ['evidence_truncated'] : [])], truncated,
  };
}

async function prepareCandidate(directory, city, now, collect, previous, report, sourceOptions = {}, onExclusions = () => {}) {
  let catalogue;
  try {
    catalogue = await collect(city, now, { ...sourceOptions, previousCoverage: previous?.manifest.coverage,
      previousSourceStatuses: previous?.manifest.sourceStatuses, report });
  } catch (error) {
    onExclusions(verifiedRegionExclusions({ exclusions: error.exclusions }, city, now));
    throw error;
  }
  const exclusions = verifiedRegionExclusions(catalogue || {}, city, now);
  onExclusions(exclusions);
  let coverage = catalogue?.coverage;
  if (!catalogue?.records?.length || !coverage?.from || !coverage.to || !coverage.bodies?.length ||
      (city === 'bonn' && !coverage.complete)) {
    throw new Error(coverage?.warnings?.join(' ') || 'The official source did not return a usable catalogue');
  }
  let inputs = catalogue.records.filter(record => !exclusions.has(record.id));
  let excludedCount = 0;
  let sourceStatuses = catalogue.sourceStatuses;
  // Composition cannot establish an unknown contributing source clock from
  // another source. Retain the verified fallback and its original age instead.
  const unverifiedSource = sourceStatuses?.find(source =>
    ['hannover-sim', 'region-hannover-ris'].includes(source.source) && source.recordCount > 0 && !source.retrievedAt);
  if (unverifiedSource) {
    const label = unverifiedSource.source === 'hannover-sim' ? 'SIM' : 'Region';
    throw new Error(`Contributing Hannover ${label} source has no verified source timestamp`);
  }
  const historicalSourceClocks = [];
  const retainedDetails = new Map();
  const retainedAssessmentSources = new Map();
  const retainedCheckpointEvidence = new Map();
  // Checkpoint evidence can outlive a published snapshot. Its original detail
  // clock must constrain publication even when no previous manifest exists.
  const retainedClocks = inputs.filter(record => record.locationEvidenceUnavailable && record.detailVerifiedAt)
    .map(record => record.detailVerifiedAt);
  if (previous?.manifest && catalogue.history) {
    const old = await readRisSnapshot(previous.directory, city);
    const priorRecords = new Map(snapshotInputs(old).map(record => [record.id, record]));
    for (const id of exclusions) if (priorRecords.delete(id)) excludedCount++;
    const incoming = new Set(inputs.map(record => record.id));
    const historicalRecords = [...priorRecords.values()].filter(record => !incoming.has(record.id));
    if (historicalRecords.length) {
      historicalSourceClocks.push(old.manifest.generatedAt);
      coverage = { ...coverage, warnings: [...coverage.warnings,
        `${historicalRecords.length} ältere Datensätze bleiben mit dem verifizierten Stand vom ${old.manifest.generatedAt} erhalten.`] };
      if (sourceStatuses) {
        const retained = new Map();
        for (const record of historicalRecords) retained.set(record.source, (retained.get(record.source) || 0) + 1);
        sourceStatuses = sourceStatuses.map(current => {
          const relevant = retained.has(current.source) || retained.has('niedersachsen-landtag') && current.source.startsWith('landtag-');
          const prior = old.manifest.sourceStatuses?.find(status => status.source === current.source);
          if (!relevant) return current;
          return { ...current, retrievedAt: [current.retrievedAt, prior?.retrievedAt || old.manifest.generatedAt].filter(Boolean).sort()[0],
            recordCount: current.recordCount + (retained.get(current.source) || 0),
            message: `${current.message} Frühere verifizierte Datensätze bleiben historisch erhalten.`.slice(0, 512) };
        });
      }
    }
    for (const next of inputs) {
      const prior = priorRecords.get(next.id);
      const unavailable = next.locationEvidenceUnavailable === true;
      const verifiedDetail = prior && (prior.geometry || prior.locations?.length || prior.relatedTo || prior.events?.length || prior.relationships?.length || prior.locationAssessment?.sources.includes('document'));
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
        else merged.locationAssessment = retainedLegacyAssessment(prior);
        retainedDetails.set(next.id, merged);
        // Unmapped snapshots have no saved body quotations. A dated source
        // checkpoint can still supply that original text after a failed retry,
        // including after a snapshot-only upgrade already advanced the revision.
        const verifiedAt = Date.parse(next.detailVerifiedAt);
        const paragraphs = Array.isArray(next.locationEvidence)
          ? next.locationEvidence.filter(text => typeof text === 'string' && text.trim()) : [];
        if (!prior.locations?.length && paragraphs.length && Number.isFinite(verifiedAt) && verifiedAt <= now.getTime()) {
          retainedCheckpointEvidence.set(next.id, { paragraphs, truncated: next.locationEvidenceTruncated === true });
        }
        if (needsLocationAssessment(old.manifest) || retainedCheckpointEvidence.has(next.id)) {
          // Reassess only the prior snapshot's title and saved quotations;
          // newer list metadata is not a substitute for the unavailable body.
          retainedAssessmentSources.set(next.id, { ...prior, locationEvidenceUnavailable: true });
        }
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
  const reassessed = new Map(reassessRetainedLocations([...retainedAssessmentSources.values()], city, gazetteer, retainedCheckpointEvidence)
    .map(record => [record.id, record]));
  for (const record of retainedDetails.values()) {
    const assessment = reassessed.get(record.id);
    records.push(assessment ? { ...record, locations: assessment.locations, locationAssessment: assessment.locationAssessment } : record);
  }
  if (previous?.manifest && ((catalogue.history?.retainPreviousClock ?? catalogue.history?.interrupted) || retainedDetails.size)) {
    retainedClocks.push(previous.manifest.generatedAt);
  }
  const retainedAt = retainedClocks.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (retainedAt) coverage = { ...coverage, warnings: [...new Set([...coverage.warnings,
    `Nicht aktuell verfügbare Details behalten ihren zuletzt verifizierten Stand vom ${retainedAt}.`])] };
  const sourceClock = [catalogue.generatedAt, retainedAt, ...historicalSourceClocks, ...inputs.map(record => record.detailVerifiedAt)].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || now.toISOString();
  const retainedSource = { generatedAt: sourceClock,
    withdrawalsRecordedAt: excludedCount ? now.toISOString() : previous?.manifest.withdrawalsRecordedAt,
    ...(retainedAt && previous?.manifest.refreshFailure ? { refreshFailure: { ...previous.manifest.refreshFailure,
      expiresAt: new Date(Date.parse(sourceClock) + RIS_FALLBACK_MAX_AGE_MS).toISOString() } } : {}) };
  const provenance = collectionProvenance({ catalogue, city, records, sourceRecords: inputs, sourceVerifiedAt: sourceClock, now, sourceOptions });
  await writeRisSnapshot(directory, city, { ...catalogue, ...(sourceStatuses ? { sourceStatuses } : {}), ...retainedSource, provenance, coverage, records, locationRevision: LOCATION_REVISIONS[city] }, { now, schemaVersion: 2 });
  const { manifest } = await readRisSnapshot(directory, city);
  if (manifest.locationAssessment?.attempted !== recordCount(manifest)) throw new Error('Not every indexed record received a location assessment');
  assertUnexpiredSnapshot(manifest, now);
  if (previous?.manifest) rejectCoverageDowngrade(manifest, previous.manifest, excludedCount);
  return { directory, manifest };
}

async function prepareExclusionFallback(directory, previous, exclusions, now) {
  const original = await readRisSnapshot(previous.directory, previous.manifest.city);
  const records = original.records.filter(record => !exclusions.has(record.id));
  if (records.length === original.records.length) return previous;
  if (!records.length) return null;
  const source = original.manifest;
  const sourceStatuses = source.sourceStatuses?.map(status => status.source === 'region-hannover-ris'
    ? { ...status, recordCount: records.filter(record => record.source === status.source).length } : status);
  // The acquisition fingerprint still describes the original source projection;
  // the normalized count describes the smaller public output after withdrawal.
  const provenance = source.provenance && { ...source.provenance,
    collection: { ...source.provenance.collection, normalizedItems: records.length } };
  const manifest = await writeRisSnapshot(directory, source.city, { ...source, records, withdrawalsRecordedAt: now.toISOString(),
    features: { ...original.features, features: original.features.features.filter(feature => !exclusions.has(feature.properties.recordId)) },
    ...(sourceStatuses ? { sourceStatuses } : {}), ...(provenance ? { provenance } : {}),
    coverage: { ...source.coverage, complete: false, warnings: [...new Set([...source.coverage.warnings,
      'Ausdrücklich nichtöffentliche Vorlagen wurden aus dem beibehaltenen Bestand entfernt.'])] },
  }, { now, schemaVersion: 2 });
  await readRisSnapshot(directory, source.city);
  return { directory, manifest };
}

function needsLocationAssessment(manifest) {
  return !manifest || (manifest.locationRevision ?? 0) < LOCATION_REVISIONS[manifest.city] ||
    manifest.locationAssessment?.attempted !== recordCount(manifest);
}

async function prepareLocalAssessment(directory, selected, builtAt) {
  const source = selected.manifest;
  const original = await readRisSnapshot(selected.directory, source.city);
  if (!needsLocationAssessment(source)) {
    const manifest = await writeRisSnapshot(directory, source.city, { ...source, records: original.records, features: original.features },
      { now: builtAt, schemaVersion: 2 });
    return { directory, manifest };
  }
  const records = snapshotInputs(original);
  const gazetteer = await loadGazetteer(source.city);
  const next = await writeRisSnapshot(directory, source.city, {
    sources: source.sources, coverage: source.coverage, locationRevision: LOCATION_REVISIONS[source.city],
    ...(source.sourceStatuses === undefined ? {} : { sourceStatuses: source.sourceStatuses }),
    ...(source.withdrawalsRecordedAt === undefined ? {} : { withdrawalsRecordedAt: source.withdrawalsRecordedAt }),
    records: reassessRetainedLocations(records, source.city, gazetteer),
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
  const checkpointRetry = city === 'hannover' && sourceOptions.checkpointRetry;
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
    const previousSimStart = previous.manifest?.sourceStatuses?.find(source => source.source === 'hannover-sim')?.from
      ?? previous.manifest?.coverage.from;
    const upgradeHistory = city === 'hannover' && (previous.manifest?.coverage.scope !== 'citywide' ||
      previousSimStart > `${sourceOptions.historyStartYear}-01-01` ||
      previous.manifest?.coverage.warnings.some(warning => /Quellenarbeit ist fortsetzbar/.test(warning)));
    // Earlier catalogues declared the portal as a manual link with zero rows.
    // A declared URL alone does not establish that the regional import exists.
    const upgradeRegion = city === 'hannover' && (!includesRegionSource(previous.manifest?.sources) ||
      !previous.manifest?.sourceStatuses?.some(source => source.source === 'region-hannover-ris' && source.recordCount > 0));
    const previousRegion = previous.manifest?.sourceStatuses?.find(source => source.source === 'region-hannover-ris');
    const firstRegionImport = upgradeRegion && (!previousRegion || previousRegion.status !== 'failed' && previousRegion.retrievedAt === null);
    const fallbackExpired = previous.manifest && startedAt.getTime() >= previous.generated + RIS_FALLBACK_MAX_AGE_MS;
    const canRetrySource = checkpointRetry || firstRegionImport || !lastFailure || fallbackExpired || startedAt.getTime() - Date.parse(lastFailure) >= SOURCE_RETRY_MS;
    const refreshDue = checkpointRetry || !previous.manifest || upgradeLocations || upgradeHistory || upgradeRegion || startedAt.getTime() - previous.generated >= REFRESH_AFTER_MS;
    if (!restoreOnly && refreshDue && canRetrySource) {
      let exclusions = new Set();
      try {
        selected = await prepareCandidate(path.join(scratch, 'candidate'), city, startedAt, collect, previous.manifest ? previous : null,
          progress => report({ city, status: 'collecting', ...progress }), sourceOptions, values => { exclusions = values; });
        status = 'published';
      } catch (error) {
        reason = error?.message || 'Official RIS refresh failed';
        const expiry = previous.generated + RIS_FALLBACK_MAX_AGE_MS;
        if (previous.manifest && clock().getTime() < expiry) {
          let fallback = exclusions.size
            ? await prepareExclusionFallback(path.join(scratch, 'public-fallback'), previous, exclusions, startedAt) : previous;
          if (fallback && firstRegionImport) {
            // An earlier SIM failure must not suppress a newly added source.
            // Record the first failed regional import so later calls obey the
            // usual backoff instead of repeatedly treating it as a new source.
            const url = 'https://ris.hannit.de/public/vo040';
            fallback = { ...fallback, manifest: { ...fallback.manifest,
              sources: [...new Set([...fallback.manifest.sources, url])],
              sourceStatuses: [...(fallback.manifest.sourceStatuses || []).filter(source => source.source !== 'region-hannover-ris'), {
                source: 'region-hannover-ris', status: 'failed', url, retrievedAt: null, from: null, to: null, recordCount: 0,
                message: 'Regionsdokumente konnten noch nicht in den Index übernommen werden.',
              }],
            } };
          }
          const refreshFailure = {
            attemptedAt: startedAt.toISOString(), reason: PUBLIC_REFRESH_FAILURE, expiresAt: new Date(expiry).toISOString(),
          };
          selected = fallback ? { ...fallback, manifest: { ...fallback.manifest, refreshFailure }, rewriteManifest: true } : {};
          status = fallback ? 'retained' : 'unavailable';
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

    if (!restoreOnly && selected.levelCounts && !selected.manifest.levelCounts) {
      selected = { ...selected, manifest: { ...selected.manifest, levelCounts: selected.levelCounts }, rewriteManifest: true };
    }
    const { manifest } = selected;
    if (checkpointRetry && (status !== 'published' || recordCount(manifest) < checkpointRetry.minimumRecords)) {
      throw new Error(`Hannover checkpoint recovery failed: ${reason || `${status}; ${recordCount(manifest) || 0} records, minimum ${checkpointRetry.minimumRecords}`}`);
    }
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
  historyStartYear, workBudget, maxDurationMs, maxRefreshDurationMs, sourceDirectory, checkpointRetry } = {}) {
  const refreshStarted = performance.now();
  if (!Array.isArray(cities) || !cities.length || cities.some(city => !Object.hasOwn(SOURCE_LIMIT_MS, city))) {
    throw new Error('Supported RIS cities: bonn, hannover');
  }
  if (historyStartYear !== undefined && (!Number.isInteger(historyStartYear) || historyStartYear < 1900 || historyStartYear > 9999)) {
    throw new TypeError('Invalid RIS historical start year');
  }
  if (workBudget !== undefined && (!Number.isSafeInteger(workBudget) || workBudget < 0)) throw new TypeError('Invalid RIS work budget');
  if (maxRefreshDurationMs !== undefined && (!Number.isSafeInteger(maxRefreshDurationMs) || maxRefreshDurationMs <= 0)) {
    throw new TypeError('Invalid RIS refresh duration');
  }
  if (checkpointRetry !== undefined) {
    checkpointRetry = validateCheckpointRetry(checkpointRetry);
    if (restoreOnly || !cities.includes('hannover')) throw new Error('Checkpoint recovery requires a Hannover refresh');
    if (workBudget !== undefined && workBudget !== 0) throw new Error('Checkpoint recovery requires zero source work');
  }
  const sourceOptions = { workBudget: checkpointRetry ? 0 : workBudget, maxDurationMs, sourceDirectory,
    ...(checkpointRetry ? { checkpointRetry, checkpointOnly: true } : {}) };
  const collectWithinBudget = (city, sourceNow, options) => {
    if (maxRefreshDurationMs === undefined) return collect(city, sourceNow, options);
    // Restoration and validation consume the same Pages time allowance. Only
    // calculate the remaining source time at the actual collection boundary;
    // the fixed source-verification date is independent of this monotone clock.
    const remainingMs = Math.floor(refreshStarted + maxRefreshDurationMs - performance.now());
    const workerTimeoutMs = Math.min(SOURCE_LIMIT_MS[city], remainingMs - REFRESH_FINISH_MS);
    const durationMs = Math.min(options.maxDurationMs ?? SOURCE_LIMIT_MS[city] - SOURCE_FINISH_MS,
      workerTimeoutMs - SOURCE_FINISH_MS);
    if (durationMs <= 0) throw new Error('RIS refresh budget exhausted before source collection');
    return collect(city, sourceNow, { ...options, maxDurationMs: durationMs, workerTimeoutMs });
  };
  const clock = now === undefined ? () => new Date() : () => now;
  const startedAt = clock();
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) throw new Error('Invalid RIS refresh date');
  await listDirectory(directory);
  const outcomes = await Promise.allSettled([...new Set(cities)].map(async city => {
    const outcome = await refreshCity({ directory, city, startedAt, clock, fetchPublished, collect: collectWithinBudget,
      restoreOnly: restoreOnly || Boolean(checkpointRetry && city !== 'hannover'), report,
      sourceOptions: { ...sourceOptions, historyStartYear: historyStartYear ?? historyStartYears[city] } });
    report(outcome);
    return outcome;
  }));
  const errors = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  return outcomes.map(item => item.value);
}

function parseRefreshArguments(args) {
  const usage = 'Usage: node scripts/refresh-ris-catalogues.js [--city bonn|hannover] [--restore-only] [--history-start-year YYYY] [--work-budget N] [--max-duration-ms N] [--max-refresh-duration-ms N]\n' +
    '       node scripts/refresh-ris-catalogues.js --checkpoint-retry hannover --source-cache-key KEY --min-records N\n' +
    '       node scripts/refresh-ris-catalogues.js --validate <directory> [--require-all]';
  if (args[0] === '--validate') {
    if (!args[1] || args.length > 3 || (args[2] && args[2] !== '--require-all')) throw new Error(usage);
    return { validationDirectory: path.resolve(args[1]), requireAll: args[2] === '--require-all' };
  }
  const options = {};
  let recoveryCity, sourceCacheKey;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--restore-only' && !options.restoreOnly) options.restoreOnly = true;
    else if (args[i] === '--city' && !options.cities && args[i + 1]) options.cities = [args[++i]];
    else if (args[i] === '--checkpoint-retry' && recoveryCity === undefined && args[i + 1]) recoveryCity = args[++i];
    else if (args[i] === '--source-cache-key' && sourceCacheKey === undefined && args[i + 1]) sourceCacheKey = args[++i];
    else if (['--history-start-year', '--work-budget', '--max-duration-ms', '--max-refresh-duration-ms', '--min-records'].includes(args[i]) && /^\d+$/.test(args[i + 1] || '')) {
      const key = { '--history-start-year': 'historyStartYear', '--work-budget': 'workBudget', '--max-duration-ms': 'maxDurationMs',
        '--max-refresh-duration-ms': 'maxRefreshDurationMs', '--min-records': 'minimumRecords' }[args[i]];
      if (options[key] !== undefined) throw new Error(usage);
      options[key] = Number(args[++i]);
    } else throw new Error(usage);
  }
  if (recoveryCity !== undefined || sourceCacheKey !== undefined || options.minimumRecords !== undefined) {
    options.checkpointRetry = validateCheckpointRetry({ city: recoveryCity, sourceCacheKey, minimumRecords: options.minimumRecords });
    delete options.minimumRecords;
    if (options.restoreOnly || (options.cities && !options.cities.includes('hannover'))) throw new Error(usage);
    if (options.workBudget !== undefined && options.workBudget !== 0) throw new Error('Checkpoint recovery requires zero source work');
  }
  return options;
}

async function main(args) {
  const options = parseRefreshArguments(args);
  if (options.validationDirectory) {
    const manifests = await validateRisDirectory(options.validationDirectory, { requireAll: options.requireAll });
    console.log(`[ris] Validated ${manifests.length} snapshot(s) for Pages.`);
    return;
  }
  if (options.checkpointRetry) console.log(`[ris] Checkpoint recovery: ${JSON.stringify({ ...options.checkpointRetry, workBudget: 0 })}`);
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
    onExclusions: exclusions => parentPort.postMessage({ exclusions }),
  }).then(
    catalogue => parentPort.postMessage({ catalogue }),
    error => parentPort.postMessage({ error: error.message, exclusions: error.exclusions }),
  );
} else if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[ris] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { refreshRisCatalogues, validateRisDirectory, collectOfficial, parseRefreshArguments };
