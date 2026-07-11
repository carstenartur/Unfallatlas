#!/usr/bin/env node
'use strict';

/**
 * scripts/create-ci-fixtures.js
 *
 * Generates minimal gzip-compressed GeoJSON fixture files for every city
 * that is listed as `accidentDataSupport: 'supported'` in the city registry
 * but does not yet have an `out/output_all_years_<id>.geojson.gz` file.
 *
 * This script is intended to be run as a step in CI test workflows (e2e,
 * firefox-smoke, webkit-smoke) so that the static test server can serve
 * the data files that the gzip-only frontend expects — without any manual
 * file creation.
 *
 * The generated files contain 2 synthetic accident points with valid
 * coordinates inside the named city so the frontend can parse and render
 * them normally.  They are never committed; the test job generates them
 * on the fly.
 *
 * Usage:
 *   node scripts/create-ci-fixtures.js
 *   node scripts/create-ci-fixtures.js --dry-run
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const cityRegistry = require(path.join(__dirname, '..', 'server', 'cities', 'cityRegistry.js'));

const OUT_DIR  = path.join(__dirname, '..', 'out');
const DRY_RUN  = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Approximate city-centre coordinates for the supported cities.
// Used to generate points that pass UA.extractPoints bounding-box validation
// (lat 46–56, lon 4–17). Falls back to central Germany if a city is missing.
// ---------------------------------------------------------------------------
const CITY_CENTRES = {
  berlin:           { lat: 52.520, lon: 13.405 },
  hamburg:          { lat: 53.550, lon: 9.993  },
  muenchen:         { lat: 48.135, lon: 11.582 },
  koeln:            { lat: 50.938, lon: 6.960  },
  frankfurt_am_main:{ lat: 50.110, lon: 8.682  },
  stuttgart:        { lat: 48.775, lon: 9.182  },
  duesseldorf:      { lat: 51.227, lon: 6.773  },
  leipzig:          { lat: 51.340, lon: 12.375 },
  dortmund:         { lat: 51.515, lon: 7.465  },
  essen:            { lat: 51.455, lon: 7.012  },
  bremen:           { lat: 53.079, lon: 8.801  },
  dresden:          { lat: 51.050, lon: 13.737 },
  hannover:         { lat: 52.376, lon: 9.732  },
  nuernberg:        { lat: 49.452, lon: 11.077 },
  duisburg:         { lat: 51.435, lon: 6.762  },
  bochum:           { lat: 51.482, lon: 7.216  },
  wuppertal:        { lat: 51.256, lon: 7.150  },
  bielefeld:        { lat: 52.021, lon: 8.532  },
  bonn:             { lat: 50.733, lon: 7.099  },
  muenster:         { lat: 51.960, lon: 7.626  },
  karlsruhe:        { lat: 49.007, lon: 8.404  },
  mannheim:         { lat: 49.487, lon: 8.466  },
  augsburg:         { lat: 48.370, lon: 10.898 },
  heilbronn:        { lat: 49.139, lon: 9.220  },
  braunschweig:     { lat: 52.269, lon: 10.520 },
  wolfsburg:        { lat: 52.423, lon: 10.787 },
};

// ---------------------------------------------------------------------------
// Minimal fixture data: 2 synthetic accident points per city.
// ---------------------------------------------------------------------------
function makeFixtureGeoJSON(cityId) {
  const centre = CITY_CENTRES[cityId] || { lat: 51.0, lon: 10.0 };
  const lat    = centre.lat;
  const lon    = centre.lon;

  return {
    type: 'FeatureCollection',
    properties: { city: cityId, source: 'ci-fixture' },
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          OBJECTID: 1, UKATEGORIE: '2', UTYP1: '3', UART: '0',
          IstRad: 1, IstFuss: 0, IstPKW: 1, IstKrad: 0, IstGkfz: 0, IstSonstig: 0,
          USTUNDE: 8, UWOCHENTAG: '2', UMONAT: 5, UJAHR: 2023,
          STRZUSTAND: '0', ULICHTVERH: '0',
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon + 0.001, lat + 0.001] },
        properties: {
          OBJECTID: 2, UKATEGORIE: '3', UTYP1: '2', UART: '0',
          IstRad: 0, IstFuss: 1, IstPKW: 1, IstKrad: 0, IstGkfz: 0, IstSonstig: 0,
          USTUNDE: 17, UWOCHENTAG: '5', UMONAT: 9, UJAHR: 2023,
          STRZUSTAND: '0', ULICHTVERH: '0',
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const cities = cityRegistry.listCities();
  const supported = cities.filter(c => c.accidentDataSupport === 'supported');

  if (supported.length === 0) {
    console.log('[create-ci-fixtures] No supported cities found — nothing to do.');
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const city of supported) {
    const outPath = path.join(OUT_DIR, `output_all_years_${city.id}.geojson.gz`);

    // Skip if a real (or previously generated) file already exists.
    if (fs.existsSync(outPath)) {
      console.log(`[create-ci-fixtures] SKIP  ${city.id} (already exists)`);
      skipped++;
      continue;
    }

    const geojson    = makeFixtureGeoJSON(city.id);
    const jsonText   = JSON.stringify(geojson);
    const compressed = zlib.gzipSync(Buffer.from(jsonText, 'utf8'));

    if (DRY_RUN) {
      console.log(`[create-ci-fixtures] DRY   ${city.id} -> ${outPath} (${compressed.length} bytes)`);
    } else {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(outPath, compressed);
      console.log(`[create-ci-fixtures] CREATE ${city.id} -> ${outPath} (${compressed.length} bytes)`);
    }
    created++;
  }

  console.log(
    `[create-ci-fixtures] Done. created=${DRY_RUN ? 0 : created} skipped=${skipped} ` +
    `(${DRY_RUN ? 'dry-run' : 'live'})`
  );
}

main();
