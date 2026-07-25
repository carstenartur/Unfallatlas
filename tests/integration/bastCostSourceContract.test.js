'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '../..');
const CANONICAL_BAST_COST_URI =
  'https://www.bast.de/DE/Publikationen/Statistik/Unfaelle/volkswirtschaftliche_kosten.html';
const LEGACY_BAST_COST_PATH =
  ['/DE/Statistik', 'Unfaelle', 'volkswirtschaftliche_kosten.html'].join('/');
const GOVDATA_LICENSE_URI = 'https://www.govdata.de/dl-de/by-2-0';

const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function occurrenceCount(text, needle) {
  return text.split(needle).length - 1;
}

function gitGrepTracked(needle) {
  // `git grep` scans every tracked file, including large text artifacts and
  // binary files, without loading the whole repository into the Jest process.
  const result = spawnSync('git', ['grep', '-n', '-F', needle, '--'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`git grep failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

function evaluateBrowserScript(relative) {
  // The production browser files are IIFEs. Direct eval matches the existing
  // renderer tests and lets us inspect the exact exported runtime contracts.
  eval(read(relative));
}

function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

async function pdfBuffer(pdfDocument) {
  try {
    const value = pdfDocument.getBuffer();
    if (value && typeof value.then === 'function') return Buffer.from(await value);
  } catch (_) {
    // Older pdfmake builds expose only the callback form.
  }
  return await new Promise((resolve, reject) => {
    try {
      pdfDocument.getBuffer(value => resolve(Buffer.from(value)));
    } catch (error) {
      reject(error);
    }
  });
}

function inspectPdfUrls(buffer) {
  const script = String.raw`
    import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const bytes = new Uint8Array(Buffer.from(Buffer.concat(chunks).toString('utf8'), 'base64'));
    const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
    const urls = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      for (const annotation of await page.getAnnotations()) {
        if (annotation.url) urls.push(annotation.url);
        if (annotation.unsafeUrl) urls.push(annotation.unsafeUrl);
      }
    }
    process.stdout.write(JSON.stringify(urls));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    input: buffer.toString('base64'),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`PDF inspection failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function makeFixtureCtx() {
  return {
    CITY_RAW: 'Hannover',
    map: {
      getCenter: () => ({ lat: 52.3759, lng: 9.7320 }),
      getZoom: () => 14,
    },
  };
}

function makeFixtureReportData(references) {
  return {
    text: [
      'Sachverhalt:',
      'Der Testbericht prüft die kanonische BASt-Quellenverknüpfung.',
      '',
      'Beschlussvorschlag:',
      'Die Verwaltung wird um fachliche Prüfung gebeten.',
    ].join('\n'),
    structured: {
      meta: {
        city: 'Hannover',
        areaName: 'Testbereich',
        date: '24.07.2026',
        link: 'https://example.test/werkbank?city=hannover',
        filters: {
          severity: 'all',
          dayType: 'all',
          includeCyclist: true,
          includeCar: true,
          hourFrom: 0,
          hourTo: 24,
        },
        gremium: { typ: 'Bezirksrat', gremium: 'Bezirksrat Test' },
      },
      severity: { total: 1, bySev: { '1': 0, '2': 0, '3': 1 } },
      accidentDetails: { total: 1, rows: [], groups: [] },
      references,
    },
  };
}

function setupRendererRuntime() {
  jest.resetModules();
  const pdfMake = require('pdfmake/build/pdfmake');
  const pdfFonts = require('pdfmake/build/vfs_fonts');
  if (typeof pdfMake.addVirtualFileSystem === 'function') {
    pdfMake.addVirtualFileSystem(pdfFonts);
  } else {
    pdfMake.vfs = pdfFonts;
  }
  window.UA = {};
  window.docx = require('docx');
  window.pdfMake = pdfMake;
  window.saveAs = jest.fn();
  evaluateBrowserScript('js/ua.report_v2.js');
  return window.UA;
}

afterEach(() => {
  delete window.UA;
  delete window.docx;
  delete window.pdfMake;
  delete window.saveAs;
  jest.restoreAllMocks();
  jest.resetModules();
});

describe('canonical BASt cost-source contract', () => {
  test('all repository and runtime consumers agree and the legacy path is absent', () => {
    // Literal counts belong only to artifacts that intrinsically store URLs.
    // JavaScript consumers are checked through their runtime values below so a
    // future shared-constant refactor remains valid.
    const literalArtifacts = {
      'docs/credits.md': 1,
      'data/cost_factors_de.json': 1,
      'templates/references_global.json': 1,
    };
    for (const [relative, expectedCount] of Object.entries(literalArtifacts)) {
      expect(occurrenceCount(read(relative), CANONICAL_BAST_COST_URI)).toBe(expectedCount);
    }

    const consumerFiles = [
      ...Object.keys(literalArtifacts),
      'js/ua.costs.js',
      'js/ua.export_v2.js',
    ];
    for (const relative of consumerFiles) {
      // Reject archive substitution independent of URL scheme.
      expect(read(relative)).not.toMatch(/\bweb\.archive\.org\b/i);
    }

    // Fail on the legacy path anywhere in the tracked repository. The test
    // composes the path above so it does not exempt itself from this scan.
    expect(gitGrepTracked(LEGACY_BAST_COST_PATH)).toEqual([]);

    const creditsMatch = read('docs/credits.md').match(
      /\[BASt[^\]]*Volkswirtschaftliche Kosten[^\]]*\]\((https:[^)]+)\)/
    );
    expect(creditsMatch).not.toBeNull();

    const costsJson = JSON.parse(read('data/cost_factors_de.json'));
    const references = JSON.parse(read('templates/references_global.json'));
    const bastReference = references.documents.find(doc =>
      /Volkswirtschaftliche Kosten von Straßenverkehrsunfällen/.test(doc.title)
    );
    expect(bastReference).toBeDefined();

    window.UA = {};
    evaluateBrowserScript('js/ua.costs.js');
    const fallbackUrl = window.UA.costs.FALLBACK.source.url;
    evaluateBrowserScript('js/ua.export_v2.js');
    const darkFigure = window.UA.DARK_FIGURE_NOTE;
    const darkFigureBast = darkFigure.sources.find(source => /BASt/.test(source.label));
    expect(darkFigureBast).toBeDefined();

    const consumers = {
      documentation: creditsMatch[1],
      machineReadableFactors: costsJson.source.url,
      runtimeFallback: fallbackUrl,
      darkFigurePrimary: darkFigure.sourceUrl,
      darkFigureSourceList: darkFigureBast.url,
      globalReferences: bastReference.url,
    };
    expect(new Set(Object.values(consumers))).toEqual(new Set([CANONICAL_BAST_COST_URI]));
    for (const url of Object.values(consumers)) expect(url).toMatch(/^https:\/\//);

    // Regression guard against the rejected Wayback substitution in #514.
    expect(read('README.md')).toContain(GOVDATA_LICENSE_URI);
    expect(read('js/ua.export_provenance.js')).toContain(GOVDATA_LICENSE_URI);
  });

  test('real DOCX and PDF artifacts expose the canonical URI as an external link', async () => {
    const UA = setupRendererRuntime();
    const references = JSON.parse(read('templates/references_global.json'));
    const reportData = makeFixtureReportData(references);
    const ctx = makeFixtureCtx();

    await UA.exportToWord(ctx, reportData, {
      includeMap: false,
      includePOIs: false,
      includeReferences: true,
    });
    const wordBlob = window.saveAs.mock.calls[0][0];
    const archive = await JSZip.loadAsync(new Uint8Array(await blobToArrayBuffer(wordBlob)));
    const documentXml = await archive.file('word/document.xml').async('string');
    const relationshipsXml = await archive.file('word/_rels/document.xml.rels').async('string');
    expect(documentXml).toContain('Volkswirtschaftliche Kosten von Straßenverkehrsunfällen');
    expect(relationshipsXml).toContain(`Target="${CANONICAL_BAST_COST_URI}"`);
    expect(relationshipsXml).toMatch(
      /<Relationship\b[^>]*Type="[^"]*\/hyperlink"[^>]*TargetMode="External"[^>]*>/
    );

    let capturedPdf;
    const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation(definition => {
      capturedPdf = realCreatePdf(definition);
      capturedPdf.download = jest.fn();
      return capturedPdf;
    });
    await UA.exportToPDF(ctx, reportData, {
      includeMap: false,
      includePOIs: false,
      includeReferences: true,
    });
    const urls = inspectPdfUrls(await pdfBuffer(capturedPdf));
    expect(urls).toContain(CANONICAL_BAST_COST_URI);
  });
});
