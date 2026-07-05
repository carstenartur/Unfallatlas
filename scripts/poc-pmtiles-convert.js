/**
 * scripts/poc-pmtiles-convert.js
 *
 * Proof-of-Concept: Zeigt wie Unfalldaten von GeoJSON → PMTiles/MVT
 * migriert werden können.
 *
 * HINWEISE:
 * - Dieses Script ist ein SKELETON / Demonstrator, kein Produktionscode.
 * - Es erzeugt keine großen Ausgabedateien (arbeitet auf kleinen Fixtures).
 * - Für echte PMTiles-Konvertierung wird `tippecanoe` (CLI) empfohlen.
 * - Für MapLibre-Integration: `pmtiles` npm-Paket (~60 KB gzip).
 *
 * Voraussetzungen für echten Betrieb:
 *   npm install pmtiles  (oder: tippecanoe via apt/brew)
 *
 * Verwendung (Demo-Modus, kein externen Tools nötig):
 *   node scripts/poc-pmtiles-convert.js --demo
 *
 * Verwendung für echte Konvertierung (tippecanoe erforderlich):
 *   node scripts/poc-pmtiles-convert.js --city augsburg
 *
 * Dokumentation: docs/data-format-migration.md
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

/** Minimale Felder, die in den PMTiles-Layer übernommen werden. */
const ACCIDENT_LAYER_FIELDS = [
  'year',
  'ukategorie',
  'utyp1',
  'uart',
  'ulichtverh',
  'ustunde',
  'uwochentag',
  'umonat',
  'istrad',
  'istpkw',
  'istfuss',
  'istkrad',
  'istgkfz',
  'istsonstig',
  'slope_class',
  'traffic_proxy_class',
  'matched_way_id',
];

/** Felder, die in GeoJSON vorhanden sind, aber NICHT mehr in PMTiles benötigt werden. */
const DROPPED_FIELDS = [
  'name',               // Ableitbar aus anderen Feldern
  'id',                 // Interne ID, nicht für Karte nötig
  'strasse',            // Selten befüllt
  'road_context_source', // Immer "osm" - 100% redundant
  'elevation_m',        // Nur bei Detail-Ansicht nötig → context layer
  'slope_percent',      // Nur bei Detail-Ansicht nötig → context layer
  'slope_abs_percent',  // Abgeleitet von slope_percent
  'slope_source',       // Nur Metadaten
  'slope_confidence',   // Nur Metadaten
];

/** Kodierung für slope_class → Integer (spart Strings im MVT). */
const SLOPE_CLASS_CODES = {
  'flat':       0,
  'gentle':     1,
  'moderate':   2,
  'steep':      3,
  'very_steep': 4,
};

/** Kodierung für traffic_proxy_class → Integer. */
const TRAFFIC_CLASS_CODES = {
  'low':       0,
  'medium':    1,
  'high':      2,
  'very_high': 3,
};

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Wandelt ein GeoJSON-Feature in die minimale PMTiles-kompatible Form um.
 * Entfernt redundante Felder, kodiert kategorische Werte als Integer.
 *
 * @param {Object} feature - GeoJSON Feature
 * @returns {Object} Kompaktiertes Feature
 */
function compactAccidentFeature(feature) {
  const p = feature.properties;
  const compact = {};

  for (const field of ACCIDENT_LAYER_FIELDS) {
    if (p[field] !== undefined && p[field] !== null) {
      let val = p[field];

      // Kategorische Felder als Integer kodieren
      if (field === 'slope_class' && typeof val === 'string') {
        val = SLOPE_CLASS_CODES[val] ?? val;
      } else if (field === 'traffic_proxy_class' && typeof val === 'string') {
        val = TRAFFIC_CLASS_CODES[val] ?? val;
      }

      // Boolean-Felder als 0/1 kodieren
      if (['istrad', 'istpkw', 'istfuss', 'istkrad', 'istgkfz', 'istsonstig'].includes(field)) {
        val = Number(val) || 0;
      }

      compact[field] = val;
    }
  }

  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: compact,
  };
}

/**
 * Generiert eine kompakte Metadaten-JSON für eine Stadt.
 * Diese Datei ersetzt die Rolle von `enrichment.meta.json` und
 * enthält Schema-Informationen für das Frontend.
 *
 * @param {string} citySlug - z.B. "augsburg"
 * @param {Object[]} features - Kompaktierte Features
 * @returns {Object} Metadaten-Objekt
 */
function buildCityMetadata(citySlug, features) {
  const years = [...new Set(features
    .map((f) => {
      const year = f?.properties?.year;
      if (year === undefined || year === null || year === '') {
        return null;
      }
      const parsed = Number(year);
      return Number.isFinite(parsed) ? parsed : null;
    })
    .filter(y => y !== null)
  )].sort((a, b) => a - b);
  const bbox  = computeBbox(features);
  const yearRange = years.length > 0
    ? { min: years[0], max: years[years.length - 1] }
    : null;

  return {
    schemaVersion: 1,
    citySlug,
    featureCount: features.length,
    yearRange,
    years,
    bbox,
    layers: {
      accidents: {
        format: 'pmtiles',
        path: `pmtiles/${citySlug}.pmtiles`,
        zoomRange: { min: 5, max: 16 },
        fields: ACCIDENT_LAYER_FIELDS,
        fieldCodes: {
          slope_class: SLOPE_CLASS_CODES,
          traffic_proxy_class: TRAFFIC_CLASS_CODES,
        },
      },
      context: {
        format: 'pmtiles',
        path: `pmtiles/${citySlug}_context.pmtiles`,
        zoomRange: { min: 13, max: 16 },
        lazyLoad: true,
        note: 'Context (OSM roads) layer — loaded on demand only',
      },
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Berechnet den Bounding Box eines Feature-Arrays.
 *
 * @param {Object[]} features - GeoJSON Features
 * @returns {number[]} [minLon, minLat, maxLon, maxLat]
 */
function computeBbox(features) {
  if (!Array.isArray(features) || features.length === 0) {
    return null;
  }

  let minLon =  Infinity, minLat =  Infinity;
  let maxLon = -Infinity, maxLat = -Infinity;

  for (const f of features) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)
    || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }

  return [
    Math.round(minLon * 1e6) / 1e6,
    Math.round(minLat * 1e6) / 1e6,
    Math.round(maxLon * 1e6) / 1e6,
    Math.round(maxLat * 1e6) / 1e6,
  ];
}

/**
 * Zeigt Größenvergleich: Original vs. Kompakt-GeoJSON.
 * Demonstriert das Einsparpotenzial ohne externe Tools.
 *
 * @param {string} citySlug
 */
function runDemo(citySlug = 'augsburg') {
  const inputPath = path.join(__dirname, '..', 'out', `output_all_years_${citySlug}.geojson`);

  if (!fs.existsSync(inputPath)) {
    console.error(`Demo: Keine Datei gefunden: ${inputPath}`);
    console.log('Versuche Fixture...');
    runFixtureDemo();
    return;
  }

  console.log(`\n=== PMTiles POC Demo: ${citySlug} ===\n`);

  const raw  = fs.readFileSync(inputPath);
  const data = JSON.parse(raw);

  console.log(`Original GeoJSON:`);
  console.log(`  Features:     ${data.features.length.toLocaleString()}`);
  console.log(`  Dateigröße:   ${(raw.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Properties:   ${Object.keys(data.features[0]?.properties ?? {}).length} Felder`);

  // Kompaktierung anwenden
  const compacted = data.features.map(compactAccidentFeature);

  const compactGeoJson = JSON.stringify({
    type: 'FeatureCollection',
    features: compacted,
  });
  const compactGeoJsonBytes = Buffer.byteLength(compactGeoJson, 'utf8');

  console.log(`\nKompaktiertes GeoJSON (ohne redundante Felder):`);
  console.log(`  Properties:   ${Object.keys(compacted[0]?.properties ?? {}).length} Felder`);
  console.log(`  Dateigröße:   ${(compactGeoJsonBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Einsparung:   ${((1 - compactGeoJsonBytes / raw.length) * 100).toFixed(1)}%`);

  // Metadaten generieren
  const metadata = buildCityMetadata(citySlug, compacted);

  console.log(`\nGenerierte Metadaten (${citySlug}.json):`);
  console.log(`  ${JSON.stringify(metadata, null, 2).split('\n').slice(0, 15).join('\n')}`);
  console.log(`  ... (${JSON.stringify(metadata).length} Bytes)\n`);

  console.log(`\nNächste Schritte für echte PMTiles-Konvertierung:`);
  console.log(`  1. tippecanoe installieren: brew install tippecanoe`);
  console.log(`  2. Konvertieren:`);
  console.log(`     tippecanoe \\`);
  console.log(`       -o out/pmtiles/${citySlug}.pmtiles \\`);
  console.log(`       -z 16 -Z 5 \\`);
  console.log(`       --drop-densest-as-needed \\`);
  console.log(`       --layer accidents \\`);
  console.log(`       <(node scripts/poc-pmtiles-convert.js --compact-stdout --city ${citySlug})`);
  console.log(`  3. Größe prüfen:`);
  console.log(`     ls -lh out/pmtiles/${citySlug}.pmtiles\n`);
}

/**
 * Führt den Demo mit einer kleinen Fixture durch (keine echten Daten nötig).
 */
function runFixtureDemo() {
  const fixturePath = path.join(__dirname, '..', 'tests', 'fixtures', 'accidents_sample.geojson');

  if (!fs.existsSync(fixturePath)) {
    // Inline-Fixture
    const fixture = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [10.9289, 48.3785] },
          properties: {
            id: '60696',
            name: 'Unfall 60696 (2016) Kat:3, Licht: 2',
            year: 2016,
            ukategorie: '3',
            utyp1: '1',
            uart: '9',
            umonat: '01',
            ustunde: '23',
            uwochentag: '7',
            ulichtverh: '2',
            strasse: '',
            strzustand: '',
            istrad: '0',
            istpkw: '1',
            istfuss: '0',
            istkrad: '0',
            istgkfz: '0',
            istsonstig: '0',
            matched_way_id: '4354097',
            road_context_source: 'osm',
            elevation_m: 470.9,
            slope_percent: -7.3,
            slope_abs_percent: 7.3,
            slope_class: 'steep',
            slope_source: 'SRTM Local Tiles',
            traffic_proxy_class: 'high',
          },
        },
      ],
    };

    console.log('\n=== PMTiles POC Demo: Inline-Fixture ===\n');
    const rawLen    = JSON.stringify(fixture).length;
    const compact   = compactAccidentFeature(fixture.features[0]);
    const compactLen = JSON.stringify({ type: 'FeatureCollection', features: [compact] }).length;

    console.log('Original Properties:', Object.keys(fixture.features[0].properties));
    console.log('Kompakt Properties: ', Object.keys(compact.properties));
    console.log(`\nGröße original:  ${rawLen} Bytes`);
    console.log(`Größe kompakt:   ${compactLen} Bytes`);
    console.log(`Einsparung:      ${((1 - compactLen / rawLen) * 100).toFixed(1)}%\n`);
    return;
  }

  const raw  = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const compacted = raw.features.map(compactAccidentFeature);
  console.log(`Fixture kompaktiert: ${raw.features.length} Features, `
    + `${Object.keys(compacted[0].properties).length} Felder`);
}

/**
 * Schreibt kompaktiertes GeoJSON ohne Log-Ausgaben auf stdout.
 * Für Pipelines wie: tippecanoe ... <(node ... --compact-stdout)
 *
 * @param {string} citySlug
 */
function writeCompactGeoJsonToStdout(citySlug = 'augsburg') {
  const inputPath = path.join(__dirname, '..', 'out', `output_all_years_${citySlug}.geojson`);
  if (!fs.existsSync(inputPath)) {
    console.error(`Fehler: Keine Datei gefunden für --compact-stdout: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  const raw  = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const compacted = raw.features.map(compactAccidentFeature);
  process.stdout.write(JSON.stringify({ type: 'FeatureCollection', features: compacted }));
}

// ---------------------------------------------------------------------------
// CLI-Einstiegspunkt
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
PMTiles Proof-of-Concept Konverter
===================================

Verwendung:
  node scripts/poc-pmtiles-convert.js [--city <slug>] [--demo] [--compact-stdout]

Optionen:
  --city <slug>    Spezifische Stadt für Demo (Standard: augsburg)
  --demo           Erzwingt Demo mit kleiner Fixture/Inline-Daten
  --compact-stdout Gibt nur kompaktes GeoJSON auf stdout aus (für Pipelines)
  --help           Diese Hilfe

Weitere Infos: docs/data-format-migration.md
`);
} else {
  const cityIdx = args.indexOf('--city');
  const cityArg = cityIdx !== -1 && args[cityIdx + 1] && !args[cityIdx + 1].startsWith('--')
    ? args[cityIdx + 1]
    : 'augsburg';

  if (args.includes('--compact-stdout')) {
    writeCompactGeoJsonToStdout(cityArg);
  } else if (args.includes('--demo')) {
    runFixtureDemo();
  } else {
    runDemo(cityArg);
  }
}

module.exports = {
  compactAccidentFeature,
  buildCityMetadata,
  computeBbox,
  ACCIDENT_LAYER_FIELDS,
  DROPPED_FIELDS,
  SLOPE_CLASS_CODES,
  TRAFFIC_CLASS_CODES,
};
