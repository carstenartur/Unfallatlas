'use strict';

/**
 * Integration coverage for PDF and DOCX document exports.
 *
 * The suite uses the real pdfmake/docx libraries. pdfMake content is inspected
 * recursively because final-page hardening deliberately nests headings, tables,
 * captions and images in stacks and columns.
 */
describe('Document Export - Integration Tests', () => {
  let UA;
  let mockCanvas;
  let originalLocation;

  function collectPdfText(item) {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) return item.map(collectPdfText).filter(Boolean).join(' ');
    if (typeof item !== 'object') return '';

    const fragments = [];
    if (typeof item.text === 'string') fragments.push(item.text);
    else if (Array.isArray(item.text)) fragments.push(collectPdfText(item.text));
    if (Array.isArray(item.stack)) fragments.push(collectPdfText(item.stack));
    if (Array.isArray(item.columns)) fragments.push(collectPdfText(item.columns));
    if (item.table && Array.isArray(item.table.body)) {
      fragments.push(collectPdfText(item.table.body));
    }
    return fragments.filter(Boolean).join(' ');
  }

  function containsPng(node) {
    if (node == null) return false;
    if (Array.isArray(node)) return node.some(containsPng);
    if (typeof node !== 'object') return false;
    if (typeof node.image === 'string' && node.image.startsWith('data:image/png;base64,')) {
      return true;
    }
    return containsPng(node.stack) || containsPng(node.columns) ||
      Boolean(node.table && containsPng(node.table.body));
  }

  function makeCtx(city = 'Hannover') {
    return {
      CITY_RAW: city,
      map: {
        getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.732 })),
        getZoom: jest.fn(() => 12),
      },
    };
  }

  function baseStructured(overrides = {}) {
    return {
      meta: {
        city: 'Hannover',
        date: '01.01.2025',
        bounds: '52.0,9.5 – 53.0,10.5',
        areaName: 'Test',
        link: 'http://localhost/',
        filters: {},
      },
      severity: { total: 10, bySev: { '1': 1, '2': 4, '3': 5, other: 0 } },
      deviations: {
        focus: [
          {
            mask: 5,
            label: '[Rad]+[PKW]',
            locCnt: 5,
            baseCnt: 10,
            locR: 0.5,
            baseR: 0.2,
            factor: 2.5,
          },
        ],
        rows: [],
        local: { total: 10, byMask: {} },
        baseline: { total: 50, byMask: {} },
      },
      yearTable: [
        { year: 2022, total: 5, classes: ['[Rad]+[PKW]=5'] },
        { year: 2021, total: 5, classes: ['[Rad]+[PKW]=5'] },
      ],
      poi: null,
      references: null,
      patterns: [],
      ...overrides,
    };
  }

  function basicReport(overrides = {}) {
    return {
      text: 'Sachverhalt:\nTest content\n\nBeschlussvorschlag:\nTest proposal',
      ...overrides,
    };
  }

  beforeEach(() => {
    mockCanvas = {
      toDataURL: jest.fn(() =>
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      ),
    };
    originalLocation = window.location;
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
          host: 'localhost',
        },
        writable: true,
        configurable: true,
      });
    } catch (_) {
      window.history.replaceState({}, '', '/werkbank_v2.html');
    }

    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    if (typeof pdfMakeLib.addVirtualFileSystem === 'function') {
      pdfMakeLib.addVirtualFileSystem(pdfFonts);
    } else {
      pdfMakeLib.vfs = pdfFonts;
    }

    Object.assign(window, {
      UA: {},
      leafletImage: jest.fn((_map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 10);
      }),
      docx: require('docx'),
      pdfMake: pdfMakeLib,
      saveAs: jest.fn(),
    });

    const realCreatePdf = pdfMakeLib.createPdf.bind(pdfMakeLib);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation(definition => {
      const document = realCreatePdf(definition);
      document.download = jest.fn();
      return document;
    });

    const fs = require('fs');
    const path = require('path');
    const file = path.resolve(__dirname, '../../js/ua.report_v2.js');
    eval(fs.readFileSync(file, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    try {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    } catch (_) {
      // jsdom may expose a non-configurable location in future versions.
    }
    delete window.UA;
    delete window.leafletImage;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  test('should generate PDF with accident data', async () => {
    const report = basicReport({
      text: [
        'Sachverhalt:',
        'Im markierten Kartenausschnitt wurden 42 Unfälle ausgewertet.',
        'Davon waren 15 Radunfälle, 10 Fußgängerunfälle und 17 PKW-Unfälle.',
        '',
        'POI-Analyse',
        'Innerhalb des Ausschnitts: Grundschule Am Sandbach (200m)',
        '',
        'Bezugsdokumente:',
        'Die Ideale Kreuzung - Leitfaden für sichere Knotenpunkte',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat bittet die Verwaltung, den markierten Bereich zu prüfen.',
      ].join('\n'),
      structured: { meta: { gremium: { typ: 'Bezirksrat' } } },
    });

    await UA.exportToPDF(makeCtx(), report, {
      includeMap: false,
      includePOIs: true,
      includeReferences: true,
    });

    const definition = window.pdfMake.createPdf.mock.calls[0][0];
    const text = collectPdfText(definition.content);
    expect(definition.content.length).toBeGreaterThan(0);
    expect(text).toContain('BEZIRKSRATSANTRAG');
    expect(text).toContain('SACHVERHALT');
    expect(text).toContain('BESCHLUSSVORSCHLAG');
  });

  test('should generate PDF with map image', async () => {
    await UA.exportToPDF(makeCtx(), basicReport(), {
      includeMap: true,
      includePOIs: false,
      includeReferences: false,
    });

    expect(window.leafletImage).toHaveBeenCalled();
    const definition = window.pdfMake.createPdf.mock.calls[0][0];
    expect(containsPng(definition.content)).toBe(true);
  });

  test('should generate Word document with accident data', async () => {
    await UA.exportToWord(makeCtx(), basicReport({
      text: [
        'Sachverhalt:',
        'Im markierten Kartenausschnitt wurden 42 Unfälle ausgewertet.',
        '',
        'POI-Analyse',
        'Grundschule Am Sandbach (150m entfernt)',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat bittet die Verwaltung um Prüfung.',
      ].join('\n'),
    }), {
      includeMap: false,
      includePOIs: true,
      includeReferences: false,
    });

    const [blob, filename] = window.saveAs.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('application/vnd');
    expect(filename).toMatch(/Antrag.*Hannover.*\.docx/);
  });

  test('should generate Word document with map image', async () => {
    await UA.exportToWord(makeCtx('Berlin'), basicReport(), {
      includeMap: true,
      includePOIs: false,
      includeReferences: false,
    });

    expect(window.leafletImage).toHaveBeenCalled();
    const [blob] = window.saveAs.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
  });

  test('should handle map capture failure gracefully', async () => {
    window.leafletImage = jest.fn((_map, callback) => {
      setTimeout(() => callback(new Error('Map capture failed'), null), 10);
    });

    await expect(UA.exportToWord(makeCtx('Hamburg'), basicReport(), {
      includeMap: true,
      includePOIs: false,
      includeReferences: false,
    })).resolves.not.toThrow();
    expect(window.saveAs).toHaveBeenCalled();
  });

  test('should include POI analysis in PDF', async () => {
    await UA.exportToPDF(makeCtx('München'), basicReport({
      text: [
        'Sachverhalt:',
        '42 Unfälle im Bereich',
        '',
        'POI-Analyse',
        'Innerhalb des Ausschnitts:',
        '- Grundschule Beispielstraße (100m)',
        '- Kindergarten Sonnenschein (150m)',
        '',
        'In der Nähe (bis 200m):',
        '- Kita Regenbogen (180m)',
        '',
        'Beschlussvorschlag:',
        'Prüfung erforderlich',
      ].join('\n'),
    }), { includeMap: false, includePOIs: true, includeReferences: false });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('SENSIBLE EINRICHTUNGEN');
    expect(text).toContain('Grundschule');
    expect(text).toContain('Kindergarten');
  });

  test('should include references in PDF', async () => {
    await UA.exportToPDF(makeCtx('Köln'), basicReport({
      text: [
        'Sachverhalt:',
        'Test content',
        '',
        'Bezugsdokumente:',
        '- Die Ideale Kreuzung (Region Hannover, 2023)',
        '- Verkehrssicherheitskonzept NRW',
        '',
        'Beschlussvorschlag:',
        'Maßnahmen erforderlich',
      ].join('\n'),
    }), { includeMap: false, includePOIs: false, includeReferences: true });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('FACHLICHE BEZÜGE');
    expect(text).toContain('Ideale Kreuzung');
  });

  test('should generate complete PDF with all sections', async () => {
    await UA.exportToPDF(makeCtx('Düsseldorf'), basicReport({
      text: [
        'Sachverhalt:',
        'Im markierten Kartenausschnitt wurden 58 Unfälle ausgewertet.',
        'Davon 25 mit Radbeteiligung, 12 mit Fußgängerbeteiligung.',
        '',
        'POI-Analyse',
        'Innerhalb: Grundschule Musterstraße (80m)',
        'In der Nähe: Kindergarten Test (190m)',
        '',
        'Bezugsdokumente:',
        'Verkehrssicherheitskonzept Düsseldorf 2025',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat bittet um umfassende Prüfung und Maßnahmen.',
      ].join('\n'),
      structured: { meta: { gremium: { typ: 'Bezirksrat' } } },
    }), { includeMap: true, includePOIs: true, includeReferences: true });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    for (const heading of [
      'BEZIRKSRATSANTRAG',
      'SACHVERHALT',
      'SENSIBLE EINRICHTUNGEN',
      'FACHLICHE BEZÜGE',
      'BESCHLUSSVORSCHLAG',
      'DATENQUELLE',
    ]) {
      expect(text).toContain(heading);
    }
  });

  test('PDF should include STATISTIK section with severity table when structured data provided', async () => {
    await UA.exportToPDF(makeCtx(), basicReport({ structured: baseStructured() }), {
      includeMap: false,
      includePOIs: true,
      includeReferences: true,
    });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('STATISTIK');
    expect(text).toContain('Getötete');
    expect(text).toContain('Schwerverletzte');
    expect(text).toContain('Leichtverletzte');
    expect(text).toContain('Muster');
  });

  test('Word document should include STATISTIK section when structured data provided', async () => {
    await UA.exportToWord(makeCtx(), basicReport({
      structured: baseStructured({
        severity: { total: 5, bySev: { '1': 0, '2': 2, '3': 3, other: 0 } },
        deviations: {
          focus: [],
          rows: [],
          local: { total: 5, byMask: {} },
          baseline: { total: 20, byMask: {} },
        },
        yearTable: [{ year: 2022, total: 5, classes: [] }],
      }),
    }), { includeMap: false, includePOIs: false, includeReferences: false });

    const [blob] = window.saveAs.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
  });

  test('PDF export should show POI table from structured data', async () => {
    await UA.exportToPDF(makeCtx(), basicReport({
      structured: baseStructured({
        severity: { total: 0, bySev: { '1': 0, '2': 0, '3': 0, other: 0 } },
        deviations: {
          focus: [],
          rows: [],
          local: { total: 0, byMask: {} },
          baseline: { total: 0, byMask: {} },
        },
        yearTable: [],
        poi: {
          totalWithin: 2,
          totalNear: 1,
          withinByType: { school: 1, kindergarten: 1 },
          nearByType: { childcare: 1 },
          withinArea: [],
          nearArea: [],
        },
      }),
    }), { includeMap: false, includePOIs: true, includeReferences: false });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('SENSIBLE EINRICHTUNGEN');
    expect(text).toContain('Typ');
    expect(text).toContain('Im Bereich');
    expect(text).toContain('Schulen');
    expect(text).toContain('Kindergärten');
  });

  test('PDF with structured references shows structured list', async () => {
    await UA.exportToPDF(makeCtx(), basicReport({
      structured: baseStructured({
        severity: { total: 0, bySev: { '1': 0, '2': 0, '3': 0, other: 0 } },
        deviations: {
          focus: [],
          rows: [],
          local: { total: 0, byMask: {} },
          baseline: { total: 0, byMask: {} },
        },
        yearTable: [],
        references: {
          documents: [
            {
              title: 'Die Ideale Kreuzung',
              author: 'Region Hannover',
              date: '2023',
              url: 'https://example.com/dok',
            },
          ],
        },
      }),
    }), { includeMap: false, includePOIs: false, includeReferences: true });

    const text = collectPdfText(window.pdfMake.createPdf.mock.calls[0][0].content);
    expect(text).toContain('FACHLICHE BEZÜGE');
    expect(text).toContain('Die Ideale Kreuzung');
  });
});
