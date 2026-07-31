#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INPUT_SCHEMA_VERSION = 1;
const INPUT_TYPE = 'koeln-kfz-official-geometry-join';
const OUTPUT_SCHEMA_VERSION = 1;
const OUTPUT_TYPE = 'koeln-kfz-directed-osm-line-match';
const PRODUCER_VERSION = '1.0.0';
const METERS_PER_DEGREE_LAT = 110540;
const DEFAULTS = Object.freeze({
  sampleSpacingMeters: 10,
  searchRadiusMeters: 35,
  maximumP95DistanceMeters: 25,
  maximumMeanDistanceMeters: 18,
  maximumAngleDifferenceDegrees: 35,
  minimumCoverageRatio: 0.5,
  ambiguityMarginScore: 3,
});

class KoelnKfzOsmLineMatchError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'KoelnKfzOsmLineMatchError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new KoelnKfzOsmLineMatchError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail('invalid_number', `${label} must be finite`, { value });
  return number;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) fail('invalid_number', `${label} must be positive`, { value });
  return number;
}

function ratio(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0 || number > 1) fail('invalid_number', `${label} must be between 0 and 1`, { value });
  return number;
}

function normalizeTimestamp(value, label) {
  const text = requiredString(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail('invalid_timestamp', `${label} must be an ISO timestamp`);
  return new Date(milliseconds).toISOString();
}

function resolveRegularFile(value, label) {
  const requested = path.resolve(requiredString(value, label));
  const parts = requested.split(path.sep);
  let current = path.parse(requested).root;
  for (const part of parts.slice(1)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('unsafe_file', `${label} path contains a symbolic link`, { current });
  }
  const stat = fs.statSync(requested);
  if (!stat.isFile()) fail('unsafe_file', `${label} must be a regular file`, { requested });
  return fs.realpathSync(requested);
}

function readJsonFile(value, label) {
  const file = resolveRegularFile(value, label);
  const bytes = fs.readFileSync(file);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    fail('invalid_json', `${label} must be valid UTF-8 JSON`, { cause: error.message });
  }
  return Object.freeze({ file, bytes, sha256: sha256(bytes), value: plainObject(parsed, label) });
}

function resolveOutputFile(value) {
  const requested = path.resolve(requiredString(value, 'outputFile'));
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const parent = fs.realpathSync(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('unsafe_output', 'outputFile must be a regular non-symlink file', { output });
    }
  }
  return output;
}

function writeAtomic(file, value) {
  const output = resolveOutputFile(file);
  const temporary = `${output}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return output;
}

function normalizeCoordinate(value, label) {
  let lon;
  let lat;
  if (Array.isArray(value) && value.length >= 2) {
    lon = Number(value[0]);
    lat = Number(value[1]);
  } else {
    const point = plainObject(value, label);
    lon = Number(point.lon);
    lat = Number(point.lat);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    fail('invalid_coordinate', `${label} must contain valid WGS84 lon/lat`, { value });
  }
  return Object.freeze({ lon, lat });
}

function normalizeLineString(value, label) {
  let coordinates;
  if (Array.isArray(value)) coordinates = value;
  else {
    const geometry = plainObject(value, label);
    if (geometry.type !== 'LineString') fail('invalid_geometry', `${label} must be a LineString`);
    coordinates = geometry.coordinates;
  }
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    fail('invalid_geometry', `${label} requires at least two coordinates`);
  }
  const line = coordinates.map((coordinate, index) => normalizeCoordinate(coordinate, `${label}[${index}]`));
  if (line.every((point, index) => index === 0 ||
      point.lon === line[index - 1].lon && point.lat === line[index - 1].lat)) {
    fail('invalid_geometry', `${label} has no positive-length segment`);
  }
  return Object.freeze(line);
}

function localProjection(line) {
  const reference = line[Math.floor(line.length / 2)];
  const cosine = Math.max(0.01, Math.abs(Math.cos(reference.lat * Math.PI / 180)));
  return Object.freeze({
    reference,
    project(point) {
      return Object.freeze({
        x: (point.lon - reference.lon) * 111320 * cosine,
        y: (point.lat - reference.lat) * METERS_PER_DEGREE_LAT,
      });
    },
  });
}

function projectLine(line, projection) {
  return Object.freeze(line.map(point => projection.project(point)));
}

function segmentLength(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function lineMetrics(line) {
  const cumulative = [0];
  let length = 0;
  for (let index = 0; index < line.length - 1; index += 1) {
    const segment = segmentLength(line[index], line[index + 1]);
    length += segment;
    cumulative.push(length);
  }
  if (!Number.isFinite(length) || length <= 0) fail('invalid_geometry', 'projected line has no length');
  return Object.freeze({ length, cumulative: Object.freeze(cumulative) });
}

function interpolateAt(line, metrics, distance) {
  const clamped = Math.max(0, Math.min(metrics.length, distance));
  for (let index = 0; index < line.length - 1; index += 1) {
    const start = metrics.cumulative[index];
    const end = metrics.cumulative[index + 1];
    if (clamped <= end || index === line.length - 2) {
      const length = end - start;
      const t = length > 0 ? (clamped - start) / length : 0;
      return Object.freeze({
        x: line[index].x + (line[index + 1].x - line[index].x) * t,
        y: line[index].y + (line[index + 1].y - line[index].y) * t,
      });
    }
  }
  return line[line.length - 1];
}

function sampleLine(line, spacingMeters) {
  const metrics = lineMetrics(line);
  const count = Math.max(1, Math.ceil(metrics.length / spacingMeters));
  const samples = [];
  for (let index = 0; index <= count; index += 1) {
    samples.push(interpolateAt(line, metrics, metrics.length * index / count));
  }
  return Object.freeze({ samples: Object.freeze(samples), metrics });
}

function projectPointToSegment(point, left, right) {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator > 0
    ? Math.max(0, Math.min(1, ((point.x - left.x) * dx + (point.y - left.y) * dy) / denominator))
    : 0;
  const x = left.x + dx * t;
  const y = left.y + dy * t;
  return Object.freeze({ x, y, t, distance: Math.hypot(point.x - x, point.y - y) });
}

function nearestOnLine(point, line, metrics) {
  let best = null;
  for (let index = 0; index < line.length - 1; index += 1) {
    const projected = projectPointToSegment(point, line[index], line[index + 1]);
    const along = metrics.cumulative[index] +
      projected.t * (metrics.cumulative[index + 1] - metrics.cumulative[index]);
    if (!best || projected.distance < best.distance) {
      best = Object.freeze({ ...projected, along, segmentIndex: index });
    }
  }
  return best;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function angleDegrees(left, right) {
  return Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI;
}

function angleDifference(left, right) {
  let difference = Math.abs(left - right) % 360;
  if (difference > 180) difference = 360 - difference;
  return difference;
}

function lineBoundingBox(line) {
  return Object.freeze(line.reduce((box, point) => ({
    minLon: Math.min(box.minLon, point.lon),
    minLat: Math.min(box.minLat, point.lat),
    maxLon: Math.max(box.maxLon, point.lon),
    maxLat: Math.max(box.maxLat, point.lat),
  }), { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity }));
}

function boxesWithinRadius(left, right, radiusMeters) {
  const meanLat = (left.minLat + left.maxLat + right.minLat + right.maxLat) / 4;
  const lonMeters = 111320 * Math.max(0.01, Math.abs(Math.cos(meanLat * Math.PI / 180)));
  const latGap = Math.max(0, left.minLat - right.maxLat, right.minLat - left.maxLat) * METERS_PER_DEGREE_LAT;
  const lonGap = Math.max(0, left.minLon - right.maxLon, right.minLon - left.maxLon) * lonMeters;
  return Math.hypot(latGap, lonGap) <= radiusMeters;
}

function normalizeMatcherOptions(options = {}) {
  return Object.freeze({
    sampleSpacingMeters: positiveNumber(
      options.sampleSpacingMeters ?? DEFAULTS.sampleSpacingMeters,
      'sampleSpacingMeters',
    ),
    searchRadiusMeters: positiveNumber(
      options.searchRadiusMeters ?? DEFAULTS.searchRadiusMeters,
      'searchRadiusMeters',
    ),
    maximumP95DistanceMeters: positiveNumber(
      options.maximumP95DistanceMeters ?? DEFAULTS.maximumP95DistanceMeters,
      'maximumP95DistanceMeters',
    ),
    maximumMeanDistanceMeters: positiveNumber(
      options.maximumMeanDistanceMeters ?? DEFAULTS.maximumMeanDistanceMeters,
      'maximumMeanDistanceMeters',
    ),
    maximumAngleDifferenceDegrees: positiveNumber(
      options.maximumAngleDifferenceDegrees ?? DEFAULTS.maximumAngleDifferenceDegrees,
      'maximumAngleDifferenceDegrees',
    ),
    minimumCoverageRatio: ratio(
      options.minimumCoverageRatio ?? DEFAULTS.minimumCoverageRatio,
      'minimumCoverageRatio',
    ),
    ambiguityMarginScore: positiveNumber(
      options.ambiguityMarginScore ?? DEFAULTS.ambiguityMarginScore,
      'ambiguityMarginScore',
    ),
  });
}

function candidateMetrics(officialLine, osmLine, matcherOptions) {
  const projection = localProjection(officialLine);
  const official = projectLine(officialLine, projection);
  const candidate = projectLine(osmLine, projection);
  const officialSampled = sampleLine(official, matcherOptions.sampleSpacingMeters);
  const candidateLineMetrics = lineMetrics(candidate);
  const projections = officialSampled.samples.map(sample =>
    nearestOnLine(sample, candidate, candidateLineMetrics));
  const distances = projections.map(projected => projected.distance);
  const meanDistanceMeters = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  const p95DistanceMeters = percentile(distances, 0.95);
  const maximumDistanceMeters = Math.max(...distances);
  const start = projections[0];
  const end = projections[projections.length - 1];
  const progression = end.along - start.along;
  const coverageRatio = Math.min(1, Math.abs(progression) / officialSampled.metrics.length);
  const officialAngle = angleDegrees(official[0], official[official.length - 1]);
  const projectedAngle = angleDegrees(start, end);
  const angleDifferenceDegrees = angleDifference(officialAngle, projectedAngle);
  const directionRelation = progression >= 0 ? 'same' : 'reverse';
  const score = p95DistanceMeters + meanDistanceMeters * 0.5 +
    angleDifferenceDegrees * 0.35 +
    Math.max(0, matcherOptions.minimumCoverageRatio - coverageRatio) * 100;
  const accepted = p95DistanceMeters <= matcherOptions.maximumP95DistanceMeters &&
    meanDistanceMeters <= matcherOptions.maximumMeanDistanceMeters &&
    angleDifferenceDegrees <= matcherOptions.maximumAngleDifferenceDegrees &&
    coverageRatio >= matcherOptions.minimumCoverageRatio;
  return Object.freeze({
    accepted,
    score,
    meanDistanceMeters,
    p95DistanceMeters,
    maximumDistanceMeters,
    angleDifferenceDegrees,
    coverageRatio,
    directionRelation,
    matchedAlongMeters: Object.freeze({ start: start.along, end: end.along }),
  });
}

function normalizeOsmDataset(value) {
  const osm = plainObject(value, 'OSM dataset');
  const ways = plainObject(osm.ways, 'OSM dataset.ways');
  const geometries = plainObject(osm.wayGeometries, 'OSM dataset.wayGeometries');
  const wayIds = Object.keys(ways).sort((left, right) => String(left).localeCompare(String(right), 'en'));
  const geometryIds = Object.keys(geometries).sort((left, right) => String(left).localeCompare(String(right), 'en'));
  if (JSON.stringify(wayIds) !== JSON.stringify(geometryIds)) {
    fail('osm_geometry_coverage_mismatch', 'OSM ways and wayGeometries must have identical IDs', {
      wayIds,
      geometryIds,
    });
  }
  const candidates = wayIds.map(id => {
    const way = plainObject(ways[id], `ways.${id}`);
    const geometry = normalizeLineString(geometries[id], `wayGeometries.${id}`);
    return Object.freeze({
      wayId: requiredString(String(id), 'OSM way ID'),
      highway: way.highway != null ? String(way.highway) : null,
      name: way.name != null ? String(way.name) : null,
      geometry,
      boundingBox: lineBoundingBox(geometry),
    });
  });
  if (!candidates.length) fail('empty_osm_dataset', 'OSM dataset contains no ways');
  return Object.freeze({ osm, candidates: Object.freeze(candidates) });
}

function directedIdentity(observation, index) {
  const value = plainObject(observation, `observations[${index}]`);
  const official = plainObject(value.officialGeometry, `observations[${index}].officialGeometry`);
  const segment = requiredString(official.segment, 'official segment');
  const fromNode = requiredString(official.fromNode, 'official fromNode');
  const toNode = requiredString(official.toNode, 'official toNode');
  const directionCode = requiredString(official.directionCode, 'official directionCode');
  if (!['forward', 'reverse'].includes(directionCode)) {
    fail('invalid_direction', 'official directionCode must be forward or reverse', { directionCode });
  }
  return Object.freeze({
    key: `${segment}:${fromNode}->${toNode}`,
    segment,
    fromNode,
    toNode,
    directionCode,
    geometry: normalizeLineString(value.geometry, `observations[${index}].geometry`),
  });
}

function normalizeTrafficArtifact(value) {
  const artifact = plainObject(value, 'traffic artifact');
  if (artifact.schemaVersion !== INPUT_SCHEMA_VERSION || artifact.type !== INPUT_TYPE) {
    fail('unsupported_traffic_artifact', `traffic artifact must be ${INPUT_TYPE} v${INPUT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(artifact.observations) || artifact.observations.length === 0) {
    fail('empty_observations', 'traffic artifact contains no observations');
  }
  const groups = new Map();
  artifact.observations.forEach((observation, index) => {
    const identity = directedIdentity(observation, index);
    const geometryFingerprint = sha256(Buffer.from(canonicalJson(identity.geometry)));
    const current = groups.get(identity.key);
    if (current && current.geometryFingerprint !== geometryFingerprint) {
      fail('directed_geometry_drift', 'one directed official identity carries different geometries', {
        key: identity.key,
      });
    }
    if (current && (current.directionCode !== identity.directionCode ||
        current.segment !== identity.segment || current.fromNode !== identity.fromNode ||
        current.toNode !== identity.toNode)) {
      fail('directed_identity_drift', 'directed identity metadata differs across observations', {
        key: identity.key,
      });
    }
    if (current) current.observationIndexes.push(index);
    else groups.set(identity.key, {
      ...identity,
      geometryFingerprint,
      observationIndexes: [index],
    });
  });
  return Object.freeze({ artifact, groups });
}

function matchDirectedGeometry(group, osmCandidates, matcherOptions) {
  const officialBox = lineBoundingBox(group.geometry);
  const candidates = [];
  for (const osm of osmCandidates) {
    if (!boxesWithinRadius(officialBox, osm.boundingBox, matcherOptions.searchRadiusMeters)) continue;
    const metrics = candidateMetrics(group.geometry, osm.geometry, matcherOptions);
    candidates.push(Object.freeze({
      wayId: osm.wayId,
      highway: osm.highway,
      name: osm.name,
      ...metrics,
    }));
  }
  candidates.sort((left, right) => left.score - right.score || left.wayId.localeCompare(right.wayId, 'en'));
  const accepted = candidates.filter(candidate => candidate.accepted);
  if (!accepted.length) {
    return Object.freeze({
      status: 'unmatched',
      reasonCode: candidates.length ? 'threshold_not_met' : 'no_spatial_candidates',
      candidateCount: candidates.length,
      candidates: Object.freeze(candidates.slice(0, 5)),
    });
  }
  const best = accepted[0];
  const second = accepted[1] || null;
  const margin = second ? second.score - best.score : null;
  if (second && margin < matcherOptions.ambiguityMarginScore) {
    return Object.freeze({
      status: 'ambiguous',
      reasonCode: 'score_margin_too_small',
      candidateCount: candidates.length,
      acceptedCandidateCount: accepted.length,
      scoreMargin: margin,
      candidates: Object.freeze(accepted.slice(0, 5)),
    });
  }
  const quality = best.p95DistanceMeters <= 5 && best.angleDifferenceDegrees <= 10 &&
      (margin == null || margin >= 8)
    ? 'high'
    : best.p95DistanceMeters <= 12 && best.angleDifferenceDegrees <= 20 &&
      (margin == null || margin >= 5)
      ? 'medium'
      : 'low';
  return Object.freeze({
    status: 'matched',
    wayId: best.wayId,
    highway: best.highway,
    name: best.name,
    directionRelation: best.directionRelation,
    matchQuality: quality,
    score: best.score,
    scoreMargin: margin,
    meanDistanceMeters: best.meanDistanceMeters,
    p95DistanceMeters: best.p95DistanceMeters,
    maximumDistanceMeters: best.maximumDistanceMeters,
    angleDifferenceDegrees: best.angleDifferenceDegrees,
    coverageRatio: best.coverageRatio,
    matchedAlongMeters: best.matchedAlongMeters,
    candidateCount: candidates.length,
    acceptedCandidateCount: accepted.length,
  });
}

function directionPairConflicts(groups, matches) {
  const bySegment = new Map();
  for (const group of groups.values()) {
    if (!bySegment.has(group.segment)) bySegment.set(group.segment, []);
    bySegment.get(group.segment).push(group.key);
  }
  const conflicts = [];
  for (const [segment, keys] of bySegment) {
    const matched = keys.map(key => ({ key, match: matches.get(key) }))
      .filter(entry => entry.match.status === 'matched');
    const wayIds = [...new Set(matched.map(entry => entry.match.wayId))];
    if (matched.length > 1 && wayIds.length > 1) {
      conflicts.push(Object.freeze({
        type: 'direction_pair_way_mismatch',
        segment,
        mappings: Object.freeze(matched.map(entry => Object.freeze({
          directedKey: entry.key,
          wayId: entry.match.wayId,
          directionRelation: entry.match.directionRelation,
        }))),
      }));
    }
  }
  return Object.freeze(conflicts);
}

function sharedWayMappings(groups, matches) {
  const byWay = new Map();
  for (const group of groups.values()) {
    const match = matches.get(group.key);
    if (match.status !== 'matched') continue;
    if (!byWay.has(match.wayId)) byWay.set(match.wayId, []);
    byWay.get(match.wayId).push(group.key);
  }
  return Object.freeze([...byWay.entries()]
    .filter(([, keys]) => new Set(keys.map(key => groups.get(key).segment)).size > 1)
    .map(([wayId, keys]) => Object.freeze({ wayId, directedKeys: Object.freeze([...keys].sort()) }))
    .sort((left, right) => left.wayId.localeCompare(right.wayId, 'en')));
}

function buildMatchedArtifact(trafficInput, osmInput, options = {}) {
  const matcherOptions = normalizeMatcherOptions(options);
  const traffic = normalizeTrafficArtifact(trafficInput.value);
  const osm = normalizeOsmDataset(osmInput.value);
  const matches = new Map();
  for (const [key, group] of traffic.groups) {
    matches.set(key, matchDirectedGeometry(group, osm.candidates, matcherOptions));
  }
  const observations = traffic.artifact.observations.map((observation, index) => {
    const identity = directedIdentity(observation, index);
    const match = matches.get(identity.key);
    return Object.freeze({
      ...observation,
      osmMatch: match,
      qualityNotes: Object.freeze([
        ...(Array.isArray(observation.qualityNotes) ? observation.qualityNotes : []),
        match.status === 'matched'
          ? `Gerichtete amtliche Liniengeometrie auf OSM-Way ${match.wayId} abgebildet (${match.matchQuality}).`
          : match.status === 'ambiguous'
            ? 'OSM-Zuordnung ist mehrdeutig und wird nicht als Way-Match verwendet.'
            : 'Keine OSM-Zuordnung innerhalb der deklarierten Distanz-/Richtungsschwellen.',
      ]),
    });
  });
  const groupMatches = Object.freeze([...traffic.groups.keys()].sort().map(key => Object.freeze({
    directedKey: key,
    observationCount: traffic.groups.get(key).observationIndexes.length,
    geometrySha256: traffic.groups.get(key).geometryFingerprint,
    match: matches.get(key),
  })));
  const matchedGroups = groupMatches.filter(entry => entry.match.status === 'matched').length;
  const ambiguousGroups = groupMatches.filter(entry => entry.match.status === 'ambiguous').length;
  const unmatchedGroups = groupMatches.filter(entry => entry.match.status === 'unmatched').length;
  const matchedObservations = observations.filter(value => value.osmMatch.status === 'matched').length;
  const ambiguousObservations = observations.filter(value => value.osmMatch.status === 'ambiguous').length;
  const unmatchedObservations = observations.filter(value => value.osmMatch.status === 'unmatched').length;
  const conflicts = directionPairConflicts(traffic.groups, matches);
  const sharedMappings = sharedWayMappings(traffic.groups, matches);
  const generatedAt = normalizeTimestamp(options.generatedAt, 'generatedAt');
  const artifact = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    type: OUTPUT_TYPE,
    producerVersion: PRODUCER_VERSION,
    generatedAt,
    matcher: Object.freeze({
      algorithm: 'directed-sampled-line-to-osm-v1',
      parameters: matcherOptions,
      parameterFingerprint: sha256(Buffer.from(canonicalJson(matcherOptions))),
    }),
    sources: Object.freeze({
      traffic: Object.freeze({
        fileName: path.basename(trafficInput.file),
        sha256: trafficInput.sha256,
        source: traffic.artifact.source,
      }),
      osm: Object.freeze({
        fileName: path.basename(osmInput.file),
        sha256: osmInput.sha256,
        wayCount: osm.candidates.length,
      }),
    }),
    coverage: Object.freeze({
      directedGeometryGroups: groupMatches.length,
      matchedGroups,
      ambiguousGroups,
      unmatchedGroups,
      observations: observations.length,
      matchedObservations,
      ambiguousObservations,
      unmatchedObservations,
      directionPairConflicts: conflicts.length,
      sharedWayMappings: sharedMappings.length,
    }),
    directedMatches: groupMatches,
    observations: Object.freeze(observations),
    conflicts,
    sharedWayMappings: sharedMappings,
    truthBoundary: Object.freeze({
      officialGeometryPreviouslyValidated: true,
      directionAwareOsmMatchingPerformed: true,
      trafficValuesChanged: false,
      ambiguousMatchesPromoted: false,
      accidentToWayMatchingPerformed: false,
      laneLevelAssignmentClaimed: false,
    }),
  };
  artifact.artifactFingerprint = sha256(Buffer.from(canonicalJson(artifact)));
  return Object.freeze(artifact);
}

function parseArgs(argv) {
  const options = { json: false };
  const names = new Map([
    ['--traffic', 'trafficFile'],
    ['--osm', 'osmFile'],
    ['--output', 'outputFile'],
    ['--generated-at', 'generatedAt'],
    ['--sample-spacing', 'sampleSpacingMeters'],
    ['--search-radius', 'searchRadiusMeters'],
    ['--max-p95-distance', 'maximumP95DistanceMeters'],
    ['--max-mean-distance', 'maximumMeanDistanceMeters'],
    ['--max-angle', 'maximumAngleDifferenceDegrees'],
    ['--min-coverage', 'minimumCoverageRatio'],
    ['--ambiguity-margin', 'ambiguityMarginScore'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (names.has(argument)) {
      const field = names.get(argument);
      const value = argv[++index];
      options[field] = /File$/.test(field) || field === 'generatedAt' ? value : Number(value);
    } else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/producers/koeln_kfz_osm_line_match_producer.js ' +
    '--traffic <official-geometry-join.json> --osm <osm_koeln.json> ' +
    '--generated-at <ISO> --output <matched.json> [options]\n' +
    'Options: --sample-spacing <m> --search-radius <m> --max-p95-distance <m> ' +
    '--max-mean-distance <m> --max-angle <degrees> --min-coverage <0..1> ' +
    '--ambiguity-margin <score> --json\n',
  );
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  for (const field of ['trafficFile', 'osmFile', 'outputFile', 'generatedAt']) {
    if (!options[field]) fail('missing_argument', `${field} is required`);
  }
  const trafficInput = readJsonFile(options.trafficFile, 'trafficFile');
  const osmInput = readJsonFile(options.osmFile, 'osmFile');
  const artifact = buildMatchedArtifact(trafficInput, osmInput, options);
  const outputFile = writeAtomic(options.outputFile, artifact);
  const result = Object.freeze({
    outputFile,
    outputSha256: sha256(fs.readFileSync(outputFile)),
    coverage: artifact.coverage,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(
    `[koeln-kfz-osm-match] ${artifact.coverage.matchedGroups}/${artifact.coverage.directedGeometryGroups} ` +
    `directed groups matched → ${outputFile}\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  INPUT_SCHEMA_VERSION,
  INPUT_TYPE,
  OUTPUT_SCHEMA_VERSION,
  OUTPUT_TYPE,
  PRODUCER_VERSION,
  DEFAULTS,
  KoelnKfzOsmLineMatchError,
  sha256,
  canonicalJson,
  plainObject,
  requiredString,
  finiteNumber,
  positiveNumber,
  ratio,
  normalizeTimestamp,
  resolveRegularFile,
  readJsonFile,
  resolveOutputFile,
  writeAtomic,
  normalizeCoordinate,
  normalizeLineString,
  localProjection,
  projectLine,
  segmentLength,
  lineMetrics,
  interpolateAt,
  sampleLine,
  projectPointToSegment,
  nearestOnLine,
  percentile,
  angleDegrees,
  angleDifference,
  lineBoundingBox,
  boxesWithinRadius,
  normalizeMatcherOptions,
  candidateMetrics,
  normalizeOsmDataset,
  directedIdentity,
  normalizeTrafficArtifact,
  matchDirectedGeometry,
  directionPairConflicts,
  sharedWayMappings,
  buildMatchedArtifact,
  parseArgs,
  printHelp,
  main,
});
