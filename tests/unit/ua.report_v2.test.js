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
    pdfMakeLib.vfs = pdfFonts.pdfMake.vfs;

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
      URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = jest.fn();

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

      // Verify filename format
      expect(filename).toMatch(/Bezirksratsantrag_Hannover_.*\.docx/);

      // Verify PK magic bytes (zip/docx format)
      const arrayBuffer = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsArrayBuffer(blob);
      });
      const bytes = new Uint8Array(arrayBuffer);
      expect(bytes[0]).toBe(0x50); // P
      expect(bytes[1]).toBe(0x4B); // K
    });
  });

  describe('ensureExportLibraries', () => {
    test('should detect pre-loaded real libraries and skip CDN loading', async () => {
      // Real libraries are already set on window in beforeEach.
      // The function should detect them and return without loading CDN scripts.
      UA._exportLibrariesLoaded = false;

      await UA.ensureExportLibraries();

      expect(UA._exportLibrariesLoaded).toBe(true);
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
      await new Promise((resolve) => {
        capturedDoc.getBuffer((buffer) => {
          expect(buffer.length).toBeGreaterThan(0);
          expect(String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3])).toBe('%PDF');
          resolve();
        });
      });
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
});
