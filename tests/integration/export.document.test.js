/** @jest-environment node */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
const pdfMake = require('../../scripts/pdfmake-node');

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
  let window;

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

  const refreshWarning = 'Aktualisierung fehlgeschlagen: <archiv> & Quelle.';
  const scopeWarning = 'Nur die veröffentlichten Vorlagen wurden erfasst.';
  const politicalReferences = [
    {
      title: 'Vorlage aus dem Teilbestand',
      source: 'Ratsinformationssystem',
      snapshot: {
        city: 'hannover', generatedAt: '2026-10-15T14:30:00Z', sha256: 'a'.repeat(64),
        complete: false, stale: true, warnings: [scopeWarning, refreshWarning],
      },
    },
    {
      title: 'Vorlage aus früherem Katalog',
      snapshot: { city: 'hannover', generatedAt: '2026-10-02T10:00:00Z', sha256: 'b'.repeat(64) },
    },
    { title: 'Manuell gewählte Vorlage' },
  ];

  function expectSnapshotDetails(text) {
    expect(text).toContain('Vorlage aus früherem Katalog');
    expect(text).toContain('Manuell gewählte Vorlage');
    const [beforeDatedReference, remaining] = text.split('Vorlage aus früherem Katalog');
    const [datedReference, manualReference] = remaining.split('Manuell gewählte Vorlage');
    expect(beforeDatedReference).toContain('Vorlage aus dem Teilbestand');
    expect(beforeDatedReference).toContain('Katalogstand: 2026-10-15');
    expect(beforeDatedReference).toMatch(/Katalogabdeckung: eingeschränkt/);
    expect(beforeDatedReference).toMatch(/Katalogstand ist veraltet/);
    expect(beforeDatedReference).toContain(scopeWarning);
    expect(beforeDatedReference).toContain(refreshWarning);
    expect(datedReference).toContain('Katalogstand: 2026-10-02');
    expect(datedReference).not.toMatch(/eingeschränkt|veraltet|Kataloghinweis/);
    expect(manualReference).not.toMatch(/Katalogstand|Katalogabdeckung|Kataloghinweis/);
  }

  async function readWordDocument(blob) {
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await archive.file('word/document.xml').async('string');
    const dom = new JSDOM(xml, { contentType: 'application/xml' });
    try {
      return Array.from(dom.window.document.getElementsByTagName('w:t'), node => node.textContent).join(' ');
    } finally {
      dom.window.close();
    }
  }

  function readPdfText(buffer) {
    const script = `
      import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const pdf = await getDocument({ data: new Uint8Array(Buffer.concat(chunks)) }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const text = await (await pdf.getPage(i)).getTextContent();
        process.stdout.write(text.items.map(item => item.str).join(' ') + '\\n');
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(__dirname, '../..'), input: Buffer.from(buffer), encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`PDF inspection failed: ${result.stderr}`);
    return result.stdout.replace(/\s+/g, ' ');
  }

  beforeEach(() => {
    mockCanvas = {
      toDataURL: jest.fn(() =>
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      ),
    };
    window = {
      UA: {},
      location: new URL('http://localhost/werkbank_v2.html'),
      leafletImage: jest.fn((_map, callback) => {
        setTimeout(() => callback(null, mockCanvas), 10);
      }),
      docx: require('docx'),
      pdfMake,
      saveAs: jest.fn(),
    };

    const realCreatePdf = pdfMake.createPdf.bind(pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation(definition => {
      const document = realCreatePdf(definition);
      document.download = jest.fn();
      return document;
    });

    const file = path.resolve(__dirname, '../../js/ua.report_v2.js');
    eval(fs.readFileSync(file, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
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

  test.each(['text', 'html'])('%s exports retain selected RIS dates and limitations', async format => {
    const dom = new JSDOM();
    const { document } = dom.window;
    const fetch = async () => ({ ok: false });
    window.fetch = fetch;
    try {
      for (const module of ['ua.utils.js', 'ua.export_v2.js']) {
        eval(fs.readFileSync(path.resolve(__dirname, '../../js', module), 'utf8'));
      }
      const report = await UA.computeExportReport({
        CITY_RAW: 'Hannover',
        allPts: [],
        selectionBounds: {
          contains: () => false,
          getSouthWest: () => ({ lat: 52.36, lng: 9.71 }),
          getNorthEast: () => ({ lat: 52.39, lng: 9.75 }),
        },
        exportOptions: { includeCosts: false, includeMeasures: false },
        politicalReferences,
      });
      if (format === 'html') {
        const output = document.createElement('div');
        output.innerHTML = report.html;
        expect(output.querySelector('archiv')).toBeNull();
        expectSnapshotDetails(output.textContent);
      } else {
        expectSnapshotDetails(report.text);
      }
    } finally {
      dom.window.close();
    }
  });

  test('Word export retains selected RIS dates and limitations in the document', async () => {
    const report = basicReport({ structured: baseStructured({ politicalReferences }) });
    await UA.exportToWord(makeCtx(), report, { includeReferences: true });
    const [blob] = window.saveAs.mock.calls[0];
    expectSnapshotDetails(await readWordDocument(blob));
  });

  test('direct PDF export retains selected RIS dates and limitations in the document', async () => {
    const report = basicReport({ structured: baseStructured({ politicalReferences }) });
    await UA.exportToPDF(makeCtx(), report, { includeReferences: true });
    const pdf = window.pdfMake.createPdf.mock.results[0].value;
    expectSnapshotDetails(readPdfText(await pdf.getBuffer()));
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
