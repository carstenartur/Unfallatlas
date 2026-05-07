#!/usr/bin/env node
'use strict';

/**
 * scripts/producers/traffic_producer.js
 *
 * Producer for the traffic-volume enrichment stage. Generates the
 * `traffic_<city>.json` files that
 * `scripts/enrich_geojson.js`'s `loadTrafficProvider` consumes (see
 * `docs/enrichment.md`).
 *
 * Why a proxy?
 * ------------
 * Real traffic counts in Germany come from a patchwork of sources
 * (BASt SDV for Bundes-/Autobahnen, city-specific Zählstellen, …)
 * with restrictive redistribution clauses that prevent us from
 * baking the raw values into the public Pages site. To still get a
 * useful traffic-volume signal across every road in every city, this
 * producer derives a **DTV proxy** from each matched OSM way's
 * `highway` tag, using the published HBS / HVS class typicals as the
 * estimate.
 *
 * The result is a coarse but transparent classifier — every accident
 * matched to a residential street ends up with `low`, every accident
 * on a motorway ends up with `very_high`, and the source field
 * (`source: "OSM-highway-proxy"`, `confidence: "low"`) makes the
 * proxy nature explicit downstream. Real licensable counts can be
 * dropped in later by a parallel producer that overwrites the
 * `traffic_<slug>.json` after this one runs.
 *
 * Output schema (consumed by `loadTrafficProvider`):
 *
 *   {
 *     source:         "OSM-highway-proxy",
 *     datasetVersion: "<producer version>",
 *     ways: { "<wayId>": { value, unit: "DTV", year, confidence } }
 *   }
 *
 * Re-running the producer is idempotent: each city overwrites its
 * own file. No network access — all data is derived locally from
 * the OSM producer's output.
 */

const fs   = require('fs');
const path = require('path');

const PRODUCER_VERSION = '1.0.0';

const DEFAULT_INTER_CITY_DELAY_MS = 0;
const DEFAULT_SOURCE = 'OSM-highway-proxy';
const DEFAULT_UNIT   = 'DTV';
const DEFAULT_CONFIDENCE = 'low';

// Typical DTV (vehicles/day) for each OSM `highway` class. The values
// are rounded order-of-magnitude estimates based on the FGSV HBS
// road-class typicals; they are deliberately *not* meant as anything
// more precise than a coarse proxy. Keeping them in one place makes
// the catalogue easy to audit and replace with regional defaults
// later.
//
// Anything not in the table maps to `undefined` and produces no
// traffic entry for that way (the enricher then leaves the
// `traffic_*` fields off the accident).
const HIGHWAY_DTV_PROXY = {
  motorway:        50_000,
  motorway_link:   25_000,
  trunk:           30_000,
  trunk_link:      15_000,
  primary:         18_000,
  primary_link:     9_000,
  secondary:        8_000,
  secondary_link:   4_000,
  tertiary:         4_000,
  tertiary_link:    2_000,
  unclassified:     1_500,
  residential:        800,
  living_street:      200,
  service:            300,
  pedestrian:         100,
  track:              100,
};

// ---------------------------------------------------------------------------
// City list / slugging — kept in sync with the other producers.
// ---------------------------------------------------------------------------

function slugCity(name) {
  return String(name)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readCitiesTxt(repoRoot) {
  const p = path.join(repoRoot, 'cities.txt');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Look up the typical DTV for an OSM highway class. Returns
 * undefined when the tag is missing or unknown — the enricher then
 * leaves the `traffic_*` fields off the accident.
 */
function dtvFromHighway(highway) {
  if (highway == null) return undefined;
  const v = HIGHWAY_DTV_PROXY[String(highway).toLowerCase()];
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Assemble the on-disk payload for one city given the OSM producer's
 * (already loaded) `ways` table.
 *
 * @param {object} osmWays   ways table from `osm_<slug>.json`
 * @param {object} [opts]
 *   - source           provenance label (default: OSM-highway-proxy)
 *   - datasetVersion   provider version label (default: producer version)
 *   - unit             traffic-volume unit (default: DTV)
 *   - confidence       confidence label (default: low)
 *   - year             reference year (default: current calendar year)
 *   - extractDate      ISO date for provenance (default: today)
 *   - dtvLookup        override the highway → DTV table (mainly for tests)
 */
function buildTrafficDataset(osmWays, opts) {
  const o = opts || {};
  const lookup = o.dtvLookup || dtvFromHighway;
  const year   = Number.isFinite(o.year) ? o.year : new Date().getUTCFullYear();
  const out = {
    source:         o.source         || DEFAULT_SOURCE,
    datasetVersion: o.datasetVersion || PRODUCER_VERSION,
    extractDate:    o.extractDate    || new Date().toISOString().slice(0, 10),
    ways:           {},
  };
  if (!osmWays || typeof osmWays !== 'object') return out;
  for (const wayId of Object.keys(osmWays)) {
    const w = osmWays[wayId] || {};
    const dtv = typeof lookup === 'function' ? lookup(w.highway) : undefined;
    if (!Number.isFinite(dtv)) continue;
    out.ways[wayId] = {
      value:      dtv,
      unit:       o.unit       || DEFAULT_UNIT,
      year,
      confidence: o.confidence || DEFAULT_CONFIDENCE,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-city produce
// ---------------------------------------------------------------------------

function readOsmWays(osmDir, citySlug) {
  if (!osmDir) return null;
  const file = path.join(osmDir, `osm_${citySlug}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data && data.ways && typeof data.ways === 'object') ? data.ways : null;
  } catch (e) {
    return null;
  }
}

function produceCity(repoRoot, citySlug, opts) {
  const o = opts || {};
  const osmDir = o.osmDir || process.env.ENRICH_OSM_DATA_DIR || null;
  const ways = readOsmWays(osmDir, citySlug);
  if (!ways) {
    return { citySlug, skipped: true, reason: 'no osm cache for city' };
  }

  const dataset = buildTrafficDataset(ways, {
    source:         o.source,
    datasetVersion: o.datasetVersion,
    unit:           o.unit,
    confidence:     o.confidence,
    year:           o.year,
    extractDate:    o.extractDate,
  });

  const outDir = o.outDir;
  if (!outDir) throw new Error('produceCity: opts.outDir required');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `traffic_${citySlug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dataset));

  return {
    citySlug,
    skipped: false,
    counts: {
      candidateWays: Object.keys(ways).length,
      taggedWays:    Object.keys(dataset.ways).length,
    },
    outFile,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    cities: [],
    outDir: process.env.ENRICH_TRAFFIC_DATA_DIR || '.enrichment-cache/traffic',
    osmDir: process.env.ENRICH_OSM_DATA_DIR || null,
    interCityDelayMs: DEFAULT_INTER_CITY_DELAY_MS,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--city')              opts.cities.push(argv[++i]);
    else if (a === '--out-dir')      opts.outDir = argv[++i];
    else if (a === '--osm-dir')      opts.osmDir = argv[++i];
    else if (a === '--year')         opts.year = Number(argv[++i]);
    else if (a === '--delay')        opts.interCityDelayMs = Number(argv[++i]);
    else if (a === '--json')         opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--'))     console.warn(`[traffic-producer] unknown flag ignored: ${a}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
`Usage: node scripts/producers/traffic_producer.js [options]

  --city <name>          produce only this city (repeatable);
                         default: every city listed in cities.txt
  --out-dir <path>       output directory (default: $ENRICH_TRAFFIC_DATA_DIR
                         or .enrichment-cache/traffic)
  --osm-dir <path>       directory holding osm_<slug>.json (input;
                         default: $ENRICH_OSM_DATA_DIR)
  --year <YYYY>          reference year written into each entry
                         (default: current UTC year)
  --delay <ms>           politeness delay between cities (default: ${DEFAULT_INTER_CITY_DELAY_MS})
  --json                 emit machine-readable summary

Environment:
  ENRICH_TRAFFIC_DATA_DIR  fallback for --out-dir
  ENRICH_OSM_DATA_DIR      fallback for --osm-dir

Note: this producer derives a DTV *proxy* from each OSM way's highway
class. The output is intentionally coarse — see docs/enrichment.md for
the proxy thresholds and the "Kontext nicht Ursache" disclaimer.
`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  const repoRoot = path.resolve(__dirname, '..', '..');
  let citySlugs = opts.cities.map(slugCity);
  if (citySlugs.length === 0) citySlugs = readCitiesTxt(repoRoot).map(slugCity);
  if (citySlugs.length === 0) {
    console.error('[traffic-producer] no cities to process (cities.txt empty and no --city given)');
    return 2;
  }

  const summary = { producer: 'traffic', producerVersion: PRODUCER_VERSION, cities: [] };
  let exit = 0;
  for (let i = 0; i < citySlugs.length; i++) {
    const slug = citySlugs[i];
    if (i > 0 && opts.interCityDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.interCityDelayMs));
    }
    try {
      const r = produceCity(repoRoot, slug, opts);
      summary.cities.push(r);
      if (!opts.json) {
        if (r.skipped) {
          console.log(`[traffic-producer] ${slug}: SKIP (${r.reason})`);
        } else {
          console.log(
            `[traffic-producer] ${slug}: ${r.counts.taggedWays}/${r.counts.candidateWays} ways tagged → ${r.outFile}`
          );
        }
      }
    } catch (e) {
      // One city's failure must not abort the whole producer run —
      // the enrichment script silently no-ops on missing files.
      exit = 1;
      const errEntry = { citySlug: slug, skipped: true, reason: `error: ${e.message}` };
      summary.cities.push(errEntry);
      if (!opts.json) console.error(`[traffic-producer] ${slug}: ERROR ${e.message}`);
    }
  }
  if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return exit;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error('[traffic-producer] fatal:', e);
    process.exit(1);
  });
}

module.exports = {
  PRODUCER_VERSION,
  DEFAULT_SOURCE,
  DEFAULT_UNIT,
  DEFAULT_CONFIDENCE,
  HIGHWAY_DTV_PROXY,
  slugCity,
  readCitiesTxt,
  dtvFromHighway,
  buildTrafficDataset,
  readOsmWays,
  produceCity,
  parseArgs,
  main,
};
