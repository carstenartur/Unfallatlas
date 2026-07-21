'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const {
  PopplerAdapterError,
  parseAttributes,
  parseBboxPages,
  parsePdfToHtmlPages,
  combinePopplerModels,
  extractPopplerDocument,
  main,
} = require('../../scripts/poppler-rendered-document');

const BBOX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<doc>
  <page width="595.000000" height="842.000000">
    <flow><block><line>
      <word xMin="48.000000" yMin="48.000000" xMax="198.000000" yMax="64.000000">Kurzbewertung</word>
      <word xMin="48.000000" yMin="90.000000" xMax="62.000000" yMax="101.000000">12</word>
      <word xMin="67.000000" yMin="90.000000" xMax="112.000000" yMax="101.000000">Unfälle</word>
      <word xMin="117.000000" yMin="90.000000" xMax="155.000000" yMax="101.000000">im</word>
      <word xMin="160.000000" yMin="90.000000" xMax="214.000000" yMax="101.000000">Bereich</word>
    </line></block></flow>
  </page>
  <page width="595" height="842">
    <flow><block><line>
      <word xMin="48" yMin="48" xMax="138" yMax="62">Datenquellen</word>
      <word xMin="48" yMin="88" xMax="118" yMax="99">Unfallatlas</word>
      <word xMin="123" yMin="88" xMax="148" yMax="99">und</word>
      <word xMin="153" yMin="88" xMax="248" yMax="99">OpenStreetMap</word>
    </line></block></flow>
  </page>
</doc>`;

const HTML_XML = `<?xml version="1.0" encoding="UTF-8"?>
<pdf2xml producer="poppler" version="26.01.0">
  <fontspec id="0" size="16" family="Noto Sans" color="#000000"/>
  <fontspec id="1" size="10" family="Noto Sans" color="#222222"/>
  <page number="1" position="absolute" top="0" left="0" height="842" width="595">
    <text top="48" left="48" width="150" height="16" font="0">Kurzbewertung</text>
    <text top="90" left="48" width="166" height="11" font="1">12 Unfälle im Bereich</text>
    <image top="150" left="60" width="480" height="320" src="map-1.png"/>
  </page>
  <page number="2" position="absolute" top="0" left="0" height="842" width="595">
    <text top="48" left="48" width="90" height="14" font="0">Datenquellen</text>
    <text top="88" left="48" width="200" height="11" font="1"><a href="https://unfallatlas.statistikportal.de/">Unfallatlas</a> und <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a></text>
  </page>
</pdf2xml>`;

function fakeExecutables(directory, bboxXml = BBOX_XML, htmlXml = HTML_XML) {
  const pdftotext = path.join(directory, 'pdftotext');
  const pdftohtml = path.join(directory, 'pdftohtml');
  fs.writeFileSync(pdftotext, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(bboxXml)});\n`);
  fs.writeFileSync(pdftohtml, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(htmlXml)});\n`);
  fs.chmodSync(pdftotext, 0o755);
  fs.chmodSync(pdftohtml, 0o755);
  return { pdftotext, pdftohtml };
}

describe('Poppler rendered-document adapter', () => {
  test('parses quoted XML attributes and entities', () => {
    expect(parseAttributes('href="https://example.org/?a=1&amp;b=2" top=\'48\''))
      .toEqual({ href: 'https://example.org/?a=1&b=2', top: '48' });
  });

  test('parses final page and word boxes from pdftotext bbox output', () => {
    const pages = parseBboxPages(BBOX_XML);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual(expect.objectContaining({
      number: 1,
      width: 595,
      height: 842,
    }));
    expect(pages[0].words).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'Kurzbewertung', xMin: 48, yMin: 48, xMax: 198, yMax: 64,
      }),
      expect.objectContaining({ text: '12' }),
    ]));
    expect(pages[1].words.map(word => word.text)).toEqual([
      'Datenquellen', 'Unfallatlas', 'und', 'OpenStreetMap',
    ]);
  });

  test('parses final text, images, font specs and clickable links from pdftohtml', () => {
    const pages = parsePdfToHtmlPages(HTML_XML);
    expect(pages).toHaveLength(2);
    expect(pages[0].texts[0]).toEqual(expect.objectContaining({
      text: 'Kurzbewertung',
      fontSize: 16,
      fontFamily: 'Noto Sans',
      xMin: 48,
      yMin: 48,
      xMax: 198,
      yMax: 64,
    }));
    expect(pages[0].images).toEqual([
      expect.objectContaining({
        imageId: 'map-1.png', xMin: 60, yMin: 150, xMax: 540, yMax: 470,
      }),
    ]);
    expect(pages[1].links).toEqual([
      expect.objectContaining({
        uri: 'https://unfallatlas.statistikportal.de/', label: 'Unfallatlas',
      }),
      expect.objectContaining({
        uri: 'https://www.openstreetmap.org/copyright', label: 'OpenStreetMap',
      }),
    ]);
  });

  test('normalizes Poppler coordinate systems and infers headings/font sizes', () => {
    const bboxPages = parseBboxPages(BBOX_XML);
    const htmlPages = parsePdfToHtmlPages(HTML_XML.replace(/width="595"/g, 'width="1190"').replace(/height="842"/g, 'height="1684"'));
    const pages = combinePopplerModels(bboxPages, htmlPages);

    expect(pages[0].width).toBe(595);
    expect(pages[0].words.find(word => word.text === 'Kurzbewertung').fontSize).toBe(8);
    expect(pages[0].headings).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Kurzbewertung', level: 2, xMin: 24, yMin: 24 }),
    ]));
    expect(pages[1].links[0]).toEqual(expect.objectContaining({
      xMin: 24,
      yMin: 44,
      xMax: 124,
      yMax: 49.5,
    }));
  });

  test('applies explicit image semantics without guessing map meaning', () => {
    const pages = combinePopplerModels(
      parseBboxPages(BBOX_XML),
      parsePdfToHtmlPages(HTML_XML),
      {
        imageHints: [{
          page: 1,
          imageId: 'map-1.png',
          kind: 'map',
          altText: 'Übersichtskarte mit Unfallpunkten.',
          caption: 'Abbildung 1: Übersichtskarte.',
          sourceIds: ['accidents.de.unfallatlas', 'basemap.openstreetmap'],
          sourceWidth: 1200,
          sourceHeight: 800,
        }],
      }
    );
    expect(pages[0].images[0]).toEqual(expect.objectContaining({
      kind: 'map',
      altText: 'Übersichtskarte mit Unfallpunkten.',
      caption: 'Abbildung 1: Übersichtskarte.',
      sourceIds: ['accidents.de.unfallatlas', 'basemap.openstreetmap'],
      sourceWidth: 1200,
      sourceHeight: 800,
    }));
  });

  test('extracts a real file through configurable Poppler executables', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-poppler-adapter-'));
    try {
      const pdf = path.join(directory, 'fixture.pdf');
      fs.writeFileSync(pdf, '%PDF-1.7\nfixture\n');
      const executables = fakeExecutables(directory);
      const model = extractPopplerDocument(pdf, {
        ...executables,
        documentId: 'fixture-document',
        renderer: 'native-pdf-poppler',
        contract: {
          requiredHeadings: ['Kurzbewertung', 'Datenquellen'],
          requiredLinks: [
            'https://unfallatlas.statistikportal.de/',
            'https://www.openstreetmap.org/copyright',
          ],
        },
      });

      expect(model.documentId).toBe('fixture-document');
      expect(model.renderer).toBe('native-pdf-poppler');
      expect(model.pages).toHaveLength(2);
      expect(model.requiredHeadings).toEqual(['Kurzbewertung', 'Datenquellen']);
      expect(model.requiredLinks).toHaveLength(2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('CLI writes the normalized model and audit report', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-poppler-cli-'));
    const oldPath = process.env.PATH;
    try {
      const pdf = path.join(directory, 'fixture.pdf');
      const output = path.join(directory, 'out');
      fs.writeFileSync(pdf, '%PDF-1.7\nfixture\n');
      fakeExecutables(directory);
      process.env.PATH = `${directory}${path.delimiter}${oldPath || ''}`;
      const result = main([
        '--pdf', pdf,
        '--out-dir', output,
        '--document-id', 'cli-fixture',
        '--no-audit',
      ]);

      expect(result.model.documentId).toBe('cli-fixture');
      expect(fs.existsSync(path.join(output, 'rendered-document.json'))).toBe(true);
      const written = JSON.parse(fs.readFileSync(path.join(output, 'rendered-document.json'), 'utf8'));
      expect(written.pages).toHaveLength(2);
      expect(result.report.summary.wordCount).toBeGreaterThan(0);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed when the Poppler tools disagree on page count', () => {
    const onePageHtml = HTML_XML.replace(/<page number="2"[\s\S]*?<\/page>/, '');
    expect(() => combinePopplerModels(
      parseBboxPages(BBOX_XML),
      parsePdfToHtmlPages(onePageHtml)
    )).toThrow(/page_count_mismatch/);
  });

  test.each([
    ['', /missing_poppler_pages/],
    ['<doc><page width="x" height="842"></page></doc>', /invalid_poppler_xml/],
    ['<doc><page width="595" height="842"><word xMin="0">x<\/word></page></doc>', /invalid_poppler_xml/],
  ])('rejects malformed bbox output %#', (xml, expected) => {
    expect(() => parseBboxPages(xml)).toThrow(expected);
  });

  test.each([
    ['', /missing_poppler_pages/],
    ['<pdf2xml><page width="595" height="x"></page></pdf2xml>', /invalid_poppler_xml/],
    ['<pdf2xml><page width="595" height="842"><image left="0" top="0" width="x" height="10"/></page></pdf2xml>', /invalid_poppler_xml/],
  ])('rejects malformed pdftohtml output %#', (xml, expected) => {
    expect(() => parsePdfToHtmlPages(xml)).toThrow(expected);
  });

  test('fails on missing PDFs and failed Poppler processes', () => {
    expect(() => extractPopplerDocument('/does/not/exist.pdf'))
      .toThrow(/missing_pdf/);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-poppler-failure-'));
    try {
      const pdf = path.join(directory, 'fixture.pdf');
      const failing = path.join(directory, 'fail');
      fs.writeFileSync(pdf, '%PDF-1.7\nfixture\n');
      fs.writeFileSync(failing, '#!/usr/bin/env bash\necho broken >&2\nexit 7\n');
      fs.chmodSync(failing, 0o755);
      expect(() => extractPopplerDocument(pdf, {
        pdftotext: failing,
        pdftohtml: failing,
      })).toThrow(PopplerAdapterError);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('real Poppler command contract uses bbox-layout and XML stdout', () => {
    const spy = jest.spyOn(childProcess, 'spawnSync');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-poppler-command-'));
    try {
      const pdf = path.join(directory, 'fixture.pdf');
      fs.writeFileSync(pdf, '%PDF-1.7\nfixture\n');
      spy
        .mockReturnValueOnce({ status: 0, stdout: BBOX_XML, stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: HTML_XML, stderr: '' });
      extractPopplerDocument(pdf);
      expect(spy).toHaveBeenNthCalledWith(1, 'pdftotext', [
        '-bbox-layout', '-enc', 'UTF-8', pdf, '-',
      ], expect.objectContaining({ encoding: 'utf8' }));
      expect(spy).toHaveBeenNthCalledWith(2, 'pdftohtml', [
        '-xml', '-hidden', '-nodrm', '-stdout', pdf,
      ], expect.objectContaining({ encoding: 'utf8' }));
    } finally {
      spy.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
