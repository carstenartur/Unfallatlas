'use strict';

const crypto = require('node:crypto');
const {setTimeout: wait} = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const archive = require('./koeln_kfz_geometry_archive_provider');
const csv = require('./koeln_kfz_link_csv_provider');
const join = require('./koeln_kfz_geometry_record_join_provider');
const matcher = require('../producers/koeln_kfz_osm_line_match_producer');
const { DEFAULT_GEOM_TOLERANCE_M } = require('../enrich_geojson');
const { applyMatchedTraffic } = require('../apply-matched-traffic');
const { applyQualitativeTrafficProxy } = require('../apply-qualitative-traffic-proxy');

const distributions = [
  { name: 'official.zip', url: archive.DISTRIBUTION_URL, sha256: archive.REVIEWED_DISTRIBUTION_SHA256, bytes: 1853413 },
  { name: 'counts.csv', url: csv.DISTRIBUTION_URL, sha256: csv.REVIEWED_DISTRIBUTION_SHA256, bytes: 2374685 },
];

async function requestDistribution(url, request, delay) {
  const retryableStatus = new Set([408, 429, 500, 502, 503, 504]);
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await request(url, { signal: AbortSignal.timeout(120000) });
    } catch (error) {
      if (attempt >= 2) throw error;
    }
    if (response && (!retryableStatus.has(response.status) || attempt >= 2)) return response;
    if (response && response.body) await response.body.cancel();
    await delay(1000 * 2 ** attempt);
  }
}

async function fetchDistribution(root, source, request = fetch, delay = wait) {
  const label = source.label || 'Köln traffic';
  const response = await requestDistribution(source.url, request, delay);
  if (!response.ok || !response.body) throw new Error(`${label} download failed: ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > source.bytes) throw new Error(`${label} distribution exceeds reviewed size`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== source.bytes) throw new Error(`${label} distribution size mismatch`);
  if (matcher.sha256(bytes) !== source.sha256) throw new Error(`${label} distribution SHA-256 mismatch`);
  const target = path.join(root, source.name);
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return new Date().toISOString();
}

function shouldStageKoelnTraffic(slug, environment = process.env) {
  return slug === 'koeln' && environment.CONTEXT_KOELN_MEASURED_COUNTS === 'true' &&
    !environment.KOELN_KFZ_MATCHED_ARTIFACT && !environment.KOELN_KFZ_MATCHED_ARTIFACT_SHA256;
}

async function stageKoelnTraffic({ workDir, outputDir, osmFile, trafficDir }) {
  fs.mkdirSync(workDir, {recursive: true});
  const [geometry, counts] = distributions;
  const [archiveRetrievedAt, csvRetrievedAt] = await Promise.all(distributions.map(source =>
    fetchDistribution(workDir, source)));
  const schemaFile = path.resolve(__dirname, '../../config/koeln-kfz-geometry-schema.json');
  const generatedAt = new Date().toISOString();
  const official = await join.buildJoinedArtifact({
    schemaRoot: path.dirname(schemaFile), schemaPath: path.basename(schemaFile),
    expectedSchemaSha256: matcher.sha256(fs.readFileSync(schemaFile)),
    archiveRoot: workDir, archivePath: geometry.name, expectedArchiveSha256: geometry.sha256,
    expectedArchiveBytes: geometry.bytes, archiveRetrievedAt,
    csvRoot: workDir, csvPath: counts.name, expectedCsvSha256: counts.sha256,
    expectedCsvBytes: counts.bytes, csvRetrievedAt, generatedAt,
  });
  const officialFile = join.writeAtomic(path.join(workDir, 'joined.json'), official);
  const raw = matcher.readJsonFile(osmFile, 'current OSM producer input');
  const matchingFile = matcher.writeAtomic(path.join(workDir, 'matching-osm.json'), {
    ways: raw.value.ways,
    wayGeometries: raw.value.wayGeometries,
    source: raw.value.source,
    originalDistribution: { fileName: path.basename(osmFile), sha256: raw.sha256 },
    publicGeometry: {format:'ua-encodeGeometry-v1', method:'douglas-peucker', toleranceMeters:DEFAULT_GEOM_TOLERANCE_M},
  });
  const matched = matcher.buildMatchedArtifact(
    matcher.readJsonFile(officialFile, 'official geometry'),
    matcher.readJsonFile(matchingFile, 'current OSM'), { generatedAt });
  const artifactFile = matcher.writeAtomic(path.join(workDir, 'matched.json'), matched);
  const expectedArtifactSha256 = matcher.sha256(fs.readFileSync(artifactFile));
  // Both adapters write only into this city's private staging tree. The caller
  // validates and installs the entire tree in its existing rollback transaction.
  applyQualitativeTrafficProxy({city:'Köln', outputDir, trafficDir});
  const result = await applyMatchedTraffic({city:'Köln', outputDir, artifactFile, expectedArtifactSha256});
  return { ...result, coverage: matched.coverage, expectedArtifactSha256 };
}

module.exports = { fetchDistribution, shouldStageKoelnTraffic, stageKoelnTraffic };
