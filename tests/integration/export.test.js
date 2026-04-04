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
