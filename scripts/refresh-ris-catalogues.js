#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const gzip = promisify(require('node:zlib').gzip);
const { readRisSnapshot, writeRisSnapshot, RIS_FALLBACK_MAX_AGE_MS } = require('../server/political-context/services/risSnapshot');
const { enrichRisLocations } = require('../server/political-context/services/risLocation');

const ROOT = path.resolve(__dirname, '..');
const DIRECTORY = path.join(ROOT, 'data', 'ris');
const PUBLISHED_DIRECTORY = 'https://carstenartur.github.io/Unfallatlas/data/ris/';
const DAY_MS = 24 * 60 * 60 * 1000;
// Allow the weekly workflow to start a few hours earlier than its previous run.
const REFRESH_AFTER_MS = 6.5 * DAY_MS;
const SOURCE_LIMIT_MS = { bonn: 20 * 60_000, hannover: 9 * 60_000 };
const CITIES = Object.keys(SOURCE_LIMIT_MS);
const HANNOVER_DISTRICT = 'Stadtbezirksrat Linden-Limmer';
const HANNOVER_ARCHIVE_BODIES = new Set(['ratsversammlung', HANNOVER_DISTRICT.toLowerCase()]);
const MANIFEST_BYTES = 256 * 1024;
const ASSET_BYTES = 16 * 1024 * 1024;
// Public manifests must not carry raw errors from source responses or local filesystem paths.
const PUBLIC_REFRESH_FAILURE = 'Die letzte Aktualisierung der amtlichen Ratsdaten ist fehlgeschlagen.';

async function collectOfficial(city, now) {
  if (city === 'bonn') {
    const { collectBonnCatalogue } = require('../server/political-context/providers/bonnOparlClient');
    return collectBonnCatalogue({
      now, lookbackYears: now.getUTCFullYear() - 2014, maxPages: 300, pageLimit: 100,
      requestOptions: { timeoutMs: 20_000, maxRedirects: 0, maxBytes: 4 * 1024 * 1024 },
    });
  }
  const { collectHannoverCatalogue } = require('../server/political-context/providers/hannoverSimCatalogue');
  return collectHannoverCatalogue({
    now, from: '2026-01-01', strict: true, maxMeetings: 60,
    discoverArchives: ['districts'], archiveBodies: [HANNOVER_DISTRICT],
  });
}

async function collectFromSource(city, now) {
  // A worker bounds the wall clock even if a source keeps a connection alive.
  const worker = new Worker(__filename, { workerData: { city, now: now.toISOString() } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Source crawl exceeded ${SOURCE_LIMIT_MS[city] / 60_000} minutes`)), SOURCE_LIMIT_MS[city]);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Source worker exited without a catalogue (${code})`)));
      worker.once('message', ({ catalogue, error }) => error ? reject(new Error(error)) : resolve(catalogue));
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

function snapshotFiles(manifest) {
  return [manifest.records.path, manifest.map.path, `${manifest.city}.json`];
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
  const files = new Set(manifests.flatMap(snapshotFiles));
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
  if (manifest?.city !== city || manifest.schemaVersion !== 1) throw new Error('Published RIS manifest has the wrong city or version');
  // Bound manifest-controlled requests to the exact content-addressed names for this city.
  const assets = ['records', 'map'].map(kind => {
    const { path: filename, sha256 } = manifest[kind] || {};
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || filename !== `${city}.${sha256}.${kind}.json.gz`) {
      throw new Error(`Published RIS manifest has an invalid ${kind} path`);
    }
    return filename;
  });
  await fs.mkdir(directory);
  for (const filename of assets) {
    const bytes = await fetchPublishedFile(fetch, filename);
    // Pages normally serves binary gzip. Also accept bytes decoded by HTTP content negotiation.
    const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b ? bytes : await gzip(bytes);
    await fs.writeFile(path.join(directory, filename), compressed);
  }
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
  for (const filename of snapshotFiles(manifest)) {
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
  const keep = new Set(manifest ? snapshotFiles(manifest) : []);
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

function rejectCoverageDowngrade(next, previous) {
  const coverage = next.coverage;
  const old = previous.coverage;
  if ((old.complete && !coverage.complete) || (old.from && coverage.from > old.from) ||
      (old.to && coverage.to < old.to)) throw new Error('Official coverage is narrower than the previous snapshot');
  const scopeBodies = ({ city, coverage: { bodies } }) => bodies.map(body => {
    const label = body.toLowerCase();
    return city === 'bonn' && /^(?:(?:bundes)?stadt )?bonn$/.test(label) ? 'bonn' : label;
  }).filter(body => next.city !== 'hannover' || HANNOVER_ARCHIVE_BODIES.has(body));
  const nextBodies = new Set(scopeBodies(next));
  if (scopeBodies(previous).some(body => !nextBodies.has(body))) {
    throw new Error('An official council is missing from the new snapshot');
  }
  // Hannover's daily RSS can legitimately lose a recent council name as its window rolls.
  // The archive and feed URLs capture the source scope independently of that window.
  if (next.city === 'hannover' && previous.sources.some(source => !next.sources.includes(source))) {
    throw new Error('An official archive or feed is missing from the new snapshot');
  }
  if (next.records.count < previous.records.count * 0.9) {
    throw new Error(`Official record count fell from ${previous.records.count} to ${next.records.count}`);
  }
}

async function prepareCandidate(directory, city, now, collect, previous) {
  const catalogue = await collect(city, now);
  const coverage = catalogue?.coverage;
  if (!catalogue?.records?.length || !coverage?.from || !coverage.to || !coverage.bodies?.length ||
      (city === 'bonn' && !coverage.complete)) {
    throw new Error(coverage?.warnings?.join(' ') || 'The official source did not return a usable catalogue');
  }
  let gazetteer;
  try {
    gazetteer = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'ris-locations', `${city}.json`), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const records = enrichRisLocations(catalogue.records, { city, gazetteer });
  await writeRisSnapshot(directory, city, { ...catalogue, records }, { now });
  const { manifest } = await readRisSnapshot(directory, city);
  if (previous) rejectCoverageDowngrade(manifest, previous);
  return { directory, manifest };
}

async function refreshCity({ directory, city, startedAt, clock, fetchPublished, collect, restoreOnly }) {
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
    if (!restoreOnly && (!previous.manifest || startedAt.getTime() - previous.generated >= REFRESH_AFTER_MS)) {
      try {
        selected = await prepareCandidate(path.join(scratch, 'candidate'), city, startedAt, collect, previous.manifest);
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

    const { manifest } = selected;
    if (manifest) {
      assertUnexpiredSnapshot(manifest, clock());
      if (selected.rewriteManifest || selected.directory !== directory) await installSnapshot(directory, selected);
    }
    await pruneCity(directory, city, manifest);
    return {
      city, status, ...(reason ? { reason } : {}),
      ...(manifest ? { generatedAt: manifest.generatedAt, records: manifest.records.count, mapped: manifest.map.count } : {}),
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function refreshRisCatalogues({ directory = DIRECTORY, cities = CITIES, now,
  fetchPublished = globalThis.fetch, collect = collectFromSource, restoreOnly = false, report = () => {} } = {}) {
  if (!Array.isArray(cities) || !cities.length || cities.some(city => !Object.hasOwn(SOURCE_LIMIT_MS, city))) {
    throw new Error('Supported RIS cities: bonn, hannover');
  }
  const clock = now === undefined ? () => new Date() : () => now;
  const startedAt = clock();
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) throw new Error('Invalid RIS refresh date');
  await listDirectory(directory);
  const outcomes = await Promise.allSettled([...new Set(cities)].map(async city => {
    const outcome = await refreshCity({ directory, city, startedAt, clock, fetchPublished, collect, restoreOnly });
    report(outcome);
    return outcome;
  }));
  const errors = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  return outcomes.map(item => item.value);
}

async function main(args) {
  const usage = 'Usage: node scripts/refresh-ris-catalogues.js [--city bonn|hannover] [--restore-only]\n' +
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
    else throw new Error(usage);
  }
  await refreshRisCatalogues({
    ...options,
    report({ city, status, generatedAt, records, mapped, reason }) {
      const detail = generatedAt ? ` (${generatedAt}; ${records} records, ${mapped} mapped)` : '';
      console.log(`[ris] ${city}: ${status}${detail}${reason ? ` — ${reason}` : ''}`);
    },
  });
}

if (!isMainThread && workerData?.city) {
  collectOfficial(workerData.city, new Date(workerData.now)).then(
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
