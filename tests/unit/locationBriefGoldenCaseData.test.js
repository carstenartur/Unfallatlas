'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
  normalizeCitySlug,
  buildStructuredFromCase,
  clearCityGeoJsonCache
} = require('../../scripts/lib/location-brief-golden-case-data');

function writeGzipGeoJson(repoRoot, citySlug, geojson) {
  const outDir = path.resolve(repoRoot, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.resolve(outDir, `output_all_years_${citySlug}.geojson.gz`),
    zlib.gzipSync(Buffer.from(JSON.stringify(geojson), 'utf8'))
  );
}

describe('location-brief golden-case data builder', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-golden-data-'));
    clearCityGeoJsonCache();
  });

  afterEach(() => {
    clearCityGeoJsonCache();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('reads gzip-only city data and filters a case bounding box', () => {
    writeGzipGeoJson(repoRoot, 'bonn', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [7.095, 50.732] },
          properties: { UKATEGORIE: 2, UJAHR: 2024, IstRad: 1, IstPKW: 1, USTUNDE: 8 }
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [7.096, 50.733] },
          properties: { ukategorie: 3, year: 2023, istrad: 1, istfuss: 1, ustunde: 17 }
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [7.2, 50.8] },
          properties: { UKATEGORIE: 1, UJAHR: 2024, IstPKW: 1 }
        }
      ]
    });

    const structured = buildStructuredFromCase({
      caseId: 'bonn-test',
      city: 'Bonn',
      description: 'Testbereich',
      bbox: { south: 50.73, west: 7.09, north: 50.735, east: 7.1 }
    }, { repoRoot, dataMode: 'gzip-only' });

    expect(structured.severity).toEqual({
      total: 2,
      bySev: { '1': 0, '2': 1, '3': 1, other: 0 }
    });
    expect(structured.crossTable.totals.total).toBe(2);
    expect(structured.accidentDetails.rows).toHaveLength(2);
    expect(structured.yearTable).toEqual([
      { year: 2023, total: 1 },
      { year: 2024, total: 1 }
    ]);
  });

  test('normalizes German city names to static-data slugs', () => {
    expect(normalizeCitySlug('  Mönchengladbach  ')).toBe('moenchengladbach');
    expect(normalizeCitySlug('Gießen')).toBe('giessen');
  });

  test('rejects an inverted bounding box before reading data', () => {
    expect(() => buildStructuredFromCase({
      caseId: 'bad-bbox',
      city: 'Bonn',
      bbox: { south: 51, west: 8, north: 50, east: 7 }
    }, { repoRoot })).toThrow(/inverted bbox/);
  });
});
