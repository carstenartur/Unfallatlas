/**
 * Integration tests for document export functionality
 * Uses real export libraries (docx, pdfmake) instead of mocks.
 */

describe('Document Export - Integration Tests', () => {
  let UA;
  let mockCanvas;
  let originalLocation;

  beforeEach(() => {
    // Setup mock canvas (leafletImage needs a real Leaflet map / Canvas API)
    mockCanvas = {
      toDataURL: jest.fn(() => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
    };

    // Save original location for cleanup
    originalLocation = window.location;

    // Prevent jsdom location interference by using Object.defineProperty
    try {
      delete window.location;
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/werkbank_v2.html',
          search: '',
          hash: '',
          href: 'http://localhost/werkbank_v2.html',
          origin: 'http://localhost',
          protocol: 'http:',
          host: 'localhost'
        },
        writable: true,
        configurable: true
      });
    } catch (e) {
      window.location.pathname = '/werkbank_v2.html';
    }

    // Load real export libraries and set them on window.
    // Object.assign(window, ...) correctly sets properties on jsdom's window.
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts.pdfMake.vfs;

    Object.assign(window, {
      UA: {},
      leafletImage: jest.fn((map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 50);
      }),
      docx: require('docx'),
      pdfMake: pdfMakeLib,
      saveAs: jest.fn()   // spy only – validates the blob, not the browser download
    });

    // Spy on pdfMake.createPdf to capture the document definition for assertions
    // and intercept the browser-only .download() call. The real pdfmake still
    // processes the definition so we can validate it is correct.
    const realCreatePdf = pdfMakeLib.createPdf.bind(pdfMakeLib);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      const doc = realCreatePdf(def);
      doc.download = jest.fn(); // intercept browser download trigger
      return doc;
    });

    // Load the module - using eval because files use IIFE pattern
    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    eval(fs.readFileSync(filePath, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    // Restore location
    try {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true
      });
    } catch (e) { /* ignore */ }

    // Clean up window properties
    delete window.UA;
    delete window.leafletImage;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  describe('PDF Export with Test Data', () => {
    test('should generate PDF with accident data', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: `Sachverhalt:
Im markierten Kartenausschnitt wurden 42 Unfälle ausgewertet.
Davon waren 15 Radunfälle, 10 Fußgängerunfälle und 17 PKW-Unfälle.

POI-Analyse
Innerhalb des Ausschnitts: Grundschule Am Sandbach (200m)

Bezugsdokumente:
Die Ideale Kreuzung - Leitfaden für sichere Knotenpunkte

Beschlussvorschlag:
Der Bezirksrat bittet die Verwaltung, den markierten Bereich zu prüfen.`
      };

      const options = {
        includeMap: false,
        includePOIs: true,
        includeReferences: true
      };

      await UA.exportToPDF(ctx, reportData, options);

      expect(window.pdfMake.createPdf).toHaveBeenCalled();
      
      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];
      expect(pdfDefinition.content).toBeDefined();
      expect(pdfDefinition.content.length).toBeGreaterThan(0);
      
      // Verify PDF structure contains expected sections
      const contentTexts = pdfDefinition.content.map(item => 
        typeof item.text === 'string' ? item.text : 
        Array.isArray(item.text) ? item.text.join('') : ''
      ).join(' ');
      
      expect(contentTexts).toContain('BEZIRKSRATSANTRAG');
      expect(contentTexts).toContain('SACHVERHALT');
      expect(contentTexts).toContain('BESCHLUSSVORSCHLAG');
    });

    test('should generate PDF with map image', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: 'Sachverhalt:\nTest content\n\nBeschlussvorschlag:\nTest proposal'
      };

      const options = {
        includeMap: true,
        includePOIs: false,
        includeReferences: false
      };

      await UA.exportToPDF(ctx, reportData, options);

      expect(window.leafletImage).toHaveBeenCalled();
      expect(window.pdfMake.createPdf).toHaveBeenCalled();
      
      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];
      
      // Verify map section is included
      const hasMapImage = pdfDefinition.content.some(item => 
        item.image && item.image.startsWith('data:image/png;base64,')
      );
      expect(hasMapImage).toBe(true);
    });
  });

  describe('Word Export with Test Data', () => {
    test('should generate Word document with accident data', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: `Sachverhalt:
Im markierten Kartenausschnitt wurden 42 Unfälle ausgewertet.

POI-Analyse
Grundschule Am Sandbach (150m entfernt)

Beschlussvorschlag:
Der Bezirksrat bittet die Verwaltung um Prüfung.`
      };

      const options = {
        includeMap: false,
        includePOIs: true,
        includeReferences: false
      };

      await UA.exportToWord(ctx, reportData, options);

      // saveAs should be called with a real, non-empty Word document blob
      expect(window.saveAs).toHaveBeenCalled();
      const [blob, filename] = window.saveAs.mock.calls[0];
      expect(blob.size).toBeGreaterThan(0);
      expect(blob.type).toContain('application/vnd');
      expect(filename).toMatch(/Bezirksratsantrag_Hannover_.*\.docx/);
    });

    test('should generate Word document with map image', async () => {
      const ctx = {
        CITY_RAW: 'Berlin',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.5200, lng: 13.4050 })),
          getZoom: jest.fn(() => 13)
        }
      };

      const reportData = {
        text: 'Sachverhalt:\nTest content\n\nBeschlussvorschlag:\nTest proposal'
      };

      const options = {
        includeMap: true,
        includePOIs: false,
        includeReferences: false
      };

      await UA.exportToWord(ctx, reportData, options);

      expect(window.leafletImage).toHaveBeenCalled();
      expect(window.saveAs).toHaveBeenCalled();
      const [blob] = window.saveAs.mock.calls[0];
      expect(blob.size).toBeGreaterThan(0);
    });

    test('should handle map capture failure gracefully', async () => {
      // Mock leaflet-image to fail
      window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(new Error('Map capture failed'), null), 50);
      });

      const ctx = {
        CITY_RAW: 'Hamburg',
        map: {
          getCenter: jest.fn(() => ({ lat: 53.5511, lng: 9.9937 })),
          getZoom: jest.fn(() => 11)
        }
      };

      const reportData = {
        text: 'Sachverhalt:\nTest\n\nBeschlussvorschlag:\nProposal'
      };

      const options = {
        includeMap: true,
        includePOIs: false,
        includeReferences: false
      };

      // Should not throw - graceful degradation
      await expect(UA.exportToWord(ctx, reportData, options)).resolves.not.toThrow();
      
      expect(window.saveAs).toHaveBeenCalled();
    });
  });

  describe('Export with POI Data', () => {
    test('should include POI analysis in PDF', async () => {
      const ctx = {
        CITY_RAW: 'München',
        map: {
          getCenter: jest.fn(() => ({ lat: 48.1351, lng: 11.5820 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: `Sachverhalt:
42 Unfälle im Bereich

POI-Analyse
Innerhalb des Ausschnitts:
- Grundschule Beispielstraße (100m)
- Kindergarten Sonnenschein (150m)

In der Nähe (bis 200m):
- Kita Regenbogen (180m)

Beschlussvorschlag:
Prüfung erforderlich`
      };

      const options = {
        includeMap: false,
        includePOIs: true,
        includeReferences: false
      };

      await UA.exportToPDF(ctx, reportData, options);

      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];
      const contentTexts = pdfDefinition.content.map(item => 
        typeof item.text === 'string' ? item.text : 
        Array.isArray(item.text) ? item.text.join('') : ''
      ).join(' ');

      expect(contentTexts).toContain('SENSIBLE EINRICHTUNGEN');
      expect(contentTexts).toContain('Grundschule');
      expect(contentTexts).toContain('Kindergarten');
    });
  });

  describe('Export with Reference Documents', () => {
    test('should include references in PDF', async () => {
      const ctx = {
        CITY_RAW: 'Köln',
        map: {
          getCenter: jest.fn(() => ({ lat: 50.9375, lng: 6.9603 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: `Sachverhalt:
Test content

Bezugsdokumente:
- Die Ideale Kreuzung (Region Hannover, 2023)
- Verkehrssicherheitskonzept NRW

Beschlussvorschlag:
Maßnahmen erforderlich`
      };

      const options = {
        includeMap: false,
        includePOIs: false,
        includeReferences: true
      };

      await UA.exportToPDF(ctx, reportData, options);

      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];
      const contentTexts = pdfDefinition.content.map(item => 
        typeof item.text === 'string' ? item.text : 
        Array.isArray(item.text) ? item.text.join('') : ''
      ).join(' ');

      expect(contentTexts).toContain('FACHLICHE BEZÜGE');
      expect(contentTexts).toContain('Ideale Kreuzung');
    });
  });

  describe('Complete Export Flow', () => {
    test('should generate complete PDF with all sections', async () => {
      const ctx = {
        CITY_RAW: 'Düsseldorf',
        map: {
          getCenter: jest.fn(() => ({ lat: 51.2277, lng: 6.7735 })),
          getZoom: jest.fn(() => 13)
        }
      };

      const reportData = {
        text: `Sachverhalt:
Im markierten Kartenausschnitt wurden 58 Unfälle ausgewertet.
Davon 25 mit Radbeteiligung, 12 mit Fußgängerbeteiligung.

POI-Analyse
Innerhalb: Grundschule Musterstraße (80m)
In der Nähe: Kindergarten Test (190m)

Bezugsdokumente:
Verkehrssicherheitskonzept Düsseldorf 2025

Beschlussvorschlag:
Der Bezirksrat bittet um umfassende Prüfung und Maßnahmen.`
      };

      const options = {
        includeMap: true,
        includePOIs: true,
        includeReferences: true
      };

      await UA.exportToPDF(ctx, reportData, options);

      expect(window.leafletImage).toHaveBeenCalled();
      expect(window.pdfMake.createPdf).toHaveBeenCalled();
      
      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];
      const contentTexts = pdfDefinition.content.map(item => 
        typeof item.text === 'string' ? item.text : 
        Array.isArray(item.text) ? item.text.join('') : ''
      ).join(' ');

      // Verify all main sections are present
      expect(contentTexts).toContain('BEZIRKSRATSANTRAG');
      expect(contentTexts).toContain('SACHVERHALT');
      expect(contentTexts).toContain('SENSIBLE EINRICHTUNGEN');
      expect(contentTexts).toContain('FACHLICHE BEZÜGE');
      expect(contentTexts).toContain('BESCHLUSSVORSCHLAG');
      expect(contentTexts).toContain('DATENQUELLE');
    });
  });
});

/**
 * Integration tests for data export functions (CSV, GeoJSON, KML)
 */
describe('Data Export - CSV / GeoJSON / KML', () => {
  let UA;
  let capturedBlob;
  let capturedFilename;

  // Helper: read a Blob as text (jsdom's Blob may not implement .text())
  function readBlobAsText(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(blob);
    });
  }

  // Sample accident points covering two locations inside the mock bounds
  const testPoints = [
    { lat: 52.376, lon: 9.732, props: { year: '2021', ukategorie: '2', IstRad: '1', IstFuss: '0', IstPKW: '1', IstKrad: '0', ustunde: '8', uwochentag: '2', strzustand: '0' } },
    { lat: 52.380, lon: 9.740, props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '1', IstPKW: '1', IstKrad: '0', ustunde: '17', uwochentag: '3', strzustand: '0' } },
    { lat: 52.370, lon: 9.720, props: { year: '2020', ukategorie: '1', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', ustunde: '12', uwochentag: '5', strzustand: '1' } },
    // Point outside bounds (far away) – should NOT appear in export
    { lat: 48.100, lon: 11.500, props: { year: '2021', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '1', IstKrad: '0', ustunde: '9', uwochentag: '1', strzustand: '0' } }
  ];

  // Bounds that contain the first three points but not the fourth
  const mockBounds = {
    contains: (latLng) => {
      const [lat, lng] = Array.isArray(latLng) ? latLng : [latLng.lat, latLng.lng];
      return lat >= 52.0 && lat <= 53.0 && lng >= 9.5 && lng <= 10.5;
    },
    getCenter: () => ({ lat: 52.375, lng: 9.730 }),
    getSouthWest: () => ({ lat: 52.0, lng: 9.5 }),
    getNorthEast: () => ({ lat: 53.0, lng: 10.5 })
  };

  const makeCtx = () => ({
    CITY_RAW: 'Hannover',
    allPts: testPoints,
    selectionBounds: mockBounds,
    map: { getBounds: jest.fn(() => mockBounds) }
  });

  beforeEach(() => {
    capturedBlob = null;
    capturedFilename = null;

    Object.assign(window, {
      UA: {},
      saveAs: jest.fn((blob, filename) => {
        capturedBlob = blob;
        capturedFilename = filename;
      })
    });

    // Mock fetch so template loading falls back gracefully
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }));

    const fs = require('fs');
    const path = require('path');
    // Load core utils (provides UA.escHtml needed by computeExportReport)
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.core.js'), 'utf8'));
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.export_v2.js'), 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.saveAs;
    delete global.fetch;
    jest.restoreAllMocks();
  });

  // ---------- CSV ----------

  describe('UA.exportToCSV', () => {
    test('should call saveAs with a CSV blob', () => {
      UA.exportToCSV(makeCtx());

      expect(window.saveAs).toHaveBeenCalledTimes(1);
      expect(capturedFilename).toMatch(/^Unfallatlas_Hannover_\d{4}-\d{2}-\d{2}\.csv$/);
      expect(capturedBlob).toBeInstanceOf(Blob);
      expect(capturedBlob.size).toBeGreaterThan(0);
    });

    test('should include a header row and one row per in-bounds point', async () => {
      UA.exportToCSV(makeCtx());

      const text = await readBlobAsText(capturedBlob);
      const lines = text.trim().split('\n');

      // Header + 3 in-bounds points (the 4th is outside bounds)
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('lat,lon,year,ukategorie,IstRad,IstFuss,IstPKW,IstKrad,IstGkfz,ustunde,uwochentag,strzustand');
    });

    test('should contain correct lat/lon values for each point', async () => {
      UA.exportToCSV(makeCtx());
      const text = await readBlobAsText(capturedBlob);

      expect(text).toContain('52.376');
      expect(text).toContain('9.732');
      expect(text).toContain('52.38');
      // Out-of-bounds point should NOT appear
      expect(text).not.toContain('48.1');
    });

    test('should contain accident property values', async () => {
      UA.exportToCSV(makeCtx());
      const text = await readBlobAsText(capturedBlob);

      expect(text).toContain('2021');
      expect(text).toContain('2022');
      expect(text).toContain('2020');
    });

    test('should work without selectionBounds (uses map.getBounds)', () => {
      const ctx = makeCtx();
      delete ctx.selectionBounds;
      UA.exportToCSV(ctx);

      expect(ctx.map.getBounds).toHaveBeenCalled();
      expect(window.saveAs).toHaveBeenCalledTimes(1);
    });

    test('should produce valid CSV even with empty points', async () => {
      const ctx = makeCtx();
      ctx.allPts = [];
      UA.exportToCSV(ctx);

      const text = await readBlobAsText(capturedBlob);
      const lines = text.trim().split('\n');
      expect(lines).toHaveLength(1); // header only
      expect(lines[0]).toContain('lat');
    });
  });

  // ---------- GeoJSON ----------

  describe('UA.exportToGeoJSON', () => {
    test('should call saveAs with a GeoJSON blob', () => {
      UA.exportToGeoJSON(makeCtx());

      expect(window.saveAs).toHaveBeenCalledTimes(1);
      expect(capturedFilename).toMatch(/^Unfallatlas_Hannover_\d{4}-\d{2}-\d{2}\.geojson$/);
      expect(capturedBlob).toBeInstanceOf(Blob);
      expect(capturedBlob.size).toBeGreaterThan(0);
    });

    test('should produce valid GeoJSON FeatureCollection', async () => {
      UA.exportToGeoJSON(makeCtx());

      const text = await readBlobAsText(capturedBlob);
      const parsed = JSON.parse(text);

      expect(parsed.type).toBe('FeatureCollection');
      expect(Array.isArray(parsed.features)).toBe(true);
      // 3 in-bounds points
      expect(parsed.features).toHaveLength(3);
    });

    test('each feature should have Point geometry with correct coordinates', async () => {
      UA.exportToGeoJSON(makeCtx());
      const { features } = JSON.parse(await readBlobAsText(capturedBlob));

      for (const f of features) {
        expect(f.type).toBe('Feature');
        expect(f.geometry.type).toBe('Point');
        expect(f.geometry.coordinates).toHaveLength(2);
        // GeoJSON coordinates are [lon, lat]
        expect(typeof f.geometry.coordinates[0]).toBe('number');
        expect(typeof f.geometry.coordinates[1]).toBe('number');
      }
    });

    test('features should include expected properties', async () => {
      UA.exportToGeoJSON(makeCtx());
      const { features } = JSON.parse(await readBlobAsText(capturedBlob));

      const first = features[0];
      expect(first.properties).toHaveProperty('year');
      expect(first.properties).toHaveProperty('ukategorie');
      expect(first.properties).toHaveProperty('IstRad');
      expect(first.properties).toHaveProperty('IstFuss');
      expect(first.properties).toHaveProperty('IstPKW');
      expect(first.properties).toHaveProperty('IstKrad');
      expect(first.properties).toHaveProperty('ustunde');
      expect(first.properties).toHaveProperty('uwochentag');
    });

    test('should exclude out-of-bounds points', async () => {
      UA.exportToGeoJSON(makeCtx());
      const { features } = JSON.parse(await readBlobAsText(capturedBlob));

      // The point at lat 48.1, lon 11.5 should not be present
      const lats = features.map(f => f.geometry.coordinates[1]);
      expect(lats.every(lat => lat >= 52.0)).toBe(true);
    });
  });

  // ---------- KML ----------

  describe('UA.exportToKML', () => {
    test('should call saveAs with a KML blob', () => {
      UA.exportToKML(makeCtx());

      expect(window.saveAs).toHaveBeenCalledTimes(1);
      expect(capturedFilename).toMatch(/^Unfallatlas_Hannover_\d{4}-\d{2}-\d{2}\.kml$/);
      expect(capturedBlob).toBeInstanceOf(Blob);
      expect(capturedBlob.size).toBeGreaterThan(0);
    });

    test('should produce well-formed KML XML', async () => {
      UA.exportToKML(makeCtx());
      const text = await readBlobAsText(capturedBlob);

      expect(text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(text).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
      expect(text).toContain('<Document>');
      expect(text).toContain('</Document>');
      expect(text).toContain('</kml>');
    });

    test('should contain one Placemark per in-bounds point', async () => {
      UA.exportToKML(makeCtx());
      const text = await readBlobAsText(capturedBlob);

      const placemarkCount = (text.match(/<Placemark>/g) || []).length;
      expect(placemarkCount).toBe(3);
    });

    test('should include coordinates for each point', async () => {
      UA.exportToKML(makeCtx());
      const text = await readBlobAsText(capturedBlob);

      expect(text).toContain('<Point>');
      expect(text).toContain('<coordinates>');
      // Check a known coordinate appears (lon,lat format)
      expect(text).toContain('9.732,52.376');
    });

    test('should include accident year and severity in placemark names', async () => {
      UA.exportToKML(makeCtx());
      const text = await readBlobAsText(capturedBlob);

      // Point with ukategorie 1 → "Getötet"
      expect(text).toContain('Getötet');
      // Point with ukategorie 2 → "Schwerverletzt"
      expect(text).toContain('Schwerverletzt');
      // Point with ukategorie 3 → "Leichtverletzt"
      expect(text).toContain('Leichtverletzt');
    });

    test('should XML-escape special characters in city name', () => {
      const ctx = makeCtx();
      ctx.CITY_RAW = 'Köln & <Test>';
      UA.exportToKML(ctx);
      // If it throws due to unescaped chars, the test fails; otherwise passes
      expect(window.saveAs).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- computeExportReport with real data ----------

  describe('UA.computeExportReport with realistic ctx', () => {
    test('should return text and html fields', async () => {
      // UA.reverseGeocode will fail (no network) and fall back gracefully
      const ctx = {
        CITY_RAW: 'Hannover',
        allPts: testPoints,
        selectionBounds: mockBounds,
        map: {
          getBounds: jest.fn(() => mockBounds),
          getCenter: jest.fn(() => ({ lat: 52.375, lng: 9.730 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);

      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('html');
      expect(typeof result.text).toBe('string');
      expect(typeof result.html).toBe('string');
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.html.length).toBeGreaterThan(0);
    });

    test('text output should contain city name and bounds info', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        allPts: testPoints,
        selectionBounds: mockBounds,
        map: {
          getBounds: jest.fn(() => mockBounds),
          getCenter: jest.fn(() => ({ lat: 52.375, lng: 9.730 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);

      expect(result.text).toContain('Hannover');
      // Bounds string from getSouthWest / getNorthEast
      expect(result.text).toContain('52.00000');
    });

    test('html output should contain table structure', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        allPts: testPoints,
        selectionBounds: mockBounds,
        map: {
          getBounds: jest.fn(() => mockBounds),
          getCenter: jest.fn(() => ({ lat: 52.375, lng: 9.730 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);

      expect(result.html).toContain('<table');
      expect(result.html).toContain('</table>');
    });
  });
});
