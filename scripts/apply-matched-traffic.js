#!/usr/bin/env node
'use strict';

// Applies an already reviewed, externally pinned match artifact. Geometry joining
// and matching remain in the existing producer; no nearest-road rematching here.
const path = require('path');
const fs = require('fs');
const zlib = require('node:zlib');
const matcher = require('./producers/koeln_kfz_osm_line_match_producer');
const { encodeGeometry, douglasPeucker, DEFAULT_GEOM_TOLERANCE_M } = require('./enrich_geojson');
const { resolveRegularFile, requiredHash, sha256 } = require('./providers/koeln_kfz_osm_matched_provider');
const traffic = require('../js/ua.traffic_provider');
const { createKoelnKfzOsmMatchedProvider } = require('./providers/koeln_kfz_osm_matched_provider');
const { slugify } = require('./lib/static-data-validation');
const { readJsonArtifact, writeJsonArtifact } = require('./apply-qualitative-traffic-proxy');

function selectByWay(observations, referenceYear) {
  const grouped = new Map();
  for (const observation of observations) {
    if (!observation.wayId || observation.mode !== 'motor_vehicle') continue;
    if (!grouped.has(observation.wayId)) grouped.set(observation.wayId, []);
    grouped.get(observation.wayId).push(observation);
  }
  return new Map([...grouped].map(([wayId, rows]) => [wayId, {
    observations: rows,
    referenceYear,
    evidence: traffic.selectTrafficEvidence(rows.map(observation => ({ observation, wayId,
      distanceMeters: observation.match ? observation.match.meanDistanceMeters : null,
      matchQuality: observation.match ? observation.match.matchQuality : null,
      matchMethod: observation.match ? observation.match.matchMethod : 'explicit-way-id',
    })), { referenceYear, mode: 'motor_vehicle' }),
  }]));
}

function applyRow(row, selection) {
  if (!row || !selection || !selection.evidence.observation) return false;
  const referenceYear = selection.referenceYear == null ? new Date().getUTCFullYear() : selection.referenceYear;
  let evidence = selection.evidence;
  const observations = [...selection.observations];
  if (traffic.hasUsableTypedEvidence(row, { referenceYear, mode: 'motor_vehicle' })) {
    const previous = row.traffic_evidence.observation;
    const current = evidence.observation;
    // The same pinned observation carries the current provider's presentation metadata.
    if (previous.sourceId !== current.sourceId || previous.observationId !== current.observationId ||
        previous.source.contentHash !== current.source.contentHash) {
      evidence = traffic.selectTrafficEvidence([row.traffic_evidence, evidence], { referenceYear, mode: 'motor_vehicle' });
    }
    for (const raw of row.traffic_observations || [row.traffic_evidence.observation]) {
      try {
        const normalized = traffic.normalizeObservation(raw, traffic.normalizeDescriptor(raw.source), 0);
        if (!observations.some(item => item.sourceId === normalized.sourceId && item.observationId === normalized.observationId)) observations.push(normalized);
      } catch (_) { /* invalid retained alternatives cannot become source evidence */ }
    }
  }
  const observation = evidence.observation;
  if (selection.artifact && observation.sourceId === selection.evidence.observation.sourceId &&
      observation.source.contentHash === selection.evidence.observation.source.contentHash) {
    row.traffic_artifact = selection.artifact;
  }
  delete row.traffic_proxy_class;
  delete row.traffic_proxy_basis;
  Object.assign(row, {
    traffic_measurement_type: observation.measurementType,
    traffic_volume_value: observation.value,
    traffic_volume_unit: observation.unit,
    traffic_volume_year: observation.year,
    traffic_volume_source: observation.sourceId,
    traffic_volume_confidence: evidence.matchQuality,
    traffic_evidence: evidence,
    // Preserve distinct years/directions rather than silently summing or losing
    // the other direction when the selector chooses one displayed observation.
    traffic_observations: observations,
  });
  return true;
}

// Validate the exact ordered public geometry against the transitively pinned
// matching input. Public simplification is explicit, deterministic and bound by
// that input's SHA; it never changes the raw geometry used for match quality.
function verifyTargetGeometry(provider, options, payloads, geojson, selected) {
  const source = provider.matchedArtifact.sources && provider.matchedArtifact.sources.osm;
  if (!source || !source.fileName || path.basename(source.fileName) !== source.fileName) throw new Error('Missing safe OSM matching input filename');
  const inputFile = resolveRegularFile(options.osmInputFile || path.join(path.dirname(options.artifactFile), source.fileName), 'OSM matching input');
  const expectedHash = requiredHash(source.sha256, 'OSM matching input SHA-256');
  const bytes = fs.readFileSync(inputFile);
  if (sha256(bytes) !== expectedHash) throw new Error('OSM matching input hash mismatch');
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const representation = input.publicGeometry || { format: 'ua-encodeGeometry-v1', method: 'none', toleranceMeters: 0 };
  if (representation.format !== 'ua-encodeGeometry-v1' ||
      !((representation.method === 'none' && representation.toleranceMeters === 0) ||
        (representation.method === 'douglas-peucker' && representation.toleranceMeters === DEFAULT_GEOM_TOLERANCE_M))) {
    throw new Error('Unsupported pinned public geometry representation');
  }
  const applicable = id => selected.has(String(id)) && selected.get(String(id)).evidence.observation;
  const used = new Set();
  const current = new Map();
  for (const payload of payloads) {
    for (const id of Object.keys(payload.ways || {})) if (applicable(id)) used.add(id);
    for (const [id, geometry] of Object.entries(payload.geometries || {})) {
      if (!applicable(id)) continue;
      if (current.has(id) && JSON.stringify(current.get(id)) !== JSON.stringify(geometry)) throw new Error(`Conflicting current geometry for way ${id}`);
      current.set(id, geometry);
    }
  }
  for (const feature of geojson.features || []) {
    const id = feature && feature.properties && feature.properties.matched_way_id;
    if (id != null && applicable(id)) used.add(String(id));
  }
  for (const id of used) {
    if (!current.has(id) || !input.wayGeometries || !input.wayGeometries[id]) throw new Error(`Missing current or pinned geometry for way ${id}`);
    if (!matcher.isMotorRoad(input.ways?.[id]?.highway)) {
      throw new Error(`Köln motor count cannot be assigned to road class of way ${id}; recompute matching`);
    }
    const raw = matcher.normalizeLineString(input.wayGeometries[id], `OSM matching input.wayGeometries.${id}`);
    const expected = encodeGeometry(representation.toleranceMeters > 0 ? douglasPeucker(raw, representation.toleranceMeters) : raw);
    if (JSON.stringify(current.get(id)) !== JSON.stringify(expected)) throw new Error(`Ordered geometry mismatch for way ${id}; recompute matching for the current snapshot`);
  }
  return { osmInputSha256: expectedHash, publicGeometry: representation, validatedWayCount: used.size,
    orderedGeometrySha256: sha256(Buffer.from(matcher.canonicalJson([...used].sort().map(id => [id, current.get(id)])))) };
}

async function applyMatchedTraffic(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || path.join(__dirname, '..'));
  const city = String(opts.city || '').trim();
  if (slugify(city) !== 'koeln') throw new Error('Pinned Köln traffic artifact may only be applied to Köln');
  const referenceYear = opts.referenceYear == null ? new Date().getUTCFullYear() : Number(opts.referenceYear);
  if (!Number.isInteger(referenceYear)) throw new Error('referenceYear must be an integer');
  const provider = createKoelnKfzOsmMatchedProvider(opts);
  const registry = traffic.createRegistry();
  registry.register(provider);
  const observations = await registry.collect({ city });
  const selected = selectByWay(observations, referenceYear);
  for (const selection of selected.values()) selection.artifact = provider.matchedArtifact;
  const output = path.resolve(root, opts.outputDir || 'out');
  const read = file => readJsonArtifact(path.join(output, file));
  const ways = read('ways_koeln.json');
  const index = read('ctxtiles/koeln/index.json');
  const tiles = (index.value.tiles || []).map(tile => read(`ctxtiles/koeln/${tile.x}/${tile.y}.json`));
  const geojson = read('output_all_years_koeln.geojson');
  const meta = read('output_all_years_koeln.enrichment.meta.json');
  const geometryBinding = verifyTargetGeometry(provider, opts, [ways.value, ...tiles.map(tile => tile.value)], geojson.value, selected);
  let wayRows = 0;
  for (const artifact of [ways, ...tiles]) {
    for (const [wayId, row] of Object.entries(artifact.value.ways || {})) {
      if (applyRow(row, selected.get(String(wayId)))) wayRows += 1;
    }
  }
  let features = 0;
  for (const feature of geojson.value.features || []) {
    const props = feature && feature.properties;
    if (props && applyRow(props, selected.get(String(props.matched_way_id)))) features += 1;
  }
  meta.value.sources = meta.value.sources || {};
  meta.value.sources.trafficMatched = {
    source: provider.descriptor, matchedArtifact: provider.matchedArtifact, coverage: provider.coverage,
    referenceYear, mode: 'motor_vehicle', geometryBinding, semantics: 'directional-count-selection-no-summation',
  };
  const proxyFeatures = (geojson.value.features || []).filter(feature => feature.properties &&
    feature.properties.traffic_measurement_type === 'proxy' && feature.properties.traffic_proxy_class).length;
  meta.value.counts = { ...(meta.value.counts || {}), withTrafficProxy: proxyFeatures, withTypedTraffic: features };
  const featureTypes = {};
  const wayTypes = {};
  for (const feature of geojson.value.features || []) {
    const type = feature.properties && feature.properties.traffic_measurement_type;
    if (type) featureTypes[type] = (featureTypes[type] || 0) + 1;
  }
  const observedWays = new Set();
  let classifiedWayRows = 0;
  for (const artifact of [ways, ...tiles]) {
    for (const [id, row] of Object.entries(artifact.value.ways || {})) {
      const type = row.traffic_measurement_type;
      if (type === 'proxy') classifiedWayRows++;
      if (type && !observedWays.has(id)) {
        observedWays.add(id);
        wayTypes[type] = (wayTypes[type] || 0) + 1;
      }
    }
  }
  const types = [...new Set([...Object.keys(featureTypes), ...Object.keys(wayTypes)])];
  meta.value.traffic = { ...(meta.value.traffic || {}), typedFeatures: features, typedWayRows: wayRows,
    featureTypes, uniqueWayTypes: wayTypes,
    classifiedFeatures: proxyFeatures, classifiedWayRows, uniqueMatchedWays: [...selected.values()].filter(row => row.evidence.observation).length,
    referenceYear, measurementType: types.length > 1 ? 'mixed' : types[0] || 'proxy',
    numericValuesPresent: features > 0 || wayRows > 0 };
  for (const artifact of [ways, ...tiles, geojson, meta]) writeJsonArtifact(artifact);
  for (const [position, tile] of tiles.entries()) {
    index.value.tiles[position].bytes = tile.gzip
      ? fs.statSync(tile.file).size
      : zlib.gzipSync(fs.readFileSync(tile.file), {level: 9}).length;
  }
  writeJsonArtifact(index);
  return { city, features, wayRows, publishedObservations: observations.length };
}

function parseArgs(argv) {
  const names = { '--city': 'city', '--root': 'root', '--output-dir': 'outputDir', '--artifact': 'artifactFile',
    '--sha256': 'expectedArtifactSha256', '--reference-year': 'referenceYear', '--osm-input': 'osmInputFile' };
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!names[argv[i]] || argv[i + 1] == null) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    options[names[argv[i]]] = argv[++i];
  }
  return options;
}
if (require.main === module) applyMatchedTraffic(parseArgs(process.argv.slice(2))).then(
  result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
module.exports = { selectByWay, applyRow, verifyTargetGeometry, applyMatchedTraffic, parseArgs };
