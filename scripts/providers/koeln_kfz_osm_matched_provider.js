#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const traffic = require('../../js/ua.traffic_provider');
const matcher = require('../producers/koeln_kfz_osm_line_match_producer');

const PROVIDER_ID = 'traffic.count.koeln-kfz-osm-2016-2019';
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class KoelnKfzOsmMatchedProviderError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'KoelnKfzOsmMatchedProviderError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new KoelnKfzOsmMatchedProviderError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_value', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredHash(value, label) {
  const text = requiredString(value, label);
  if (!HASH_PATTERN.test(text)) fail('invalid_hash', `${label} must be a lowercase SHA-256 digest`);
  return text;
}

function resolveRegularFile(value, label) {
  const requested = path.resolve(requiredString(value, label));
  let current = path.parse(requested).root;
  for (const segment of requested.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('unsafe_file', `${label} path contains a symbolic link`, { current });
  }
  const stat = fs.statSync(requested);
  if (!stat.isFile()) fail('unsafe_file', `${label} must be a regular file`, { requested });
  return fs.realpathSync(requested);
}

function readPinnedArtifact(options = {}) {
  const file = resolveRegularFile(options.artifactFile, 'artifactFile');
  const bytes = fs.readFileSync(file);
  const expected = requiredHash(options.expectedArtifactSha256, 'expectedArtifactSha256');
  const actual = sha256(bytes);
  if (actual !== expected) {
    fail('artifact_hash_mismatch', 'matched traffic artifact differs from its external pin', {
      expected,
      actual,
    });
  }
  let artifact;
  try {
    artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    fail('invalid_artifact', 'matched traffic artifact must be valid UTF-8 JSON', {
      cause: error.message,
    });
  }
  artifact = plainObject(artifact, 'matched traffic artifact');
  if (artifact.schemaVersion !== matcher.OUTPUT_SCHEMA_VERSION || artifact.type !== matcher.OUTPUT_TYPE) {
    fail('unsupported_artifact', `expected ${matcher.OUTPUT_TYPE} v${matcher.OUTPUT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(artifact.observations) || !Array.isArray(artifact.directedMatches) ||
      !artifact.coverage || !artifact.matcher || !artifact.sources || !artifact.truthBoundary) {
    fail('invalid_artifact', 'matched traffic artifact lacks required evidence sections');
  }
  if (artifact.truthBoundary.directionAwareOsmMatchingPerformed !== true ||
      artifact.truthBoundary.trafficValuesChanged !== false ||
      artifact.truthBoundary.ambiguousMatchesPromoted !== false) {
    fail('invalid_truth_boundary', 'matched traffic artifact makes unsafe truth-boundary claims');
  }
  const fingerprint = requiredHash(artifact.artifactFingerprint, 'artifactFingerprint');
  const unsigned = { ...artifact };
  delete unsigned.artifactFingerprint;
  const computedFingerprint = sha256(Buffer.from(matcher.canonicalJson(unsigned)));
  if (computedFingerprint !== fingerprint) {
    fail('artifact_fingerprint_mismatch', 'matched traffic artifact fingerprint is invalid', {
      expected: fingerprint,
      actual: computedFingerprint,
    });
  }
  return Object.freeze({ file, bytes, sha256: actual, artifact: Object.freeze(artifact) });
}

function sourceDescriptor(loaded) {
  const sourceRoot = plainObject(loaded.artifact.sources.traffic, 'sources.traffic');
  const joinedSource = plainObject(sourceRoot.source, 'sources.traffic.source');
  const original = plainObject(joinedSource.traffic, 'sources.traffic.source.traffic');
  const sourceId = requiredString(original.sourceId || original.id, 'original traffic source ID');
  const originalNotes = Array.isArray(original.qualityNotes) ? original.qualityNotes : [];
  const originalNotice = original.changeNotice == null ? '' : String(original.changeNotice).trim();
  return {
    id: PROVIDER_ID,
    publisher: requiredString(original.publisher, 'publisher'),
    datasetTitle: requiredString(original.datasetTitle, 'datasetTitle'),
    datasetUrl: requiredString(original.datasetUrl, 'datasetUrl'),
    distributionUrl: requiredString(original.distributionUrl, 'distributionUrl'),
    licenseId: requiredString(original.licenseId, 'licenseId'),
    licenseName: requiredString(original.licenseName, 'licenseName'),
    licenseUrl: requiredString(original.licenseUrl, 'licenseUrl'),
    requiredAttribution: requiredString(original.requiredAttribution, 'requiredAttribution'),
    temporalCoverage: requiredString(original.temporalCoverage, 'temporalCoverage'),
    spatialCoverage: requiredString(original.spatialCoverage, 'spatialCoverage'),
    versionOrPublicationDate: requiredString(
      original.versionOrPublicationDate,
      'versionOrPublicationDate',
    ),
    retrievedAt: requiredString(original.retrievedAt, 'retrievedAt'),
    contentHash: loaded.sha256,
    changedOrDerived: true,
    changeNotice: [
      originalNotice,
      `Quelle ${sourceId}: gerichtete amtliche Linien wurden mit ` +
        `${loaded.artifact.matcher.algorithm} auf OSM-Ways abgebildet; nur eindeutige Matches ` +
        'werden als Messwert-Provider veröffentlicht.',
    ].filter(Boolean).join(' '),
    permissions: plainObject(original.permissions, 'permissions'),
    qualityNotes: [
      ...originalNotes.map(String),
      `Abgeleitetes Matcher-Artefakt SHA-256 ${loaded.sha256}.`,
      'Mehrdeutige und nicht gematchte Beobachtungen werden nicht als OSM-Way-Messwerte veröffentlicht.',
    ],
    measurementType: 'count',
    modes: ['motor_vehicle'],
    unit: 'Kfz/24 h',
    priority: 1,
  };
}

function rounded(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function matchedObservation(value, index) {
  const observation = plainObject(value, `observations[${index}]`);
  const osmMatch = plainObject(observation.osmMatch, `observations[${index}].osmMatch`);
  if (osmMatch.status !== 'matched') return null;
  const wayId = requiredString(String(osmMatch.wayId), `observations[${index}].osmMatch.wayId`);
  const matchQuality = requiredString(osmMatch.matchQuality, `observations[${index}].osmMatch.matchQuality`);
  if (!traffic.MATCH_QUALITIES.includes(matchQuality)) {
    fail('invalid_match_quality', `observations[${index}] has unsupported matchQuality`, {
      matchQuality,
    });
  }
  const directionRelation = requiredString(
    osmMatch.directionRelation,
    `observations[${index}].osmMatch.directionRelation`,
  );
  if (!['same', 'reverse'].includes(directionRelation)) {
    fail('invalid_direction_relation', `observations[${index}] has unsupported directionRelation`, {
      directionRelation,
    });
  }
  const numericFields = [
    'meanDistanceMeters',
    'p95DistanceMeters',
    'maximumDistanceMeters',
    'angleDifferenceDegrees',
    'coverageRatio',
    'score',
  ];
  for (const field of numericFields) {
    if (!Number.isFinite(Number(osmMatch[field])) || Number(osmMatch[field]) < 0) {
      fail('invalid_match_metric', `observations[${index}].osmMatch.${field} must be non-negative`);
    }
  }
  const sourceWayId = requiredString(String(observation.wayId), `observations[${index}].wayId`);
  const originalDirection = observation.direction == null ? null : String(observation.direction).trim();
  return Object.freeze({
    observationId: requiredString(observation.observationId, `observations[${index}].observationId`),
    measurementType: 'count',
    mode: requiredString(observation.mode, `observations[${index}].mode`),
    year: Number(observation.year),
    period: requiredString(observation.period, `observations[${index}].period`),
    value: Number(observation.value),
    unit: requiredString(observation.unit, `observations[${index}].unit`),
    geometry: observation.geometry,
    wayId,
    direction: [
      originalDirection,
      `OSM-Way-Richtung: ${directionRelation}`,
    ].filter(Boolean).join('; '),
    qualityNotes: Object.freeze([
      ...(Array.isArray(observation.qualityNotes) ? observation.qualityNotes.map(String) : []),
      `Quellsegment ${sourceWayId}; OSM-Match ${matchQuality}; ` +
        `Mittel ${rounded(osmMatch.meanDistanceMeters)} m, ` +
        `P95 ${rounded(osmMatch.p95DistanceMeters)} m, ` +
        `Maximum ${rounded(osmMatch.maximumDistanceMeters)} m, ` +
        `Winkeldifferenz ${rounded(osmMatch.angleDifferenceDegrees)}°, ` +
        `Abdeckung ${rounded(Number(osmMatch.coverageRatio) * 100)} %.`,
    ]),
  });
}

function createKoelnKfzOsmMatchedProvider(options = {}) {
  const loaded = readPinnedArtifact(options);
  const descriptor = sourceDescriptor(loaded);
  const matched = [];
  const excluded = { ambiguous: 0, unmatched: 0 };
  loaded.artifact.observations.forEach((observation, index) => {
    const status = observation && observation.osmMatch && observation.osmMatch.status;
    if (status === 'matched') matched.push(matchedObservation(observation, index));
    else if (status === 'ambiguous') excluded.ambiguous += 1;
    else if (status === 'unmatched') excluded.unmatched += 1;
    else fail('invalid_match_status', `observations[${index}] has unsupported osmMatch status`, { status });
  });
  const coverage = plainObject(loaded.artifact.coverage, 'coverage');
  if (matched.length !== Number(coverage.matchedObservations) ||
      excluded.ambiguous !== Number(coverage.ambiguousObservations) ||
      excluded.unmatched !== Number(coverage.unmatchedObservations) ||
      matched.length + excluded.ambiguous + excluded.unmatched !== loaded.artifact.observations.length) {
    fail('coverage_mismatch', 'matched traffic observation counts differ from artifact coverage', {
      matched: matched.length,
      excluded,
      coverage,
    });
  }
  if (options.requireFullCoverage === true && (excluded.ambiguous || excluded.unmatched)) {
    fail('incomplete_osm_coverage', 'full matched coverage was required', { excluded });
  }
  const provider = traffic.createProvider({
    descriptor,
    canProvide(context) {
      const city = String((context && context.city) || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/gi, '')
        .toLowerCase();
      return city === 'koln' || city === 'koeln';
    },
    async loadObservations() {
      return matched;
    },
  });
  return Object.freeze({
    ...provider,
    matchedArtifact: Object.freeze({
      path: path.basename(loaded.file),
      sha256: loaded.sha256,
      artifactFingerprint: loaded.artifact.artifactFingerprint,
      matcher: loaded.artifact.matcher,
    }),
    coverage: Object.freeze({
      totalObservations: loaded.artifact.observations.length,
      publishedObservations: matched.length,
      excludedAmbiguousObservations: excluded.ambiguous,
      excludedUnmatchedObservations: excluded.unmatched,
      matchedGroups: Number(coverage.matchedGroups),
      ambiguousGroups: Number(coverage.ambiguousGroups),
      unmatchedGroups: Number(coverage.unmatchedGroups),
    }),
  });
}

module.exports = Object.freeze({
  PROVIDER_ID,
  HASH_PATTERN,
  KoelnKfzOsmMatchedProviderError,
  sha256,
  plainObject,
  requiredString,
  requiredHash,
  resolveRegularFile,
  readPinnedArtifact,
  sourceDescriptor,
  rounded,
  matchedObservation,
  createKoelnKfzOsmMatchedProvider,
});
