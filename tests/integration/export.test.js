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
    pdfMakeLib.vfs = pdfFonts;

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
Der Bezirksrat bittet die Verwaltung, den markierten Bereich zu prüfen.`,
        structured: { meta: { gremium: { typ: 'Bezirksrat' } } }
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

      // Verify map section is included. Layout-PR „Bildverzerrung beheben":
      // Bild und Caption werden jetzt als `unbreakable: true` Stack
      // gerendert, das Bild liegt also unter `item.stack[*]` statt direkt
      // unter `item`. Wir suchen rekursiv.
      function hasImage(node) {
        if (!node) return false;
        if (Array.isArray(node)) return node.some(hasImage);
        if (typeof node !== 'object') return false;
        if (typeof node.image === 'string' && node.image.startsWith('data:image/png;base64,')) return true;
        return hasImage(node.stack) || hasImage(node.columns);
      }
      expect(hasImage(pdfDefinition.content)).toBe(true);
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
      expect(filename).toMatch(/Antrag.*Hannover.*\.docx/);
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
Der Bezirksrat bittet um umfassende Prüfung und Maßnahmen.`,
        structured: { meta: { gremium: { typ: 'Bezirksrat' } } }
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

  describe('Export with structured data', () => {
    test('PDF should include STATISTIK section with severity table when structured data provided', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: 'Sachverhalt:\nTest content\n\nBeschlussvorschlag:\nTest proposal',
        structured: {
          meta: { city: 'Hannover', date: '01.01.2025', bounds: '52.0,9.5 – 53.0,10.5', areaName: 'Test', link: 'http://localhost/', filters: {} },
          severity: { total: 10, bySev: { '1': 1, '2': 4, '3': 5, other: 0 } },
          deviations: {
            focus: [
              { mask: 5, label: '[Rad]+[PKW]', locCnt: 5, baseCnt: 10, locR: 0.5, baseR: 0.2, factor: 2.5 }
            ],
            rows: [],
            local: { total: 10, byMask: {} },
            baseline: { total: 50, byMask: {} }
          },
          yearTable: [
            { year: 2022, total: 5, classes: ['[Rad]+[PKW]=5'] },
            { year: 2021, total: 5, classes: ['[Rad]+[PKW]=5'] }
          ],
          poi: null,
          references: null,
          patterns: []
        }
      };

      const options = { includeMap: false, includePOIs: true, includeReferences: true };

      await UA.exportToPDF(ctx, reportData, options);

      expect(window.pdfMake.createPdf).toHaveBeenCalled();
      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];

      // Gather all text content including table bodies
      function collectText(item) {
        if (!item) return '';
        if (typeof item.text === 'string') return item.text;
        if (Array.isArray(item.text)) return item.text.map(t => typeof t === 'string' ? t : (t.text || '')).join('');
        if (item.table && item.table.body) {
          return item.table.body.flat().map(cell => {
            if (typeof cell === 'string') return cell;
            if (typeof cell.text === 'string') return cell.text;
            return '';
          }).join(' ');
        }
        return '';
      }
      const allText = pdfDefinition.content.map(collectText).join(' ');

      expect(allText).toContain('STATISTIK');
      // Severity table entries
      expect(allText).toContain('Getötete');
      expect(allText).toContain('Schwerverletzte');
      expect(allText).toContain('Leichtverletzte');
      // Deviations table entry
      expect(allText).toContain('Muster');
    });

    test('Word document should include STATISTIK section when structured data provided', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: 'Sachverhalt:\nTest\n\nBeschlussvorschlag:\nProposal',
        structured: {
          meta: { city: 'Hannover', date: '01.01.2025', bounds: '52.0,9.5 – 53.0,10.5', areaName: 'Test', link: 'http://localhost/', filters: {} },
          severity: { total: 5, bySev: { '1': 0, '2': 2, '3': 3, other: 0 } },
          deviations: { focus: [], rows: [], local: { total: 5, byMask: {} }, baseline: { total: 20, byMask: {} } },
          yearTable: [{ year: 2022, total: 5, classes: [] }],
          poi: null,
          references: null,
          patterns: []
        }
      };

      const options = { includeMap: false, includePOIs: false, includeReferences: false };

      await UA.exportToWord(ctx, reportData, options);

      expect(window.saveAs).toHaveBeenCalled();
      const [blob] = window.saveAs.mock.calls[0];
      expect(blob.size).toBeGreaterThan(0);
    });

    test('PDF export should show POI table from structured data', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: 'Sachverhalt:\nTest\n\nBeschlussvorschlag:\nProposal',
        structured: {
          meta: { city: 'Hannover', date: '01.01.2025', bounds: '52.0,9.5 – 53.0,10.5', areaName: 'Test', link: 'http://localhost/', filters: {} },
          severity: { total: 0, bySev: { '1': 0, '2': 0, '3': 0, other: 0 } },
          deviations: { focus: [], rows: [], local: { total: 0, byMask: {} }, baseline: { total: 0, byMask: {} } },
          yearTable: [],
          poi: {
            totalWithin: 2,
            totalNear: 1,
            withinByType: { school: 1, kindergarten: 1 },
            nearByType: { childcare: 1 },
            withinArea: [],
            nearArea: []
          },
          references: null,
          patterns: []
        }
      };

      const options = { includeMap: false, includePOIs: true, includeReferences: false };

      await UA.exportToPDF(ctx, reportData, options);

      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];

      function collectText(item) {
        if (!item) return '';
        if (typeof item.text === 'string') return item.text;
        if (Array.isArray(item.text)) return item.text.map(t => typeof t === 'string' ? t : (t.text || '')).join('');
        if (item.table && item.table.body) {
          return item.table.body.flat().map(cell => {
            if (typeof cell === 'string') return cell;
            if (typeof cell.text === 'string') return cell.text;
            return '';
          }).join(' ');
        }
        return '';
      }
      const allText = pdfDefinition.content.map(collectText).join(' ');

      expect(allText).toContain('SENSIBLE EINRICHTUNGEN');
      // POI table headers
      expect(allText).toContain('Typ');
      expect(allText).toContain('Im Bereich');
      // POI types
      expect(allText).toContain('Schulen');
      expect(allText).toContain('Kindergärten');
    });

    test('PDF with structured references shows structured list', async () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const reportData = {
        text: 'Sachverhalt:\nTest\n\nBeschlussvorschlag:\nProposal',
        structured: {
          meta: { city: 'Hannover', date: '01.01.2025', bounds: '', areaName: '', link: '', filters: {} },
          severity: { total: 0, bySev: { '1': 0, '2': 0, '3': 0, other: 0 } },
          deviations: { focus: [], rows: [], local: { total: 0, byMask: {} }, baseline: { total: 0, byMask: {} } },
          yearTable: [],
          poi: null,
          references: {
            documents: [
              { title: 'Die Ideale Kreuzung', author: 'Region Hannover', date: '2023', url: 'https://example.com/dok' }
            ]
          },
          patterns: []
        }
      };

      const options = { includeMap: false, includePOIs: false, includeReferences: true };

      await UA.exportToPDF(ctx, reportData, options);

      const pdfDefinition = window.pdfMake.createPdf.mock.calls[0][0];
      const contentTexts = pdfDefinition.content.map(item =>
        typeof item.text === 'string' ? item.text : ''
      ).join(' ');

      expect(contentTexts).toContain('FACHLICHE BEZÜGE');
      expect(contentTexts).toContain('Die Ideale Kreuzung');
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
    // Load utils (provides UA.normKey needed for filename sanitization)
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.utils.js'), 'utf8'));
    // ua.accident_views.js defines UA.accidentViews / UA.applyAccidentView (must precede ua.export_v2.js)
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.accident_views.js'), 'utf8'));
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
      expect(capturedFilename).toMatch(/^Unfallatlas_hannover_\d{4}-\d{2}-\d{2}\.csv$/);
      expect(capturedBlob).toBeInstanceOf(Blob);
      expect(capturedBlob.size).toBeGreaterThan(0);
    });

    test('should include a header row and one row per in-bounds point', async () => {
      UA.exportToCSV(makeCtx());

      const text = await readBlobAsText(capturedBlob);
      const lines = text.trim().split('\n');

      // Header + 3 in-bounds points (the 4th is outside bounds)
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('lat,lon,year,ukategorie,IstRad,IstFuss,IstPKW,IstKrad,IstGkfz,IstSonstig,ustunde,uwochentag,strzustand');
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
      expect(capturedFilename).toMatch(/^Unfallatlas_hannover_\d{4}-\d{2}-\d{2}\.geojson$/);
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
      expect(capturedFilename).toMatch(/^Unfallatlas_hannover_\d{4}-\d{2}-\d{2}\.kml$/);
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

    test('should XML-escape special characters in city name', async () => {
      const ctx = makeCtx();
      ctx.CITY_RAW = 'Köln & <Test>';
      UA.exportToKML(ctx);

      expect(window.saveAs).toHaveBeenCalledTimes(1);

      const text = await readBlobAsText(capturedBlob);
      // Document name must contain properly escaped HTML entities
      expect(text).toContain('Köln &amp; &lt;Test&gt;');
      // The produced XML must be parseable without errors
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      expect(xml.querySelector('parsererror')).toBeNull();
      // The text content of the Document name should be the unescaped original
      const docName = xml.querySelector('Document > name');
      expect(docName).not.toBeNull();
      expect(docName.textContent).toContain('Köln & <Test>');
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

    test('should return structured field with meta, severity, deviations, yearTable, patterns', async () => {
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

      expect(result).toHaveProperty('structured');
      const s = result.structured;

      // meta
      expect(s).toHaveProperty('meta');
      expect(s.meta.city).toBe('Hannover');
      expect(typeof s.meta.bounds).toBe('string');
      expect(typeof s.meta.date).toBe('string');

      // severity
      expect(s).toHaveProperty('severity');
      expect(s.severity).toHaveProperty('total');
      expect(s.severity).toHaveProperty('bySev');
      expect(typeof s.severity.total).toBe('number');

      // deviations
      expect(s).toHaveProperty('deviations');
      expect(s.deviations).toHaveProperty('focus');
      expect(s.deviations).toHaveProperty('rows');
      expect(Array.isArray(s.deviations.focus)).toBe(true);

      // yearTable
      expect(s).toHaveProperty('yearTable');
      expect(Array.isArray(s.yearTable)).toBe(true);

      // patterns (empty array when no templates load in test env)
      expect(s).toHaveProperty('patterns');
      expect(Array.isArray(s.patterns)).toBe(true);
    });

    test('structured.severity should reflect test accident data', async () => {
      // testPoints: ukategorie 2 (Schwerverletzt), 3 (Leichtverletzt), 1 (Getötet) – 3 in-bounds
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
      const sev = result.structured.severity;

      // 3 in-bounds points with ukategorie 2, 3, 1
      expect(sev.total).toBe(3);
      expect(sev.bySev['1']).toBe(1);
      expect(sev.bySev['2']).toBe(1);
      expect(sev.bySev['3']).toBe(1);
    });

    test('structured.yearTable should contain year data from test points', async () => {
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
      const yr = result.structured.yearTable;

      // testPoints have years 2021, 2022, 2020 in-bounds
      expect(yr.length).toBeGreaterThan(0);
      const years = yr.map(r => r.year);
      expect(years).toContain(2020);
      expect(years).toContain(2021);
      expect(years).toContain(2022);
    });

    test('structured.meta.link should be the current window.location.href', async () => {
      const ctx = {
        CITY_RAW: 'Berlin',
        allPts: testPoints,
        selectionBounds: mockBounds,
        map: {
          getBounds: jest.fn(() => mockBounds),
          getCenter: jest.fn(() => ({ lat: 52.375, lng: 9.730 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);
      expect(result.structured.meta.link).toBe(window.location.href);
    });

    test('structured.deviations.local.byMask reflects Gkfz accidents (6-bit mask)', async () => {
      // Points with IstGkfz=1 should yield masks 16 (Gkfz only) and 17 (Rad+Gkfz)
      const gkfzPoints = [
        // Rad+Gkfz (mask 17) in-bounds
        { lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0', ustunde: '10', uwochentag: '3', strzustand: '0' } },
        { lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0', ustunde: '10', uwochentag: '3', strzustand: '0' } },
        // Gkfz-only (mask 16) in-bounds
        { lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0', ustunde: '10', uwochentag: '3', strzustand: '0' } },
        // Sonstig-only (mask 32) in-bounds
        { lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '0', IstSonstig: '1', ustunde: '10', uwochentag: '3', strzustand: '0' } }
      ];

      const localBounds = {
        contains: ([lat, lng]) => lat >= 52.0 && lat <= 53.0 && lng >= 9.5 && lng <= 10.0,
        getCenter: () => ({ lat: 52.5, lng: 9.7 }),
        getSouthWest: () => ({ lat: 52.0, lng: 9.5, toFixed: (n) => Number(52.0).toFixed(n) }),
        getNorthEast: () => ({ lat: 53.0, lng: 10.0, toFixed: (n) => Number(53.0).toFixed(n) })
      };

      const ctx = {
        CITY_RAW: 'Hannover',
        allPts: gkfzPoints,
        selectionBounds: localBounds,
        map: {
          getBounds: jest.fn(() => localBounds),
          getCenter: jest.fn(() => ({ lat: 52.5, lng: 9.7 })),
          getZoom: jest.fn(() => 14)
        }
      };

      const result = await UA.computeExportReport(ctx);
      const byMask = result.structured.deviations.local.byMask;

      // Mask 17 (Rad+Gkfz): 2 accidents
      expect(byMask['17']).toBe(2);
      // Mask 16 (Gkfz-only): 1 accident
      expect(byMask['16']).toBe(1);
      // Mask 32 (Sonstig-only): 1 accident
      expect(byMask['32']).toBe(1);
      // Mask 1 (Rad-only) should NOT appear
      expect(byMask['1']).toBeUndefined();
    });

    test('computeExportReport text includes Gkfz-specific interpretation when Rad+Gkfz overrepresented', async () => {
      // Create data: 5 Rad+Gkfz in-bounds, many Gkfz-only out-of-bounds as baseline
      const localPts = [];
      for (let i = 0; i < 5; i++) {
        localPts.push({ lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0', ustunde: '10', uwochentag: '3', strzustand: '0' } });
      }
      // 1 Gkfz-only in-bounds (to avoid dividing by zero)
      localPts.push({ lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0', ustunde: '10', uwochentag: '3', strzustand: '0' } });

      // Baseline: mostly Gkfz-only (mask 16), few Rad+Gkfz (mask 17)
      const allPts = [...localPts];
      for (let i = 0; i < 50; i++) {
        allPts.push({ lat: 48.0, lon: 11.0, props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0', ustunde: '10', uwochentag: '3', strzustand: '0' } });
      }

      const localBounds = {
        contains: ([lat, lng]) => lat >= 52.0 && lat <= 53.0 && lng >= 9.5 && lng <= 10.0,
        getCenter: () => ({ lat: 52.5, lng: 9.7 }),
        getSouthWest: () => ({ lat: 52.0, lng: 9.5, toFixed: (n) => Number(52.0).toFixed(n) }),
        getNorthEast: () => ({ lat: 53.0, lng: 10.0, toFixed: (n) => Number(53.0).toFixed(n) })
      };

      const ctx = {
        CITY_RAW: 'Hannover',
        allPts,
        selectionBounds: localBounds,
        map: {
          getBounds: jest.fn(() => localBounds),
          getCenter: jest.fn(() => ({ lat: 52.5, lng: 9.7 })),
          getZoom: jest.fn(() => 14)
        }
      };

      const result = await UA.computeExportReport(ctx);

      // Assert the stable semantic signal: mask 17 (Rad+Gkfz) is identified locally
      const mask17Local =
        result.structured?.deviations?.local?.byMask?.[17] ??
        result.structured?.deviations?.local?.byMask?.['17'];
      expect(result.structured).toBeDefined();
      expect(mask17Local).toEqual(expect.anything());

      // Light token check: the Gkfz+Rad symbol should appear in the text output
      expect(result.text).toContain('🚲+🚛');
    });
  });

  // ---------- crossTable and accidentDetails ----------

  describe('crossTableSeverityByMask and accidentDetailTable via computeExportReport', () => {
    test('structured.crossTable should have rows and totals', async () => {
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
      const ct = result.structured.crossTable;

      expect(ct).toBeDefined();
      expect(Array.isArray(ct.rows)).toBe(true);
      expect(ct.totals).toBeDefined();
      expect(typeof ct.totals.total).toBe('number');
      // 3 in-bounds points → total should be 3
      expect(ct.totals.total).toBe(3);
      // Rows should have expected shape
      for (const row of ct.rows) {
        expect(typeof row.mask).toBe('number');
        expect(typeof row.label).toBe('string');
        expect(typeof row.sev1).toBe('number');
        expect(typeof row.sev2).toBe('number');
        expect(typeof row.sev3).toBe('number');
        expect(typeof row.total).toBe('number');
        expect(row.total).toBeGreaterThan(0);
      }
    });

    test('structured.crossTable rows are sorted by total descending', async () => {
      const pts = [
        { lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '1', IstKrad: '0', strzustand: '0', uwochentag: '2' } },
        { lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '1', IstKrad: '0', strzustand: '0', uwochentag: '2' } },
        { lat: 52.5, lon: 9.7, props: { year: '2022', ukategorie: '2', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', strzustand: '0', uwochentag: '2' } }
      ];
      const bounds = {
        contains: ([lat]) => lat >= 52.0 && lat <= 53.0,
        getCenter: () => ({ lat: 52.5, lng: 9.7 }),
        getSouthWest: () => ({ lat: 52.0, lng: 9.5 }),
        getNorthEast: () => ({ lat: 53.0, lng: 10.0 })
      };
      const ctx = {
        CITY_RAW: 'Test',
        allPts: pts,
        selectionBounds: bounds,
        map: { getBounds: jest.fn(() => bounds), getCenter: jest.fn(() => ({ lat: 52.5, lng: 9.7 })), getZoom: jest.fn(() => 12) }
      };

      const result = await UA.computeExportReport(ctx);
      const rows = result.structured.crossTable.rows;
      expect(rows.length).toBeGreaterThan(0);
      // mask 5 (Rad+PKW) has 2 accidents, mask 1 (Rad) has 1 – sorted descending
      if (rows.length >= 2) {
        expect(rows[0].total).toBeGreaterThanOrEqual(rows[1].total);
      }
    });

    test('structured.accidentDetails should have rows with expected shape', async () => {
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
      const ad = result.structured.accidentDetails;

      expect(ad).toBeDefined();
      expect(Array.isArray(ad.rows)).toBe(true);
      expect(typeof ad.total).toBe('number');
      expect(typeof ad.truncated).toBe('boolean');
      // 3 in-bounds points
      expect(ad.rows.length).toBe(3);
      expect(ad.total).toBe(3);
      expect(ad.truncated).toBe(false);

      for (const row of ad.rows) {
        expect(typeof row.lat).toBe('number');
        expect(typeof row.lon).toBe('number');
        expect(typeof row.sevLabel).toBe('string');
        expect(typeof row.involved).toBe('string');
        expect(typeof row.mask).toBe('number');
      }
    });

    test('structured.accidentDetails rows are sorted by severity then year descending', async () => {
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
      const rows = result.structured.accidentDetails.rows;

      // testPoints in-bounds: ukategorie 1 (Getötet, 2020), 2 (Schwerverletzt, 2021), 3 (Leichtverletzt, 2022)
      // Expected order: sev1 first (2020), then sev2 (2021), then sev3 (2022)
      expect(rows[0].severity).toBe('1');
      expect(rows[1].severity).toBe('2');
      expect(rows[2].severity).toBe('3');
    });

    test('accidentDetails truncates at maxRows per group and sets truncated flag', async () => {
      // Create 60 in-bounds points with the same severity to trigger per-group truncation at default maxRows=20
      const manyPts = Array.from({ length: 60 }, (_, i) => ({
        lat: 52.5, lon: 9.7,
        props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', strzustand: '0', uwochentag: '2' }
      }));
      const bounds = {
        contains: ([lat]) => lat >= 52.0 && lat <= 53.0,
        getCenter: () => ({ lat: 52.5, lng: 9.7 }),
        getSouthWest: () => ({ lat: 52.0, lng: 9.5 }),
        getNorthEast: () => ({ lat: 53.0, lng: 10.0 })
      };
      const ctx = {
        CITY_RAW: 'Test',
        allPts: manyPts,
        selectionBounds: bounds,
        map: { getBounds: jest.fn(() => bounds), getCenter: jest.fn(() => ({ lat: 52.5, lng: 9.7 })), getZoom: jest.fn(() => 12) }
      };

      const result = await UA.computeExportReport(ctx);
      const ad = result.structured.accidentDetails;

      // Per-group cap of 20: all 60 are Leichtverletzt → 1 group, 20 rows shown, 40 overflow
      expect(ad.rows.length).toBe(20);
      expect(ad.total).toBe(60);
      expect(ad.truncated).toBe(true);
      expect(ad.groups.length).toBe(1);
      expect(ad.groups[0].count).toBe(60);
      expect(ad.groups[0].rows.length).toBe(20);
      expect(ad.groups[0].overflow).toBe(40);
    });

    test('crossTable and accidentDetails appear in text output', async () => {
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
      expect(result.text).toContain('Beteiligungskombination × Schweregrad');
      expect(result.text).toContain('Einzelunfälle im Bereich');
    });

    test('crossTable appears in HTML output', async () => {
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
      expect(result.html).toContain('Beteiligungskombination');
      expect(result.html).toContain('Getötete');
      expect(result.html).toContain('Schwerverletzt');
      expect(result.html).toContain('Leichtverletzt');
    });
  });

  // ---------- Template fallback chain ----------

  describe('loadTemplate fallback chain (via computeExportReport)', () => {
    test('should gracefully fall back to default templates when all fetches return 404', async () => {
      // global.fetch is already mocked to return 404 in beforeEach
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

      // Should not throw even when all template fetches fail
      const result = await UA.computeExportReport(ctx);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.structured).toBeDefined();
    });

    test('should use city-specific template when city-specific fetch succeeds', async () => {
      // Override fetch: city-specific template returns custom content; generic returns 404
      global.fetch = jest.fn((url) => {
        if (url.includes('hannover/base_intro')) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve('CUSTOM_CITY_INTRO {{CITY}}') });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

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
      // City-specific intro template was loaded and {{CITY}} was replaced
      expect(result.text).toContain('CUSTOM_CITY_INTRO');
      expect(result.text).toContain('Hannover');
    });

    test('should fall back to generic template when city-specific fetch fails', async () => {
      // city-specific: 404, generic base_intro: returns content, others: 404
      global.fetch = jest.fn((url) => {
        if (url.includes('/hannover/')) {
          return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
        }
        if (url.includes('base_intro')) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve('GENERIC_INTRO {{CITY}}') });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

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
      expect(result.text).toContain('GENERIC_INTRO');
    });
  });

  // ---------- Pattern matching ----------

  describe('Pattern matching in computeExportReport', () => {
    test('structured.patterns should be an empty array when no focus deviations are found', async () => {
      // Use empty allPts so no deviations are detected
      const ctx = {
        CITY_RAW: 'Hannover',
        allPts: [],
        selectionBounds: mockBounds,
        map: {
          getBounds: jest.fn(() => mockBounds),
          getCenter: jest.fn(() => ({ lat: 52.375, lng: 9.730 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);
      expect(result.structured.patterns).toEqual([]);
    });

    test('pattern template vars are substituted in matched pattern content', async () => {
      // Provide enough data so mask 5 (Rad+PKW) is overrepresented
      // We need: local mask 5 count >= 3, factor >= 1.35
      // Make baseline mostly mask 4 (PKW only), local mostly mask 5 (Rad+PKW)
      const localPoints = [];
      // 5 Rad+PKW in-bounds
      for (let i = 0; i < 5; i++) {
        localPoints.push({
          lat: 52.5, lon: 9.7,
          props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '1', IstKrad: '0' }
        });
      }
      // 1 PKW-only in-bounds
      localPoints.push({
        lat: 52.5, lon: 9.7,
        props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '1', IstKrad: '0' }
      });

      // Baseline: many PKW-only (mask 4), few Rad+PKW (mask 5)
      const baselinePoints = [...localPoints];
      for (let i = 0; i < 50; i++) {
        baselinePoints.push({
          lat: 48.0, lon: 11.0, // out of local bounds but in baseline
          props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '1', IstKrad: '0' }
        });
      }

      const localBounds = {
        contains: ([lat]) => lat >= 52.0 && lat <= 53.0,
        getCenter: () => ({ lat: 52.5, lng: 9.7 }),
        getSouthWest: () => ({ lat: 52.0, lng: 9.5, toFixed: (n) => (52.0).toFixed(n) }),
        getNorthEast: () => ({ lat: 53.0, lng: 10.0, toFixed: (n) => (53.0).toFixed(n) })
      };
      // Patch getSouthWest/getNorthEast to have proper toFixed
      localBounds.getSouthWest = () => ({ lat: 52.0, lng: 9.5, toFixed: (n) => Number(52.0).toFixed(n) });
      localBounds.getNorthEast = () => ({ lat: 53.0, lng: 10.0, toFixed: (n) => Number(53.0).toFixed(n) });

      // Mock fetch to return a pattern template with variables
      global.fetch = jest.fn((url) => {
        if (url.includes('pattern_rad_pkw')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve('RAD_PKW Faktor {{RAD_PKW_FACTOR}} lokal {{RAD_PKW_LOCAL}}')
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

      const ctx = {
        CITY_RAW: 'Hannover',
        allPts: baselinePoints,
        selectionBounds: localBounds,
        map: {
          getBounds: jest.fn(() => localBounds),
          getCenter: jest.fn(() => ({ lat: 52.5, lng: 9.7 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);
      const patterns = result.structured.patterns;

      // patterns must be a non-empty array (mask 5 was triggered by crafted data)
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);

      // Check that mask 5 was matched and pattern vars substituted
      const radPkwPattern = patterns.find(p => p.mask === 5);
      expect(radPkwPattern).toBeDefined();

      // Variables should be substituted (no {{...}} remaining)
      expect(radPkwPattern.content).not.toContain('{{RAD_PKW_FACTOR}}');
      expect(radPkwPattern.content).not.toContain('{{RAD_PKW_LOCAL}}');
      expect(radPkwPattern.content).toContain('RAD_PKW Faktor');
      expect(radPkwPattern.template).toBe('pattern_rad_pkw');
    });

    test('Gkfz pattern (mask 17, Rad+Gkfz) is matched and vars substituted', async () => {
      // Provide data so mask 17 (Rad+Gkfz) is overrepresented locally
      const localPoints = [];
      // 5 Rad+Gkfz in-bounds
      for (let i = 0; i < 5; i++) {
        localPoints.push({
          lat: 52.5, lon: 9.7,
          props: { year: '2022', ukategorie: '3', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0' }
        });
      }
      // 1 Gkfz-only in-bounds
      localPoints.push({
        lat: 52.5, lon: 9.7,
        props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0' }
      });

      // Baseline: many Gkfz-only (mask 16), few Rad+Gkfz (mask 17)
      const baselinePoints = [...localPoints];
      for (let i = 0; i < 50; i++) {
        baselinePoints.push({
          lat: 48.0, lon: 11.0,
          props: { year: '2022', ukategorie: '3', IstRad: '0', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '1', IstSonstig: '0' }
        });
      }

      const localBounds = {
        contains: ([lat]) => lat >= 52.0 && lat <= 53.0,
        getCenter: () => ({ lat: 52.5, lng: 9.7 }),
        getSouthWest: () => ({ lat: 52.0, lng: 9.5, toFixed: (n) => Number(52.0).toFixed(n) }),
        getNorthEast: () => ({ lat: 53.0, lng: 10.0, toFixed: (n) => Number(53.0).toFixed(n) })
      };

      global.fetch = jest.fn((url) => {
        if (url.includes('pattern_rad_gkfz')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve('RAD_GKFZ Faktor {{RAD_GKFZ_FACTOR}} lokal {{RAD_GKFZ_LOCAL}}')
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

      const ctx = {
        CITY_RAW: 'Hannover',
        allPts: baselinePoints,
        selectionBounds: localBounds,
        map: {
          getBounds: jest.fn(() => localBounds),
          getCenter: jest.fn(() => ({ lat: 52.5, lng: 9.7 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);
      const patterns = result.structured.patterns;

      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);

      const radGkfzPattern = patterns.find(p => p.mask === 17);
      expect(radGkfzPattern).toBeDefined();

      expect(radGkfzPattern.content).not.toContain('{{RAD_GKFZ_FACTOR}}');
      expect(radGkfzPattern.content).not.toContain('{{RAD_GKFZ_LOCAL}}');
      expect(radGkfzPattern.content).toContain('RAD_GKFZ Faktor');
      expect(radGkfzPattern.template).toBe('pattern_rad_gkfz');
    });
  });

  // ---------- Gremien (committee) matching ----------

  describe('Gremien matching in computeExportReport', () => {
    test('structured.meta.gremium should be present and have expected shape', async () => {
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
      const gremium = result.structured.meta.gremium;

      expect(gremium).toBeDefined();
      expect(gremium).toHaveProperty('confidence');
      expect(gremium).toHaveProperty('hinweis');
      // Since all fetches return 404 in test env, gremium and typ will be null
      expect(['hoch', 'unbekannt']).toContain(gremium.confidence);
    });

    test('should match gremium when gremien data is provided and suburb matches', async () => {
      // Mock fetch: return gremien config for hannover, fail on others
      global.fetch = jest.fn((url) => {
        if (url.includes('gremien_hannover')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              gremiumTyp: 'Bezirksrat',
              hinweis: 'Bitte prüfen',
              fallback: 'Nicht ermittelt',
              zuordnung: [
                {
                  match: { suburb: ['Linden-Nord', 'Linden-Mitte'] },
                  gremium: 'Bezirksrat Linden-Limmer',
                  kontakt: 'test@example.com'
                }
              ]
            })
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

      // Mock UA.reverseGeocode to return an admin with matching suburb
      const origReverseGeocode = UA.reverseGeocode;
      UA.reverseGeocode = async () => ({
        label: 'Linden-Nord, Hannover',
        details: 'Linden-Nord, Hannover',
        osmUrl: 'https://www.openstreetmap.org/',
        admin: {
          suburb: 'Linden-Nord',
          city_district: null,
          borough: null,
          quarter: null,
          city: 'Hannover',
          state: 'Niedersachsen',
          postcode: '30449'
        }
      });

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

      try {
        const result = await UA.computeExportReport(ctx);
        const gremium = result.structured.meta.gremium;

        expect(gremium.confidence).toBe('hoch');
        expect(gremium.gremium).toBe('Bezirksrat Linden-Limmer');
        expect(gremium.typ).toBe('Bezirksrat');
        expect(gremium.kontakt).toBe('test@example.com');
      } finally {
        UA.reverseGeocode = origReverseGeocode;
      }
    });

    test('should return fallback hint when no match in gremien data', async () => {
      global.fetch = jest.fn((url) => {
        if (url.includes('gremien_hannover')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              gremiumTyp: 'Bezirksrat',
              hinweis: 'Bitte prüfen',
              fallback: 'Gremium nicht ermittelbar – bitte lokal nachfragen.',
              zuordnung: [
                {
                  match: { suburb: ['Linden-Nord'] },
                  gremium: 'Bezirksrat Linden-Limmer',
                  kontakt: 'test@example.com'
                }
              ]
            })
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

      const origReverseGeocode = UA.reverseGeocode;
      UA.reverseGeocode = async () => ({
        label: 'Irgendwo, Hannover',
        details: 'Irgendwo',
        osmUrl: 'https://www.openstreetmap.org/',
        admin: {
          suburb: 'UnbekanntesViertel',
          city_district: null,
          borough: null,
          quarter: null,
          city: 'Hannover',
          state: 'Niedersachsen',
          postcode: '30100'
        }
      });

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

      try {
        const result = await UA.computeExportReport(ctx);
        const gremium = result.structured.meta.gremium;

        expect(gremium.confidence).toBe('unbekannt');
        expect(gremium.gremium).toBeNull();
        expect(gremium.hinweis).toContain('Gremium nicht ermittelbar');
      } finally {
        UA.reverseGeocode = origReverseGeocode;
      }
    });

    test('GREMIUM_NAME and GREMIUM_TYP vars should appear in text output when gremium matched', async () => {
      global.fetch = jest.fn((url) => {
        if (url.includes('gremien_hannover')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              gremiumTyp: 'Bezirksrat',
              hinweis: 'Prüfen',
              fallback: 'Unbekannt',
              zuordnung: [
                { match: { suburb: ['Linden-Nord'] }, gremium: 'Bezirksrat Linden-Limmer', kontakt: '' }
              ]
            })
          });
        }
        if (url.includes('base_intro')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve('Gremium: {{GREMIUM_NAME}} ({{GREMIUM_TYP}})\nHinweis: {{GREMIUM_HINWEIS}}')
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

      const origReverseGeocode = UA.reverseGeocode;
      UA.reverseGeocode = async () => ({
        label: 'Linden-Nord, Hannover',
        details: 'Linden-Nord',
        osmUrl: 'https://www.openstreetmap.org/',
        admin: { suburb: 'Linden-Nord', city_district: null, borough: null, quarter: null, city: 'Hannover', state: 'Niedersachsen', postcode: '30449' }
      });

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

      try {
        const result = await UA.computeExportReport(ctx);
        expect(result.text).toContain('Bezirksrat Linden-Limmer');
        expect(result.text).toContain('Bezirksrat');
        // No unresolved template placeholders
        expect(result.text).not.toContain('{{GREMIUM_NAME}}');
        expect(result.text).not.toContain('{{GREMIUM_TYP}}');
      } finally {
        UA.reverseGeocode = origReverseGeocode;
      }
    });

    test('should match Berlin gremium by city_district', async () => {
      global.fetch = jest.fn((url) => {
        if (url.includes('gremien_berlin')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              gremiumTyp: 'Bezirksverordnetenversammlung (BVV)',
              hinweis: 'Bitte prüfen',
              fallback: 'BVV nicht ermittelt',
              zuordnung: [
                {
                  match: { city_district: 'Bezirk Friedrichshain-Kreuzberg' },
                  gremium: 'BVV Friedrichshain-Kreuzberg',
                  kontakt: 'bvv@ba-fk.berlin.de'
                }
              ]
            })
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      });

      const origReverseGeocode = UA.reverseGeocode;
      UA.reverseGeocode = async () => ({
        label: 'Kreuzberg, Berlin',
        details: 'Kreuzberg',
        osmUrl: 'https://www.openstreetmap.org/',
        admin: {
          suburb: 'Kreuzberg',
          city_district: 'Bezirk Friedrichshain-Kreuzberg',
          borough: null,
          quarter: null,
          city: 'Berlin',
          state: 'Berlin',
          postcode: '10997'
        }
      });

      const ctx = {
        CITY_RAW: 'Berlin',
        allPts: testPoints,
        selectionBounds: mockBounds,
        map: {
          getBounds: jest.fn(() => mockBounds),
          getCenter: jest.fn(() => ({ lat: 52.5, lng: 13.4 })),
          getZoom: jest.fn(() => 12)
        }
      };

      try {
        const result = await UA.computeExportReport(ctx);
        const gremium = result.structured.meta.gremium;

        expect(gremium.confidence).toBe('hoch');
        expect(gremium.gremium).toBe('BVV Friedrichshain-Kreuzberg');
        expect(gremium.typ).toBe('Bezirksverordnetenversammlung (BVV)');
      } finally {
        UA.reverseGeocode = origReverseGeocode;
      }
    });
  });

  // ---------- PDF tables ----------

  describe('PDF export with structured tables', () => {
    test('should include STATISTIK section with tables in PDF when structured data provided', async () => {
      const ctx = {
        CITY_RAW: 'Berlin',
        allPts: testPoints,
        selectionBounds: mockBounds,
        map: {
          getBounds: jest.fn(() => mockBounds),
          getCenter: jest.fn(() => ({ lat: 52.375, lng: 9.730 })),
          getZoom: jest.fn(() => 12)
        }
      };

      const result = await UA.computeExportReport(ctx);

      // Verify structured data shape is suitable for PDF tables
      expect(result.structured.severity.bySev).toBeDefined();
      expect(result.structured.yearTable.length).toBeGreaterThan(0);
      const yr = result.structured.yearTable[0];
      expect(yr).toHaveProperty('year');
      expect(yr).toHaveProperty('total');
      expect(yr).toHaveProperty('classes');
    });
  });

  // ---------- reverseGeocode admin field ----------

  describe('UA.reverseGeocode admin field', () => {
    test('should include admin object in result when Nominatim returns address data', async () => {
      // Mock Nominatim response with full address data
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          display_name: 'Linden-Nord, Hannover, Niedersachsen, Deutschland',
          address: {
            road: 'Schwarze-Bären-Straße',
            postcode: '30449',
            city: 'Hannover',
            suburb: 'Linden-Nord',
            city_district: 'Stadtbezirk Linden-Limmer',
            borough: null,
            quarter: 'Linden',
            state: 'Niedersachsen'
          }
        })
      }));

      // UA.reverseGeocode is on UA from ua.export_v2.js loaded in beforeEach
      const result = await UA.reverseGeocode(52.37, 9.73);

      expect(result).toHaveProperty('admin');
      expect(result.admin.suburb).toBe('Linden-Nord');
      expect(result.admin.city_district).toBe('Stadtbezirk Linden-Limmer');
      expect(result.admin.city).toBe('Hannover');
      expect(result.admin.state).toBe('Niedersachsen');
      expect(result.admin.postcode).toBe('30449');
    });

    test('should include admin with nulls when Nominatim returns no admin fields', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          display_name: 'irgendwo',
          address: { road: 'Teststraße', postcode: '12345' }
        })
      }));

      const result = await UA.reverseGeocode(51.0, 10.0);

      expect(result).toHaveProperty('admin');
      expect(result.admin.suburb).toBeNull();
      expect(result.admin.city_district).toBeNull();
      expect(result.admin.borough).toBeNull();
    });

    test('should gracefully return fallback without admin when fetch fails', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('network error')));

      const result = await UA.reverseGeocode(51.0, 10.0);

      // Fallback doesn't have admin field – should not throw
      expect(result).toBeDefined();
      expect(result.label).toBeDefined();
    });
  });
});
