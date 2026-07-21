'use strict';

const {
  DocumentAuditError,
  auditRenderedDocument,
  assertRenderedDocument,
  normalizeDocument,
  pageText,
} = require('../../scripts/rendered-document-audit');

function word(text, xMin, yMin, width = 40, height = 10, extras = {}) {
  return { text, xMin, yMin, xMax: xMin + width, yMax: yMin + height, ...extras };
}

function heading(text, level, xMin, yMin, width = 260, height = 16) {
  return { text, level, xMin, yMin, xMax: xMin + width, yMax: yMin + height };
}

function link(uri, label, xMin, yMin, width = 180, height = 10) {
  return { uri, label, xMin, yMin, xMax: xMin + width, yMax: yMin + height };
}

function tableRow(tableId, rowId, yMin, cells, repeatedHeader = false) {
  return {
    tableId,
    rowId,
    xMin: 45,
    yMin,
    xMax: 550,
    yMax: yMin + 18,
    cells,
    repeatedHeader,
  };
}

function mapImage(overrides = {}) {
  return {
    imageId: 'overview-map',
    kind: 'map',
    xMin: 60,
    yMin: 180,
    xMax: 540,
    yMax: 500,
    sourceWidth: 1200,
    sourceHeight: 800,
    altText: 'Übersichtskarte des markierten Bereichs mit Unfallpunkten.',
    caption: 'Abbildung 1: Übersichtskarte mit 12 ausgewerteten Unfällen.',
    sourceIds: ['accidents.de.unfallatlas', 'basemap.openstreetmap'],
    ...overrides,
  };
}

function validDocument(overrides = {}) {
  const page1 = {
    number: 1,
    width: 595,
    height: 842,
    words: [
      word('VERKEHRSSICHERHEITSANTRAG', 48, 48, 300, 16, { fontSize: 14 }),
      word('Beschlussvorschlag', 48, 90, 170, 14, { fontSize: 12 }),
      word('Die', 48, 118), word('Verwaltung', 90, 118, 70),
      word('prüft', 165, 118), word('den', 210, 118), word('Bereich.', 245, 118, 55),
      word('Kurzbewertung', 48, 145, 150, 14, { fontSize: 12 }),
      word('Im', 48, 165), word('Bereich', 75, 165), word('wurden', 128, 165),
      word('12', 180, 165, 18), word('Unfälle', 202, 165, 45), word('ausgewertet.', 252, 165, 75),
      word('Abbildung', 60, 515, 55), word('1:', 120, 515, 12),
      word('Übersichtskarte', 137, 515, 90), word('mit', 232, 515, 20),
      word('12', 257, 515, 18), word('Unfällen.', 280, 515, 55),
      word('Datenquellen', 48, 560, 100, 14, { fontSize: 12 }),
      word('Unfallatlas', 48, 585, 70), word('und', 123, 585, 25),
      word('OpenStreetMap', 153, 585, 95), word('sind', 253, 585, 30),
      word('verlinkt.', 288, 585, 55),
    ],
    headings: [
      heading('VERKEHRSSICHERHEITSANTRAG', 1, 48, 48, 300, 16),
      heading('Beschlussvorschlag', 2, 48, 90, 170, 14),
      heading('Kurzbewertung', 2, 48, 145, 150, 14),
      heading('Datenquellen', 2, 48, 560, 100, 14),
    ],
    images: [mapImage()],
    links: [
      link('https://unfallatlas.statistikportal.de/', 'Unfallatlas', 48, 610),
      link('https://www.openstreetmap.org/copyright', 'OpenStreetMap-Lizenz', 48, 630),
    ],
    tableRows: [],
  };
  const page2 = {
    number: 2,
    width: 595,
    height: 842,
    words: [
      word('Unfalllage', 48, 48, 100, 14, { fontSize: 12 }),
      word('und', 153, 48, 25), word('Verletzungsschwere', 183, 48, 130),
      word('Kategorie', 50, 95, 65), word('Anzahl', 350, 95, 45),
      word('Getötete', 50, 120, 55), word('1', 365, 120, 8),
      word('Schwerverletzte', 50, 145, 95), word('3', 365, 145, 8),
      word('Leichtverletzte', 50, 170, 90), word('8', 365, 170, 8),
      word('Einzelunfälle', 48, 220, 100, 14, { fontSize: 12 }),
      word('Alle', 48, 245, 30), word('12', 83, 245, 18),
      word('Unfälle', 106, 245, 45), word('sind', 156, 245, 30),
      word('dem', 191, 245, 25), word('Snapshot', 221, 245, 55), word('zugeordnet.', 281, 245, 70),
      word('Methodik', 48, 320, 75, 14, { fontSize: 12 }),
      word('Filter,', 48, 345, 40), word('Auswahl', 93, 345, 50),
      word('und', 148, 345, 25), word('Quellen', 178, 345, 50),
      word('verwenden', 233, 345, 60), word('denselben', 298, 345, 55),
      word('Snapshot.', 358, 345, 60),
    ],
    headings: [
      heading('Unfalllage und Verletzungsschwere', 2, 48, 48, 265, 14),
      heading('Einzelunfälle', 2, 48, 220, 100, 14),
      heading('Methodik', 2, 48, 320, 75, 14),
    ],
    images: [],
    links: [],
    tableRows: [
      tableRow('severity', 'severity-header', 90, ['Kategorie', 'Anzahl'], true),
      tableRow('severity', 'fatal', 115, ['Getötete', '1']),
      tableRow('severity', 'serious', 140, ['Schwerverletzte', '3']),
      tableRow('severity', 'minor', 165, ['Leichtverletzte', '8']),
    ],
  };
  return {
    documentId: 'bonn-golden-native-pdf',
    renderer: 'native-pdf',
    sourceManifestHash: 'a'.repeat(64),
    pages: [page1, page2],
    requiredHeadings: [
      'Beschlussvorschlag',
      'Kurzbewertung',
      'Unfalllage und Verletzungsschwere',
      'Einzelunfälle',
      'Methodik',
      'Datenquellen',
    ],
    requiredLinks: [
      'https://unfallatlas.statistikportal.de/',
      'https://www.openstreetmap.org/copyright',
    ],
    requiredImageKinds: ['map'],
    expectedCounts: [{
      countId: 'local-accidents',
      value: 12,
      requiredTextPatterns: [
        '\\b{value}\\s+Unfälle\\b',
        'Übersichtskarte\\s+mit\\s+{value}\\s+Unfällen',
      ],
    }],
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function issueCodes(report) {
  return report.issues.map(item => item.code);
}

describe('renderer-neutral final document audit', () => {
  test('accepts a publication-ready native or converted document model', () => {
    for (const renderer of ['native-pdf', 'libreoffice-docx-pdf']) {
      const report = assertRenderedDocument(validDocument({ renderer }));
      expect(report).toEqual(expect.objectContaining({
        passed: true,
        pageCount: 2,
        counts: { error: 0, warning: 0 },
      }));
      expect(report.summary).toEqual(expect.objectContaining({
        mapCount: 1,
        linkCount: 2,
        tableRowCount: 4,
        sourceManifestHash: 'a'.repeat(64),
      }));
    }
  });

  test('normalizes sequential pages and exposes stable reading-order text', () => {
    const document = normalizeDocument(validDocument());
    expect(document.pages.map(page => page.number)).toEqual([1, 2]);
    expect(pageText(document.pages[0])).toMatch(
      /^VERKEHRSSICHERHEITSANTRAG Beschlussvorschlag Die Verwaltung prüft/
    );
    expect(Object.isFrozen(document.pages[0].words)).toBe(true);
  });

  test('rejects empty rendered pages', () => {
    const document = clone(validDocument());
    document.pages.push({
      number: 3, width: 595, height: 842,
      words: [word('3', 290, 810, 8)], images: [], links: [], headings: [], tableRows: [],
    });
    const report = auditRenderedDocument(document);
    expect(report.passed).toBe(false);
    expect(issueCodes(report)).toContain('empty_page');
  });

  test.each([
  ['heading', page => { page.headings.push(heading('Anhang', 2, 48, 100, 70, 14)); }],
  ['link annotation', page => { page.links.push(link('https://example.org/source', 'Quelle', 48, 100)); }],
  ['table row', page => { page.tableRows.push(tableRow('appendix', 'row-1', 100, ['A', 'B'])); }],
])('does not classify a sparse page with a %s as empty', (_label, addStructure) => {
  const document = clone(validDocument());
  const page = {
    number: 3, width: 595, height: 842,
    words: [word('3', 290, 810, 8)], images: [], links: [], headings: [], tableRows: [],
  };
  addStructure(page);
  document.pages.push(page);
  expect(issueCodes(auditRenderedDocument(document))).not.toContain('empty_page');
});

test.each([
  ['word', document => { document.pages[0].words[0].xMin = -2; }],
    ['image', document => { document.pages[0].images[0].xMax = 594; }],
    ['link', document => { document.pages[0].links[0].yMax = 840; }],
    ['table row', document => { document.pages[1].tableRows[0].xMax = 590; }],
  ])('detects %s content crossing printable page boundaries', (_label, mutate) => {
    const document = clone(validDocument());
    mutate(document);
    expect(issueCodes(auditRenderedDocument(document))).toContain('content_outside_page');
  });

  test('detects text below the minimum readable size', () => {
    const document = clone(validDocument());
    document.pages[1].words[1].fontSize = 5.5;
    const report = auditRenderedDocument(document);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'text_too_small', page: 2 }),
    ]));
  });

  test('detects headings orphaned at the page bottom', () => {
    const document = clone(validDocument());
    document.pages[1].headings.push(heading('Anlagen', 2, 48, 785, 70, 14));
    document.pages[1].words.push(word('Anlagen', 48, 785, 70, 14, { fontSize: 12 }));
    const report = auditRenderedDocument(document);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'orphan_heading', page: 2 }),
    ]));
  });

  test('detects a distorted map independently from source-model declarations', () => {
    const document = clone(validDocument());
    document.pages[0].images[0].xMax = 440;
    const report = auditRenderedDocument(document);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'map_aspect_distorted', page: 1 }),
    ]));
  });

  test.each([
    ['small', image => { image.xMax = image.xMin + 150; image.yMax = image.yMin + 90; }, 'map_too_small'],
    ['missing caption', image => { image.caption = ''; }, 'map_unlabelled'],
    ['missing alt text', image => { image.altText = ''; }, 'map_unlabelled'],
    ['missing sources', image => { image.sourceIds = []; }, 'map_source_missing'],
  ])('detects a map that is %s', (_label, mutate, expectedCode) => {
    const document = clone(validDocument());
    mutate(document.pages[0].images[0]);
    expect(issueCodes(auditRenderedDocument(document))).toContain(expectedCode);
  });

  test('detects overlapping table rows in final page coordinates', () => {
    const document = clone(validDocument());
    document.pages[1].tableRows[2].yMin = 127;
    document.pages[1].tableRows[2].yMax = 145;
    const report = auditRenderedDocument(document);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'table_rows_overlap', page: 2 }),
    ]));
  });

  test('requires every declared section in extracted rendered text', () => {
    const document = clone(validDocument());
    document.requiredHeadings.push('Anlagen');
    expect(issueCodes(auditRenderedDocument(document))).toContain('required_heading_missing');
  });

  test('requires actual link annotations rather than visible URL text', () => {
    const document = clone(validDocument());
    document.pages[0].links = document.pages[0].links.slice(0, 1);
    // Keep the visible words. The missing annotation must still fail.
    const report = auditRenderedDocument(document);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'required_link_missing',
        message: expect.stringContaining('openstreetmap.org/copyright'),
      }),
    ]));
  });

  test('requires final rendered maps rather than source-model includeMap flags', () => {
    const document = clone(validDocument());
    document.pages[0].images = [];
    expect(issueCodes(auditRenderedDocument(document))).toContain('required_image_missing');
  });

  test('binds the same accident count to narrative and map caption text', () => {
    const document = clone(validDocument());
    document.pages[0].words = document.pages[0].words.map(item =>
      item.text === '12' && item.yMin === 515 ? { ...item, text: '11' } : item
    );
    const report = auditRenderedDocument(document);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'expected_count_missing' }),
    ]));
  });

  test('assertion helper exposes the complete machine-readable audit report', () => {
    const document = clone(validDocument());
    document.pages[0].images[0].caption = '';
    expect(() => assertRenderedDocument(document)).toThrow(DocumentAuditError);
    try {
      assertRenderedDocument(document);
      throw new Error('expected audit failure');
    } catch (error) {
      expect(error.code).toBe('rendered_document_audit_failed');
      expect(error.report.passed).toBe(false);
      expect(error.report.issues.map(item => item.code)).toContain('map_unlabelled');
    }
  });

  test('fails closed on malformed page models, links and boxes', () => {
    expect(() => normalizeDocument({ ...validDocument(), pages: [] }))
      .toThrow(/missing_pages/);

    const nonSequential = clone(validDocument());
    nonSequential.pages[1].number = 3;
    expect(() => normalizeDocument(nonSequential)).toThrow(/non_sequential_pages/);

    const unsafeLink = clone(validDocument());
    unsafeLink.pages[0].links[0].uri = 'javascript:alert(1)';
    expect(() => normalizeDocument(unsafeLink)).toThrow(/unsafe_link/);

    const invalidBox = clone(validDocument());
    invalidBox.pages[0].words[0].xMax = invalidBox.pages[0].words[0].xMin;
    expect(() => normalizeDocument(invalidBox)).toThrow(/invalid_box/);
  });

  test('rejects invalid regular expressions in count contracts', () => {
    const document = clone(validDocument());
    document.expectedCounts[0].requiredTextPatterns = ['(['];
    expect(() => auditRenderedDocument(document)).toThrow(/invalid_count_pattern/);
  });
});
