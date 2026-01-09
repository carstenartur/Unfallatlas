/**
 * Unit tests for ua.report_v2.js export functions
 */

describe('UA.report_v2 - Export Functions', () => {
  let UA;
  let mockLeafletImage;
  let mockCanvas;

  beforeEach(() => {
    // Setup mock canvas
    mockCanvas = {
      toDataURL: jest.fn(() => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
    };

    // Setup mock leaflet-image
    mockLeafletImage = jest.fn((map, callback) => {
      setTimeout(() => callback(null, mockCanvas), 50);
    });

    // Setup global window object - reassign completely to avoid stale references
    global.window = {
      UA: {},
      leafletImage: mockLeafletImage,
      setTimeout: global.setTimeout,
      atob: global.atob,
      docx: {
        Document: jest.fn(),
        Packer: {
          toBlob: jest.fn()
        },
        Paragraph: jest.fn(),
        TextRun: jest.fn(),
        HeadingLevel: {
          HEADING_1: 'heading1',
          HEADING_2: 'heading2'
        },
        AlignmentType: {
          CENTER: 'center'
        },
        ImageRun: jest.fn()
      },
      pdfMake: {
        createPdf: jest.fn(() => ({
          download: jest.fn()
        }))
      },
      saveAs: jest.fn()
    };

    // Load the module - using eval because files use IIFE pattern
    // Files are loaded from project root: js/ua.report_v2.js
    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    // Note: eval'd code will use jsdom's window, not global.window, unless we bind it
    // We create a window variable in eval's scope that points to global.window
    (function(window) {
      eval(fs.readFileSync(filePath, 'utf8'));
    })(global.window);
    UA = global.window.UA;
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    jest.clearAllMocks();
  });

  describe('captureMapImage', () => {
    test('should capture map image successfully', async () => {
      const mockMap = {
        getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
        getZoom: jest.fn(() => 12)
      };
      const ctx = { map: mockMap };

      // Ensure leafletImage is available
      global.window.leafletImage = mockLeafletImage;

      const result = await UA.captureMapImage(ctx);

      expect(result).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
      expect(mockLeafletImage).toHaveBeenCalledWith(mockMap, expect.any(Function));
    });

    test('should reject if leaflet-image is not loaded', async () => {
      delete global.window.leafletImage;
      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('leaflet-image library not loaded');
    });

    test('should reject if leaflet-image returns error', async () => {
      const error = new Error('Image capture failed');
      global.window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(error, null), 50);
      });

      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('Image capture failed');
    });

    test('should reject if canvas toDataURL fails', async () => {
      // Reset leafletImage to normal behavior for this test
      global.window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 50);
      });
      mockCanvas.toDataURL = jest.fn(() => { throw new Error('Canvas error'); });
      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('Canvas error');
    });

    test('should reject if data URL is invalid', async () => {
      // Reset leafletImage to normal behavior for this test
      global.window.leafletImage = jest.fn((map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 50);
      });
      mockCanvas.toDataURL = jest.fn(() => 'invalid-data-url');
      const ctx = { map: {} };

      await expect(UA.captureMapImage(ctx)).rejects.toThrow('Invalid map image data URL generated');
    });
  });

  describe('exportToWord', () => {
    test('should throw error if docx library not loaded', async () => {
      delete global.window.docx;
      delete global.window.pdfMake;
      delete global.window.saveAs;
      // Set the flag to skip library loading  
      UA._exportLibrariesLoaded = true;
      
      const ctx = { CITY_RAW: 'Hannover' };
      const reportData = { text: 'Test report' };

      await expect(UA.exportToWord(ctx, reportData, {})).rejects.toThrow('docx.js library not loaded');
    });

    test('should create Word document with basic structure', async () => {
      // Ensure libraries are properly set up (in case previous test deleted them)
      if (!global.window.docx || !global.window.docx.Packer) {
        // Recreate docx if needed
        global.window.docx = {
          Document: jest.fn(),
          Packer: {
            toBlob: jest.fn()
          },
          Paragraph: jest.fn(),
          TextRun: jest.fn(),
          HeadingLevel: {
            HEADING_1: 'heading1',
            HEADING_2: 'heading2'
          },
          AlignmentType: {
            CENTER: 'center'
          },
          ImageRun: jest.fn()
        };
      }
      if (!global.window.saveAs) {
        global.window.saveAs = jest.fn();
      }
      
      // Mock URL.createObjectURL for this test
      global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      global.URL.revokeObjectURL = jest.fn();
      
      // Make sure libraries are properly mocked
      const mockBlob = new Blob(['test'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      global.window.docx.Packer.toBlob = jest.fn().mockResolvedValue(mockBlob);
      UA._exportLibrariesLoaded = true; // Skip library loading

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

      expect(global.window.docx.Document).toHaveBeenCalled();
      expect(global.window.docx.Packer.toBlob).toHaveBeenCalled();
      expect(global.window.saveAs).toHaveBeenCalled();
    });
  });

  describe('exportToPDF', () => {
    test('should throw error if pdfMake library not loaded', async () => {
      delete global.window.docx;
      delete global.window.pdfMake;
      delete global.window.saveAs;
      // Set the flag to skip library loading
      UA._exportLibrariesLoaded = true;
      
      const ctx = { CITY_RAW: 'Hannover' };
      const reportData = { text: 'Test report' };

      await expect(UA.exportToPDF(ctx, reportData, {})).rejects.toThrow('pdfMake library not loaded');
    });

    test('should create PDF with basic structure', async () => {
      // Ensure libraries are properly set up (in case previous test deleted them)
      if (!global.window.pdfMake) {
        global.window.pdfMake = {
          createPdf: jest.fn(() => ({
            download: jest.fn()
          }))
        };
      }
      
      // Make sure libraries are properly mocked
      UA._exportLibrariesLoaded = true; // Skip library loading
      const mockDownload = jest.fn();
      global.window.pdfMake.createPdf = jest.fn().mockReturnValue({
        download: mockDownload
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

      expect(global.window.pdfMake.createPdf).toHaveBeenCalled();
      expect(mockDownload).toHaveBeenCalled();
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
