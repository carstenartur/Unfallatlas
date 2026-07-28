#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { slugify } = require('./lib/static-data-validation');

function readJsonArtifact(logicalPath) {
  const raw = logicalPath;
  const gz = `${logicalPath}.gz`;
  if (fs.existsSync(raw)) return { value: JSON.parse(fs.readFileSync(raw, 'utf8')), file: raw, gzip: false };
  if (fs.existsSync(gz)) {
    return {
      value: JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8')),
      file: gz,
      gzip: true,
    };
  }
  throw new Error(`Missing JSON artifact: ${logicalPath}[.gz]`);
}

function writeJsonArtifact(artifact) {
  const text = Buffer.from(JSON.stringify(artifact.value));
  if (artifact.gzip) {
    fs.writeFileSync(artifact.file, zlib.gzipSync(text, { level: 9, mtime: 0 }));
  } else {
    fs.writeFileSync(artifact.file, text);
  }
}

function normalizeProxyRow(row, observation) {
  if (!row || typeof row !== 'object' || !observation) return false;
  delete row.traffic_volume_value;
  delete row.traffic_volume_unit;
  delete row.traffic_volume_year;
  row.traffic_measurement_type = 'proxy';
  row.traffic_proxy_class = observation.proxyClass;
  row.traffic_volume_source = 'OSM-highway-class-proxy';
  row.traffic_volume_confidence = observation.confidence || 'low';
  row.traffic_proxy_basis = `highway=${observation.highwayClass}`;
  return true;
}

function matchedWayId(properties) {
  const props = properties || {};
  for (const key of ['matched_way_id', 'matchedWayId', 'osm_way_id', 'way_id']) {
    if (props[key] != null && String(props[key]).trim()) return String(props[key]);
  }
  return null;
}

function normalizeFeatureCollection(geojson, observations) {
  let count = 0;
  for (const feature of Array.isArray(geojson && geojson.features) ? geojson.features : []) {
    const properties = feature && feature.properties;
    const wayId = matchedWayId(properties);
    const observation = wayId && observations[wayId];
    if (!properties || !observation) continue;
    delete properties.traffic_volume_value;
    delete properties.traffic_volume_unit;
    delete properties.traffic_volume_year;
    properties.traffic_measurement_type = 'proxy';
    properties.traffic_proxy_class = observation.proxyClass;
    properties.traffic_volume_source = 'OSM-highway-class-proxy';
    properties.traffic_volume_confidence = observation.confidence || 'low';
    properties.traffic_proxy_basis = `highway=${observation.highwayClass}`;
    count += 1;
  }
  return count;
}

function normalizeWaysPayload(payload, observations) {
  let count = 0;
  const ways = payload && payload.ways && typeof payload.ways === 'object' ? payload.ways : {};
  for (const [wayId, row] of Object.entries(ways)) {
    if (normalizeProxyRow(row, observations[wayId])) count += 1;
  }
  return count;
}

function normalizeTiles(outputDir, slug, observations) {
  const base = path.join(outputDir, 'ctxtiles', slug);
  const indexArtifact = readJsonArtifact(path.join(base, 'index.json'));
  let rows = 0;
  for (const tile of Array.isArray(indexArtifact.value.tiles) ? indexArtifact.value.tiles : []) {
    const tileArtifact = readJsonArtifact(path.join(base, String(tile.x), `${tile.y}.json`));
    rows += normalizeWaysPayload(tileArtifact.value, observations);
    writeJsonArtifact(tileArtifact);
  }
  return { rows, index: indexArtifact.value };
}

function applyQualitativeTrafficProxy(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || path.join(__dirname, '..'));
  const city = String(opts.city || '').trim();
  if (!city) throw new Error('--city is required');
  const slug = slugify(city);
  const outputDir = path.resolve(root, opts.outputDir || 'out');
  const trafficDir = path.resolve(root, opts.trafficDir || '.enrichment-cache/traffic');

  const provider = readJsonArtifact(path.join(trafficDir, `traffic_${slug}.json`)).value;
  if (provider.measurementType !== 'proxy') {
    throw new Error(`Traffic dataset for ${slug} is not an explicit proxy dataset`);
  }
  const observations = provider.ways || {};
  for (const [wayId, observation] of Object.entries(observations)) {
    if (!observation || observation.measurementType !== 'proxy' || !observation.proxyClass) {
      throw new Error(`Invalid qualitative proxy observation for way ${wayId}`);
    }
    for (const forbidden of ['value', 'unit', 'year']) {
      if (observation[forbidden] != null) {
        throw new Error(`Proxy observation ${wayId} contains forbidden field ${forbidden}`);
      }
    }
  }

  let wayRows = 0;
  const waysLogical = path.join(outputDir, `ways_${slug}.json`);
  const waysArtifact = readJsonArtifact(waysLogical);
  if (waysArtifact.value && waysArtifact.value.ways) {
    wayRows += normalizeWaysPayload(waysArtifact.value, observations);
    writeJsonArtifact(waysArtifact);
  }
  const tileResult = normalizeTiles(outputDir, slug, observations);
  wayRows += tileResult.rows;

  const geojsonArtifact = readJsonArtifact(path.join(outputDir, `output_all_years_${slug}.geojson`));
  const featureRows = normalizeFeatureCollection(geojsonArtifact.value, observations);
  writeJsonArtifact(geojsonArtifact);

  const metaArtifact = readJsonArtifact(path.join(outputDir, `output_all_years_${slug}.enrichment.meta.json`));
  metaArtifact.value.sources = metaArtifact.value.sources || {};
  metaArtifact.value.sources.traffic = {
    source: provider.source,
    producerVersion: provider.producerVersion || provider.datasetVersion,
    datasetVersion: provider.datasetVersion,
    measurementType: 'proxy',
    semantics: 'qualitative-osm-highway-class-no-numeric-volume',
    extractDate: provider.extractDate || null,
    provenance: provider.provenance || null,
  };
  metaArtifact.value.counts = metaArtifact.value.counts || {};
  metaArtifact.value.counts.withTrafficProxy = featureRows;
  metaArtifact.value.traffic = {
    measurementType: 'proxy',
    classifiedFeatures: featureRows,
    classifiedWayRows: wayRows,
    numericValuesPresent: false,
  };
  writeJsonArtifact(metaArtifact);

  return { city, slug, featureRows, wayRows, providerWays: Object.keys(observations).length };
}

function parseArgs(argv) {
  const options = { city: null, root: null, outputDir: null, trafficDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--city') options.city = argv[++index];
    else if (argument === '--root') options.root = argv[++index];
    else if (argument === '--output-dir') options.outputDir = argv[++index];
    else if (argument === '--traffic-dir') options.trafficDir = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const result = applyQualitativeTrafficProxy(parseArgs(process.argv.slice(2)));
    process.stdout.write(`[traffic-proxy] ${result.slug}: ${result.featureRows} features, ${result.wayRows} way rows classified without numeric DTV\n`);
  } catch (error) {
    process.stderr.write(`[traffic-proxy] FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  readJsonArtifact,
  writeJsonArtifact,
  normalizeProxyRow,
  normalizeFeatureCollection,
  normalizeWaysPayload,
  applyQualitativeTrafficProxy,
  parseArgs,
};
