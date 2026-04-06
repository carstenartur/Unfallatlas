/**
 * Unit tests for ua.report_v2.js export functions
 * Uses real export libraries (docx, pdfmake) instead of mocks.
 */

describe('UA.report_v2 - Export Functions', () => {
  let UA;
  let mockLeafletImage;
  let mockCanvas;

  beforeEach(() => {
    // Setup mock canvas (leafletImage needs a real Leaflet map / Canvas API)
    mockCanvas = {
      toDataURL: jest.fn(() => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
    };

    // leafletImage mock (needs real Leaflet map, not available in jsdom)
    mockLeafletImage = jest.fn((map, callback) => {
      setTimeout(() => callback(null, mockCanvas), 50);
    });

    // Set real export libraries directly on window (global.window = {...} does not work in jsdom).
    // saveAs is kept as a spy – we validate the blob passed to it, not the browser download itself.
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;

    window.UA = {};
    window.leafletImage = mockLeafletImage;
    window.docx = require('docx');
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();

    // Load the module - using eval because files use IIFE pattern
    // Files are loaded from project root: js/ua.report_v2.js
    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    // eval the module; since window.* properties are already set on jsdom's window,
    // the IIFE inside the file will pick them up correctly.
    eval(fs.readFileSync(filePath, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.leafletImage;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  describe('captureMapImage', () => {
    test('should capture map image successfully', async () => {
      const mockMap = {
        getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
        getZoom: jest.fn(() => 12)
      };
      const ctx = { map: mockMap };

      // Ensure leafletImage is available
      window.leafletImage = mockLeafletImage;

      const result = await UA.captureMapImage(ctx);

      expect(result).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
      expect(mockLeafletImage).toHaveBeenCalledWith(mockMap, expect.any(Function));
    });

    test('should reject if leaflet-image is not loaded', async () => {
      delete window.leafletImage;
      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('leaflet-image library not loaded');
    });

    test('should reject if leaflet-image returns error', async () => {
      const error = new Error('Image capture failed');
      window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(error, null), 50);
      });

      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('Image capture failed');
    });

    test('should reject if canvas toDataURL fails', async () => {
      // Reset leafletImage to normal behavior for this test
      window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 50);
      });
      mockCanvas.toDataURL = jest.fn(() => { throw new Error('Canvas error'); });
      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('Canvas error');
    });

    test('should reject if data URL is invalid', async () => {
      // Reset leafletImage to normal behavior for this test
      window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 50);
      });
      mockCanvas.toDataURL = jest.fn(() => 'invalid-data-url');
      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('Invalid map image data URL generated');
    });

    test('should bake heatmap opacity into canvas before capture and restore afterward', async () => {
      const pixelData = new Uint8ClampedArray([255, 0, 0, 200, 0, 255, 0, 100]);
      const heatCanvas = {
        width: 2,
        height: 1,
        style: { opacity: "0.5" },
        getContext: jest.fn(() => ({
          getImageData: jest.fn(() => ({ data: pixelData, width: 2, height: 1 })),
          putImageData: jest.fn(),
          createImageData: jest.fn((w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }))
        }))
      };
      const mockMap = { getZoom: jest.fn(() => 12) };
      const ctx = {
        map: mockMap,
        heatLayer: { _canvas: heatCanvas }
      };

      window.leafletImage = jest.fn((map, callback) => {
        // Capture the alpha values during capture to check baking happened
        setTimeout(() => callback(null, mockCanvas), 50);
      });

      // Set UA.heatOpacityForZoom so the fallback is deterministic
      UA.heatOpacityForZoom = jest.fn(() => 0.5);

      const result = await UA.captureMapImage(ctx, {});

      expect(result).toContain('data:image/png;base64,');
      // ctx2d.putImageData should have been called at least twice: once to bake, once to restore
      const ctx2d = heatCanvas.getContext.mock.results[0].value;
      expect(ctx2d.putImageData).toHaveBeenCalledTimes(2);
      // CSS opacity should be restored to its original value
      expect(heatCanvas.style.opacity).toBe("0.5");
    });

    test('should use heatmapExportOpacity from options when provided', async () => {
      const heatCanvas = {
        width: 1,
        height: 1,
        style: { opacity: "0.6" },
        getContext: jest.fn(() => ({
          getImageData: jest.fn(() => ({ data: new Uint8ClampedArray([255, 0, 0, 200]), width: 1, height: 1 })),
          putImageData: jest.fn(),
          createImageData: jest.fn((w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }))
        }))
      };
      const mockMap = { getZoom: jest.fn(() => 12) };
      const ctx = { map: mockMap, heatLayer: { _canvas: heatCanvas } };

      window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 50);
      });

      await UA.captureMapImage(ctx, { heatmapExportOpacity: 0.25 });

      const ctx2d = heatCanvas.getContext.mock.results[0].value;
      // First putImageData call bakes opacity: alpha 200 * 0.25 = 50
      const bakedData = ctx2d.putImageData.mock.calls[0][0];
      expect(bakedData.data[3]).toBe(50);
      // CSS opacity should be restored to original after capture
      expect(heatCanvas.style.opacity).toBe("0.6");
    });
  });

  describe('exportToWord', () => {
    test('should throw error if docx library not loaded', async () => {
      delete window.docx;
      delete window.pdfMake;
      delete window.saveAs;
      // Set the flag to skip library loading  
      UA._exportLibrariesLoaded = true;
      
      const ctx = { CITY_RAW: 'Hannover' };
      const reportData = { text: 'Test report' };

      await expect(UA.exportToWord(ctx, reportData, {})).rejects.toThrow('docx.js library not loaded');
    });

    test('should create Word document with valid blob', async () => {
      // URL.createObjectURL is not implemented in jsdom; define it and restore after
      const origCreateObjectURL = URL.createObjectURL;
      const origRevokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = jest.fn();

      try {
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
        const options = { includeMap: false };

        await UA.exportToWord(ctx, reportData, options);

        // saveAs should be called with a real, non-empty Word document blob
        expect(window.saveAs).toHaveBeenCalled();
        const [blob, filename] = window.saveAs.mock.calls[0];

        // Verify a valid, non-empty blob was produced
        expect(blob.size).toBeGreaterThan(0);
        expect(blob.type).toContain('application/vnd');

        // Verify filename format (fallback title "Antrag zur Verkehrssicherheit" when no meta)
        expect(filename).toMatch(/Antrag.*Hannover.*\.docx/);

        // Verify PK magic bytes (zip/docx format)
        const arrayBuffer = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsArrayBuffer(blob);
        });
        const bytes = new Uint8Array(arrayBuffer);
        expect(bytes[0]).toBe(0x50); // P
        expect(bytes[1]).toBe(0x4B); // K
      } finally {
        // Restore URL methods (jsdom doesn't implement them; avoid leaking mocks)
        if (origCreateObjectURL === undefined) {
          delete URL.createObjectURL;
        } else {
          URL.createObjectURL = origCreateObjectURL;
        }
        if (origRevokeObjectURL === undefined) {
          delete URL.revokeObjectURL;
        } else {
          URL.revokeObjectURL = origRevokeObjectURL;
        }
      }
    });

    test('should use dynamic title from sd.meta.gremium.typ (Bezirksrat → Bezirksratsantrag)', async () => {
      const origCreateObjectURL = URL.createObjectURL;
      const origRevokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = jest.fn();

      try {
        const ctx = { CITY_RAW: 'Hannover' };
        const reportData = {
          text: '',
          structured: {
            meta: {
              city: 'Hannover',
              date: '01.01.2024',
              areaName: 'Testbereich',
              link: 'https://example.com',
              filters: {},
              gremium: { typ: 'Bezirksrat', gremium: 'Bezirksrat Mitte', kontakt: '', hinweis: '' }
            },
            severity: { total: 0, bySev: {} }
          }
        };

        await UA.exportToWord(ctx, reportData, { includeMap: false });

        expect(window.saveAs).toHaveBeenCalled();
        const [, filename] = window.saveAs.mock.calls[0];
        expect(filename).toMatch(/Bezirksratsantrag/);
      } finally {
        if (origCreateObjectURL === undefined) delete URL.createObjectURL;
        else URL.createObjectURL = origCreateObjectURL;
        if (origRevokeObjectURL === undefined) delete URL.revokeObjectURL;
        else URL.revokeObjectURL = origRevokeObjectURL;
      }
    });

    test('should use dynamic title from sd.meta.gremium.typ (BVV → BVV-Antrag), using real template value', async () => {
      const origCreateObjectURL = URL.createObjectURL;
      const origRevokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = jest.fn();

      try {
        const ctx = { CITY_RAW: 'Berlin' };
        const reportData = {
          text: '',
          structured: {
            meta: {
              city: 'Berlin',
              date: '01.01.2024',
              areaName: 'Testbereich',
              link: '',
              filters: {},
              // Use the real template value from gremien_berlin.json (includes "(BVV)" suffix)
              gremium: { typ: 'Bezirksverordnetenversammlung (BVV)', gremium: 'BVV Mitte', kontakt: '', hinweis: '' }
            },
            severity: { total: 0, bySev: {} }
          }
        };

        await UA.exportToWord(ctx, reportData, { includeMap: false });

        expect(window.saveAs).toHaveBeenCalled();
        const [, filename] = window.saveAs.mock.calls[0];
        expect(filename).toMatch(/BVV-Antrag/);
      } finally {
        if (origCreateObjectURL === undefined) delete URL.createObjectURL;
        else URL.createObjectURL = origCreateObjectURL;
        if (origRevokeObjectURL === undefined) delete URL.revokeObjectURL;
        else URL.revokeObjectURL = origRevokeObjectURL;
      }
    });

    test('should render Rahmendaten and Aktive Filter sections when structured meta is provided', async () => {
      const origCreateObjectURL = URL.createObjectURL;
      const origRevokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = jest.fn();

      try {
        const ctx = { CITY_RAW: 'Hannover' };
        const reportData = {
          text: '',
          structured: {
            meta: {
              city: 'Hannover',
              date: '01.01.2024',
              areaName: 'Innenstadt',
              link: 'https://example.com/werkbank',
              filters: {
                severity: 'alle',
                roadCondition: 'trocken',
                involvementMode: 'ODER',
                includeCyclist: true,
                includePedestrian: false
              },
              gremium: {
                typ: 'Bezirksrat',
                gremium: 'Bezirksrat Mitte',
                kontakt: 'kontakt@example.com',
                hinweis: 'Bitte prüfen'
              }
            },
            severity: { total: 5, bySev: { '1': 1, '2': 2, '3': 2 } }
          }
        };

        await UA.exportToWord(ctx, reportData, { includeMap: false });

        expect(window.saveAs).toHaveBeenCalled();
        const [blob, filename] = window.saveAs.mock.calls[0];
        expect(blob.size).toBeGreaterThan(0);
        // Filename should use the derived title
        expect(filename).toMatch(/Bezirksratsantrag/);

        // Inspect the docx XML to verify the new sections are present
        const JSZip = require('jszip');
        const arrayBuffer = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsArrayBuffer(blob);
        });
        const zip = await JSZip.loadAsync(arrayBuffer);
        const documentXml = await zip.file('word/document.xml').async('text');

        // "Rahmendaten" table header should appear in the document XML
        expect(documentXml).toContain('Rahmendaten');
        // "Aktive Filter" table header should appear
        expect(documentXml).toContain('Aktive Filter');
        // Gremium name should appear
        expect(documentXml).toContain('Bezirksrat Mitte');
        // Area name should appear
        expect(documentXml).toContain('Innenstadt');
      } finally {
        if (origCreateObjectURL === undefined) delete URL.createObjectURL;
        else URL.createObjectURL = origCreateObjectURL;
        if (origRevokeObjectURL === undefined) delete URL.revokeObjectURL;
        else URL.revokeObjectURL = origRevokeObjectURL;
      }
    });
  });

  describe('ensureExportLibraries', () => {
    test('should detect pre-loaded real libraries and skip CDN loading', async () => {
      // Real libraries are already set on window in beforeEach.
      // The function should detect them and return without injecting any CDN script tags.
      UA._exportLibrariesLoaded = false;

      const appendChildSpy = jest.spyOn(document.head, 'appendChild');

      await UA.ensureExportLibraries();

      expect(UA._exportLibrariesLoaded).toBe(true);
      // No <script> elements should have been injected (CDN loading was skipped)
      expect(appendChildSpy).not.toHaveBeenCalled();
    });
  });

  describe('exportToPDF', () => {
    test('should throw error if pdfMake library not loaded', async () => {
      delete window.docx;
      delete window.pdfMake;
      delete window.saveAs;
      // Set the flag to skip library loading
      UA._exportLibrariesLoaded = true;
      
      const ctx = { CITY_RAW: 'Hannover' };
      const reportData = { text: 'Test report' };

      await expect(UA.exportToPDF(ctx, reportData, {})).rejects.toThrow('pdfMake library not loaded');
    });

    test('should create PDF with real pdfmake and valid content', async () => {
      // Spy on createPdf to intercept the .download() browser action, while
      // still calling the real pdfmake implementation to validate the document.
      const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
      let capturedDoc;
      const downloadSpy = jest.fn();

      jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
        capturedDoc = realCreatePdf(def); // real PDF generation
        capturedDoc.download = downloadSpy; // intercept browser download
        return capturedDoc;
      });

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
      const options = { includeMap: false };

      await UA.exportToPDF(ctx, reportData, options);

      expect(window.pdfMake.createPdf).toHaveBeenCalled();
      expect(downloadSpy).toHaveBeenCalled();

      // Verify the filename passed to download
      expect(downloadSpy.mock.calls[0][0]).toMatch(/Bezirksratsantrag_Hannover_.*\.pdf/);

      // Verify a real, non-empty PDF is generated (%PDF magic bytes)
      const buffer = await capturedDoc.getBuffer();
      expect(buffer.length).toBeGreaterThan(0);
      expect(String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3])).toBe('%PDF');
    });

    test('should include BEZIRKSRATSANTRAG in PDF document definition', async () => {
      let capturedDefinition;
      const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);

      jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
        capturedDefinition = def;
        const doc = realCreatePdf(def);
        doc.download = jest.fn();
        return doc;
      });

      const ctx = { CITY_RAW: 'Hannover' };
      const reportData = {
        text: 'Sachverhalt:\nTest\n\nBeschlussvorschlag:\nTest'
      };

      await UA.exportToPDF(ctx, reportData, { includeMap: false });

      expect(capturedDefinition).toBeDefined();
      expect(capturedDefinition.content).toBeDefined();
      const allText = capturedDefinition.content
        .map(item => (typeof item.text === 'string' ? item.text : ''))
        .join(' ');
      expect(allText).toContain('BEZIRKSRATSANTRAG');
      expect(allText).toContain('SACHVERHALT');
      expect(allText).toContain('BESCHLUSSVORSCHLAG');
    });
  });

  describe('initReportExportUI', () => {
    // Skip this test as it requires full DOM and module re-loading
    // This is better tested in E2E tests with Playwright
    test.skip('should initialize export UI with event listeners (requires browser env)', () => {
      expect(true).toBe(true);
    });

    test('should warn if export buttons not found', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      global.document = {
        getElementById: jest.fn(() => null)
      };

      const ctx = {};
      UA.initReportExportUI(ctx);

      expect(consoleWarnSpy).toHaveBeenCalledWith('Export buttons or progress element not found in DOM');

      consoleWarnSpy.mockRestore();
      delete global.document;
    });
  });

  // =====================================================================
  // New section tests: crossTable, accidentDetails, emoji fixes, detail map
  // =====================================================================

  // Shared test helpers for the new section tests
  function withObjectURL(fn) {
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = jest.fn();
    return fn().finally(() => {
      if (origCreate === undefined) delete URL.createObjectURL; else URL.createObjectURL = origCreate;
      if (origRevoke === undefined) delete URL.revokeObjectURL; else URL.revokeObjectURL = origRevoke;
    });
  }

  function blobToArrayBuffer(blob) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsArrayBuffer(blob);
    });
  }

  function extractPdfText(definition) {
    return definition.content.flatMap(item => {
      if (typeof item.text === 'string') return [item.text];
      if (item.table) return item.table.body.flat().map(c => c.text || '');
      return [];
    }).join(' ');
  }

  describe('exportToWord – crossTable and accidentDetails sections', () => {
    test('should include cross-table section in Word document when structured.crossTable is present', () =>
      withObjectURL(async () => {
        const ctx = { CITY_RAW: 'Hannover' };
        const reportData = {
          text: '',
          structured: {
            meta: { city: 'Hannover', date: '01.01.2024', areaName: 'Test', link: '', filters: {}, gremium: {} },
            severity: { total: 5, bySev: { '1': 1, '2': 2, '3': 2 } },
            crossTable: {
              rows: [
                { mask: 5, label: '🚲+🚗', sev1: 0, sev2: 3, sev3: 12, total: 15 },
                { mask: 1, label: '🚲', sev1: 0, sev2: 1, sev3: 5, total: 6 }
              ],
              totals: { sev1: 0, sev2: 4, sev3: 17, total: 21 }
            }
          }
        };

        await UA.exportToWord(ctx, reportData, { includeMap: false });

        const [blob] = window.saveAs.mock.calls[0];
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
        const xml = await zip.file('word/document.xml').async('text');

        expect(xml).toContain('Beteiligungskombination');
        expect(xml).toContain('Getötete');
        expect(xml).toContain('Schwerverletzt');
        expect(xml).toContain('Leichtverletzt');
        expect(xml).toContain('Gesamt');
        // Row values should appear
        expect(xml).toContain('15');
        expect(xml).toContain('21');
      }));

    test('should include accident details section in Word document when structured.accidentDetails is present', () =>
      withObjectURL(async () => {
        const ctx = { CITY_RAW: 'Hannover' };
        const reportData = {
          text: '',
          structured: {
            meta: { city: 'Hannover', date: '01.01.2024', areaName: 'Test', link: '', filters: {}, gremium: {} },
            severity: { total: 2, bySev: { '2': 1, '3': 1 } },
            accidentDetails: {
              rows: [
                { lat: 52.3812, lon: 9.7271, year: 2023, severity: '2', sevLabel: 'Schwerverletzt', involved: '🚲+🚗', hour: 8, weekday: 'Mo–Fr', roadCondition: 'trocken', mask: 5 },
                { lat: 52.3810, lon: 9.7268, year: 2022, severity: '3', sevLabel: 'Leichtverletzt', involved: '🚲', hour: 17, weekday: 'Mo–Fr', roadCondition: 'trocken', mask: 1 }
              ],
              total: 2,
              truncated: false
            }
          }
        };

        await UA.exportToWord(ctx, reportData, { includeMap: false });

        const [blob] = window.saveAs.mock.calls[0];
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
        const xml = await zip.file('word/document.xml').async('text');

        expect(xml).toContain('EINZELUNF');  // "EINZELUNFÄLLE" – Ä is encoded in XML
        expect(xml).toContain('Schwerverletzt');
        expect(xml).toContain('Leichtverletzt');
      }));

    test('should include truncation note when accidentDetails.truncated is true', () =>
      withObjectURL(async () => {
        const ctx = { CITY_RAW: 'Hannover' };
        const accDetails = {
          rows: [{ lat: 52.38, lon: 9.73, year: 2022, severity: '3', sevLabel: 'Leichtverletzt', involved: '🚲', hour: 8, weekday: 'Mo–Fr', roadCondition: 'trocken', mask: 1 }],
          total: 60,
          truncated: true
        };
        const reportData = {
          text: '',
          structured: {
            meta: { city: 'Hannover', date: '01.01.2024', areaName: 'Test', link: '', filters: {}, gremium: {} },
            severity: { total: 1, bySev: { '3': 1 } },
            accidentDetails: accDetails
          }
        };
        const expectedRemaining = accDetails.total - accDetails.rows.length; // 59

        await UA.exportToWord(ctx, reportData, { includeMap: false });

        const [blob] = window.saveAs.mock.calls[0];
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
        const xml = await zip.file('word/document.xml').async('text');

        expect(xml).toContain(String(expectedRemaining));  // "59 weitere Unfälle"
        expect(xml).toContain('weitere Unf');  // "weitere Unfälle" – Ä encoded
      }));
  });

  describe('exportToPDF – crossTable and accidentDetails sections', () => {
    function capturePdfDefinition() {
      let captured;
      const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
      jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
        captured = def;
        const doc = realCreatePdf(def);
        doc.download = jest.fn();
        return doc;
      });
      return () => captured;
    }

    test('should include cross-table in PDF when structured.crossTable is present', async () => {
      const getDefinition = capturePdfDefinition();
      const ctx = { CITY_RAW: 'Hannover' };
      const reportData = {
        text: '',
        structured: {
          severity: { total: 5, bySev: { '1': 1, '2': 2, '3': 2 } },
          crossTable: {
            rows: [
              { mask: 5, label: '🚲+🚗', sev1: 0, sev2: 3, sev3: 12, total: 15 }
            ],
            totals: { sev1: 0, sev2: 3, sev3: 12, total: 15 }
          }
        }
      };

      await UA.exportToPDF(ctx, reportData, { includeMap: false });

      const allText = extractPdfText(getDefinition());
      expect(allText).toContain('Beteiligungskombination');
      expect(allText).toContain('Getötete');
      expect(allText).toContain('Gesamt');
      // Label should have emojis replaced
      expect(allText).toContain('[Rad]+[PKW]');
    });

    test('should include accident details table in PDF when structured.accidentDetails is present', async () => {
      const getDefinition = capturePdfDefinition();
      const ctx = { CITY_RAW: 'Hannover' };
      const reportData = {
        text: '',
        structured: {
          severity: { total: 1, bySev: { '2': 1 } },
          accidentDetails: {
            rows: [
              { lat: 52.38, lon: 9.73, year: 2023, severity: '2', sevLabel: 'Schwerverletzt', involved: '🚲+🚗', hour: 8, weekday: 'Mo–Fr', roadCondition: 'trocken', mask: 5 }
            ],
            total: 1,
            truncated: false
          }
        }
      };

      await UA.exportToPDF(ctx, reportData, { includeMap: false });

      const allText = extractPdfText(getDefinition());
      expect(allText).toContain('EINZELUNF');  // EINZELUNFÄLLE
      expect(allText).toContain('Schwerverletzt');
      // involved emoji should be replaced
      expect(allText).toContain('[Rad]+[PKW]');
    });

    test('replaceEmojisForPDF should replace Gkfz and Sonstig emojis', async () => {
      const getDefinition = capturePdfDefinition();
      const ctx = { CITY_RAW: 'Test' };
      const reportData = {
        text: '',
        structured: {
          severity: { total: 2, bySev: { '3': 2 } },
          crossTable: {
            rows: [
              { mask: 17, label: '🚲+🚛', sev1: 0, sev2: 0, sev3: 1, total: 1 },
              { mask: 32, label: '🚌', sev1: 0, sev2: 0, sev3: 1, total: 1 }
            ],
            totals: { sev1: 0, sev2: 0, sev3: 2, total: 2 }
          }
        }
      };

      await UA.exportToPDF(ctx, reportData, { includeMap: false });

      const allText = extractPdfText(getDefinition());
      // 🚛 → [Gkfz], 🚌 → [Sonst]
      expect(allText).toContain('[Gkfz]');
      expect(allText).toContain('[Sonst]');
      // Raw emojis must NOT appear in PDF
      expect(allText).not.toContain('🚛');
      expect(allText).not.toContain('🚌');
    });
  });

  describe('captureDetailMap', () => {
    test('should NOT call fitBounds when selectionBounds is absent', () =>
      withObjectURL(async () => {
        const fitBoundsSpy = jest.fn();
        const ctx = {
          CITY_RAW: 'Hannover',
          map: {
            getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
            getZoom: jest.fn(() => 12),
            fitBounds: fitBoundsSpy
          }
          // selectionBounds intentionally absent
        };
        const reportData = { text: '', structured: null };

        await UA.exportToWord(ctx, reportData, { includeMap: true });

        // fitBounds should NOT have been called when there is no selectionBounds
        expect(fitBoundsSpy).not.toHaveBeenCalled();
      }));

    test('should call fitBounds with {animate: false} during detail map capture (via Word export)', () =>
      withObjectURL(async () => {
        const fitBoundsSpy = jest.fn();
        const setViewSpy = jest.fn();
        const ctx = {
          CITY_RAW: 'Hannover',
          map: {
            getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
            getZoom: jest.fn(() => 12),
            fitBounds: fitBoundsSpy,
            setView: setViewSpy
          },
          selectionBounds: {
            getSouth: () => 52.37,
            getNorth: () => 52.38,
            getWest: () => 9.72,
            getEast: () => 9.74
          }
        };
        const reportData = { text: '', structured: null };

        await UA.exportToWord(ctx, reportData, { includeMap: true });

        // fitBounds should have been called with animate: false for the detail map
        expect(fitBoundsSpy).toHaveBeenCalledWith(
          ctx.selectionBounds,
          expect.objectContaining({ animate: false })
        );
        // setView should restore the original position
        expect(setViewSpy).toHaveBeenCalledWith(
          expect.anything(),
          expect.any(Number),
          expect.objectContaining({ animate: false })
        );
      }));
  });
});
