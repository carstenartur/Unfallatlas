'use strict';

const JSZip = require('jszip');

function validManifest(artifactId = 'document-hannover-export') {
  return {
    schemaVersion: 1,
    artifactId,
    generatedAt: '2026-07-22T12:00:00Z',
    applicationVersion: 'test-build',
    buildFingerprint: 'a'.repeat(64),
    dataFingerprint: 'b'.repeat(64),
    scenario: {
      city: 'Hannover',
      filters: { severity: 'all', involvementMode: 'and' },
      years: [2023, 2024],
      bounds: { south: 52.36, west: 9.71, north: 52.39, east: 9.75 },
    },
    sources: [
      {
        sourceId: 'custom.accidents',
        role: 'accidents',
        publisher: 'Test publisher',
        datasetTitle: 'Custom accident data',
        datasetUrl: 'https://example.com/dataset',
        distributionUrl: 'https://example.com/dataset/2024.geojson',
        licenseId: 'CC0-1.0',
        licenseName: 'Creative Commons CC0 1.0 Universal',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        requiredAttribution: 'Test publisher – Custom accident data',
        temporalCoverage: '2023–2024',
        spatialCoverage: 'Hannover',
        versionOrPublicationDate: '2025-01-01',
        retrievedAt: '2026-07-22T11:00:00Z',
        contentHash: 'c'.repeat(64),
        changedOrDerived: true,
        changeNotice: 'Räumlich und nach Beteiligung gefiltert.',
        qualityNotes: ['Testdaten für die Binärartefakt-QA.'],
      },
    ],
    transformations: [
      {
        transformationId: 'filter.viewport',
        label: 'Räumliche Auswahl',
        description: 'Auswahl auf den dokumentierten Kartenausschnitt.',
        sourceIds: ['custom.accidents'],
        outputFields: ['geometry', 'properties'],
      },
    ],
  };
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
    // Older pdfmake versions expose only the callback form.
  }
  return await new Promise((resolve, reject) => {
    try {
      pdfDocument.getBuffer(value => resolve(Buffer.from(value)));
    } catch (error) {
      reject(error);
    }
  });
}

function setupRuntime() {
  jest.resetModules();

  const docx = require('docx');
  const pdfMake = require('pdfmake/build/pdfmake');
  const pdfFonts = require('pdfmake/build/vfs_fonts');
  if (typeof pdfMake.addVirtualFileSystem === 'function') pdfMake.addVirtualFileSystem(pdfFonts);
  else pdfMake.vfs = pdfFonts;

  const produced = { word: null, pdf: null };
  const createManifest = jest.fn(async ctx => validManifest(ctx.artifactId));

  window.docx = docx;
  window.pdfMake = pdfMake;
  window.UA = {
    ensureExportLibraries: jest.fn(async () => undefined),
    exportProvenanceRuntime: { createManifest },
    artifactProvenance: require('../../js/ua.artifact_provenance'),
  };

  window.UA.__exportProvenanceOriginals = {
    exportToWord: async () => {
      const { Document, Packer, Paragraph } = window.docx;
      const document = new Document({
        sections: [{ children: [new Paragraph({ text: 'Base DOCX document' })] }],
      });
      produced.word = await Packer.toBlob(document);
      return 'word-result';
    },
    exportToPDF: async () => {
      const pdf = window.pdfMake.createPdf({ content: [{ text: 'Base PDF document' }] });
      produced.pdf = await pdfBuffer(pdf);
      return 'pdf-result';
    },
  };

  const api = require('../../js/ua.document_export_provenance');
  return { api, produced, createManifest, docx, pdfMake };
}

describe('live PDF/DOCX exports use the shared SourceManifest', () => {
  afterEach(() => {
    delete window.docx;
    delete window.pdfMake;
    delete window.UA;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('DOCX contains visible provenance and real external hyperlink relationships', async () => {
    const { produced, createManifest } = setupRuntime();
    const result = await window.UA.exportToWord({ artifactId: 'docx-hannover-export' });

    expect(createManifest).toHaveBeenCalledTimes(1);
    expect(result.format).toBe('docx');
    expect(result.result).toBe('word-result');
    expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(produced.word).toBeInstanceOf(Blob);

    const archive = await JSZip.loadAsync(new Uint8Array(await blobToArrayBuffer(produced.word)));
    const documentXml = await archive.file('word/document.xml').async('string');
    const relationshipsXml = await archive.file('word/_rels/document.xml.rels').async('string');

    expect(documentXml).toContain('DATENQUELLEN, METHODIK UND NACHVOLLZIEHBARKEIT');
    expect(documentXml).toContain('docx-hannover-export');
    expect(documentXml).toContain(result.sourceManifestSha256);
    expect(documentXml).toContain('Datensatzseite öffnen');
    expect(documentXml).toContain('Lizenztext öffnen (CC0-1.0)');
    expect(documentXml).not.toContain('https://example.com/dataset');
    expect(documentXml).not.toContain('https://creativecommons.org/publicdomain/zero/1.0/');

    expect(relationshipsXml).toContain('Target="https://example.com/dataset"');
    expect(relationshipsXml).toContain('Target="https://example.com/dataset/2024.geojson"');
    expect(relationshipsXml).toContain('Target="https://creativecommons.org/publicdomain/zero/1.0/"');
    const externalHyperlinks = [...relationshipsXml.matchAll(
      /<Relationship\b[^>]*Type="[^"]*\/hyperlink"[^>]*TargetMode="External"[^>]*>/g,
    )];
    expect(externalHyperlinks.length).toBeGreaterThanOrEqual(3);
  });

  test('PDF contains visible provenance and extracted link annotations', async () => {
    const { produced, createManifest } = setupRuntime();
    const result = await window.UA.exportToPDF({ artifactId: 'pdf-hannover-export' });

    expect(createManifest).toHaveBeenCalledTimes(1);
    expect(result.format).toBe('pdf');
    expect(result.result).toBe('pdf-result');
    expect(produced.pdf.length).toBeGreaterThan(500);

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(produced.pdf),
      disableWorker: true,
    }).promise;
    const visibleText = [];
    const urls = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      visibleText.push(content.items.map(item => item.str).join(' '));
      const annotations = await page.getAnnotations();
      annotations.forEach(annotation => {
        if (annotation.url) urls.push(annotation.url);
        if (annotation.unsafeUrl) urls.push(annotation.unsafeUrl);
      });
    }

    const visible = visibleText.join('\n');
    expect(visible).toContain('DATENQUELLEN, METHODIK UND NACHVOLLZIEHBARKEIT');
    expect(visible).toContain('pdf-hannover-export');
    expect(visible).toContain(result.sourceManifestSha256);
    expect(visible).toContain('Datensatzseite öffnen');
    expect(visible).toContain('Lizenztext öffnen (CC0-1.0)');
    expect(urls).toContain('https://example.com/dataset');
    expect(urls).toContain('https://example.com/dataset/2024.geojson');
    expect(urls).toContain('https://creativecommons.org/publicdomain/zero/1.0/');
  });

  test('invalid provenance fails before either original document renderer runs', async () => {
    const { produced, createManifest } = setupRuntime();
    createManifest.mockResolvedValueOnce({ schemaVersion: 1, sources: [] });

    await expect(window.UA.exportToWord({ artifactId: 'broken' })).rejects.toThrow();
    expect(produced.word).toBeNull();
    expect(produced.pdf).toBeNull();
  });

  test('simultaneous document exports are serialized and keep their own snapshot', async () => {
    const { produced } = setupRuntime();
    const [word, pdf] = await Promise.all([
      window.UA.exportToWord({ artifactId: 'parallel-word' }),
      window.UA.exportToPDF({ artifactId: 'parallel-pdf' }),
    ]);

    expect(word.manifest.artifactId).toBe('parallel-word');
    expect(pdf.manifest.artifactId).toBe('parallel-pdf');
    expect(produced.word).not.toBeNull();
    expect(produced.pdf).not.toBeNull();

    const archive = await JSZip.loadAsync(new Uint8Array(await blobToArrayBuffer(produced.word)));
    const documentXml = await archive.file('word/document.xml').async('string');
    expect(documentXml).toContain('parallel-word');
    expect(documentXml).not.toContain('parallel-pdf');
  });
});
