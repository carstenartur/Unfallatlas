#!/usr/bin/env node
'use strict';

/**
 * Produce the qualitative OpenStreetMap traffic fallback.
 *
 * The OSM `highway` tag describes a road class, not a measured traffic count.
 * Earlier versions converted that class into invented DTV values. This producer
 * now emits only an explicit qualitative proxy class. Licensed count/model
 * providers use the separate typed provider boundary in `js/ua.traffic_provider.js`.
 *
 * Output schema:
 *
 *   {
 *     schemaVersion: 2,
 *     measurementType: "proxy",
 *     source: "OSM-highway-class-proxy",
 *     datasetVersion: "2.0.0",
 *     producerVersion: "2.0.0",
 *     extractDate: "YYYY-MM-DD",
 *     ways: {
 *       "<wayId>": {
 *         measurementType: "proxy",
 *         proxyClass: "low|medium|high|very_high",
 *         highwayClass: "residential",
 *         confidence: "low"
 *       }
 *     }
 *   }
 *
 * No per-way `value`, `unit` or `year` is permitted for this proxy dataset.
 */

const fs = require('fs');
const path = require('path');

const PRODUCER_VERSION = '2.0.0';
const DEFAULT_INTER_CITY_DELAY_MS = 0;
const DEFAULT_SOURCE = 'OSM-highway-class-proxy';
const DEFAULT_CONFIDENCE = 'low';

const HIGHWAY_PROXY_CLASS = Object.freeze({
  motorway: 'very_high',
  motorway_link: 'very_high',
  trunk: 'very_high',
  trunk_link: 'very_high',
  primary: 'high',
  primary_link: 'high',
  secondary: 'high',
  secondary_link: 'high',
  tertiary: 'medium',
  tertiary_link: 'medium',
  unclassified: 'medium',
  residential: 'low',
  living_street: 'low',
  service: 'low',
  pedestrian: 'low',
  track: 'low',
});

function slugCity(name) {
  return String(name)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readCitiesTxt(repoRoot) {
  const file = path.join(repoRoot, 'cities.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function proxyClassFromHighway(highway) {
  if (highway == null) return undefined;
  return HIGHWAY_PROXY_CLASS[String(highway).toLowerCase()];
}

function buildTrafficDataset(osmWays, options) {
  const opts = options || {};
  const lookup = opts.proxyClassLookup || proxyClassFromHighway;
  const source = opts.source || DEFAULT_SOURCE;
  const dataset = {
    schemaVersion: 2,
    measurementType: 'proxy',
    source,
    datasetVersion: opts.datasetVersion || PRODUCER_VERSION,
    producerVersion: PRODUCER_VERSION,
    extractDate: opts.extractDate || new Date().toISOString().slice(0, 10),
    provenance: {
      sourceId: 'traffic.proxy.osm-highway-class',
      publisher: 'OpenStreetMap contributors',
      datasetTitle: 'OpenStreetMap highway classification',
      datasetUrl: 'https://www.openstreetmap.org/',
      licenseId: 'ODbL-1.0',
      licenseName: 'Open Data Commons Open Database License 1.0',
      licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      requiredAttribution: '© OpenStreetMap contributors',
      changedOrDerived: true,
      changeNotice: 'OSM highway classes are grouped into qualitative exposure classes; no traffic count is inferred.',
    },
    ways: {},
  };

  if (!osmWays || typeof osmWays !== 'object') return dataset;
  for (const wayId of Object.keys(osmWays)) {
    const way = osmWays[wayId] || {};
    const proxyClass = typeof lookup === 'function' ? lookup(way.highway) : undefined;
    if (!proxyClass) continue;
    dataset.ways[wayId] = {
      measurementType: 'proxy',
      proxyClass,
      highwayClass: String(way.highway),
      confidence: opts.confidence || DEFAULT_CONFIDENCE,
      qualityNotes: [
        'Qualitativer OSM-Straßenklassenproxy; kein gemessener oder modellierter Verkehrswert.',
      ],
    };
  }
  return dataset;
}

function readOsmWays(osmDir, citySlug) {
  if (!osmDir) return null;
  const file = path.join(osmDir, `osm_${citySlug}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && data.ways && typeof data.ways === 'object' ? data.ways : null;
  } catch (_) {
    return null;
  }
}

function produceCity(repoRoot, citySlug, options) {
  const opts = options || {};
  const osmDir = opts.osmDir || process.env.ENRICH_OSM_DATA_DIR || null;
  const ways = readOsmWays(osmDir, citySlug);
  if (!ways) return { citySlug, skipped: true, reason: 'no osm cache for city' };

  const outDir = opts.outDir;
  if (!outDir) throw new Error('produceCity: opts.outDir required');
  const outFile = path.join(outDir, `traffic_${citySlug}.json`);
  if (!opts.force && fs.existsSync(outFile)) {
    return { citySlug, skipped: true, reason: 'already cached', outFile };
  }

  const dataset = buildTrafficDataset(ways, {
    source: opts.source,
    datasetVersion: opts.datasetVersion,
    confidence: opts.confidence,
    extractDate: opts.extractDate,
    proxyClassLookup: opts.proxyClassLookup,
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(dataset));
  return {
    citySlug,
    skipped: false,
    counts: {
      candidateWays: Object.keys(ways).length,
      taggedWays: Object.keys(dataset.ways).length,
    },
    outFile,
  };
}

function parseArgs(argv) {
  const opts = {
    cities: [],
    outDir: process.env.ENRICH_TRAFFIC_DATA_DIR || '.enrichment-cache/traffic',
    osmDir: process.env.ENRICH_OSM_DATA_DIR || null,
    interCityDelayMs: DEFAULT_INTER_CITY_DELAY_MS,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--city') opts.cities.push(argv[++index]);
    else if (argument === '--out-dir') opts.outDir = argv[++index];
    else if (argument === '--osm-dir') opts.osmDir = argv[++index];
    else if (argument === '--delay') opts.interCityDelayMs = Number(argv[++index]);
    else if (argument === '--force') opts.force = true;
    else if (argument === '--json') opts.json = true;
    else if (argument === '--help' || argument === '-h') opts.help = true;
    else if (argument.startsWith('--')) console.warn(`[traffic-producer] unknown flag ignored: ${argument}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/producers/traffic_producer.js [options]\n\n` +
    `  --city <name>          produce only this city (repeatable)\n` +
    `  --out-dir <path>       output directory\n` +
    `  --osm-dir <path>       directory holding osm_<slug>.json\n` +
    `  --delay <ms>           delay between cities\n` +
    `  --force                replace existing city datasets\n` +
    `  --json                 emit machine-readable summary\n\n` +
    `The fallback emits qualitative OSM proxy classes only. It never emits DTV,\n` +
    `vehicles/day or another invented numeric traffic value.\n`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  const repoRoot = path.resolve(__dirname, '..', '..');
  let citySlugs = opts.cities.map(slugCity);
  if (citySlugs.length === 0) citySlugs = readCitiesTxt(repoRoot).map(slugCity);
  if (citySlugs.length === 0) {
    console.error('[traffic-producer] no cities to process');
    return 2;
  }

  const summary = { producer: 'traffic', producerVersion: PRODUCER_VERSION, cities: [] };
  let exitCode = 0;
  for (let index = 0; index < citySlugs.length; index += 1) {
    const slug = citySlugs[index];
    if (index > 0 && opts.interCityDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, opts.interCityDelayMs));
    }
    try {
      const result = produceCity(repoRoot, slug, opts);
      summary.cities.push(result);
      if (!opts.json) {
        if (result.skipped) console.log(`[traffic-producer] ${slug}: SKIP (${result.reason})`);
        else console.log(`[traffic-producer] ${slug}: ${result.counts.taggedWays}/${result.counts.candidateWays} ways classified → ${result.outFile}`);
      }
    } catch (error) {
      exitCode = 1;
      const entry = { citySlug: slug, skipped: true, reason: `error: ${error.message}` };
      summary.cities.push(entry);
      if (!opts.json) console.error(`[traffic-producer] ${slug}: ERROR ${error.message}`);
    }
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    console.error('[traffic-producer] fatal:', error);
    process.exit(1);
  });
}

module.exports = {
  PRODUCER_VERSION,
  DEFAULT_SOURCE,
  DEFAULT_CONFIDENCE,
  HIGHWAY_PROXY_CLASS,
  slugCity,
  readCitiesTxt,
  proxyClassFromHighway,
  buildTrafficDataset,
  readOsmWays,
  produceCity,
  parseArgs,
  main,
};
