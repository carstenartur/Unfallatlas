'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const JSZip = require('jszip');

const LEGACY_SOURCE =
  'Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).';

function readBlob(blob, mode = 'text') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
    if (mode === 'arrayBuffer') reader.readAsArrayBuffer(blob);
    else reader.readAsText(blob);
  });
}

async function pdfBuffer(pdfDocument) {
  try {
    const value = pdfDocument.getBuffer();
    if (value && typeof value.then === 'function') return Buffer.from(await value);
  } catch (_) {
    // Older pdfmake versions expose only the callback form.
  }
  return new Promise((resolve, reject) => {
    try {
      pdfDocument.getBuffer(value => resolve(Buffer.from(value)));
    } catch (error) {
      reject(error);
    }
  });
}

function inspectPdf(buffer) {
  const script = String.raw`
    import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const bytes = new Uint8Array(Buffer.from(Buffer.concat(chunks).toString('utf8'), 'base64'));
    const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
    const visibleText = [];
    const urls = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      visibleText.push(content.items.map(item => item.str).join(' '));
      for (const annotation of await page.getAnnotations()) {
        if (annotation.url) urls.push(annotation.url);
        if (annotation.unsafeUrl) urls.push(annotation.unsafeUrl);
      }
    }
    const metadata = await pdf.getMetadata();
    process.stdout.write(JSON.stringify({
      visible: visibleText.join('\n'),
      urls,
      info: metadata.info || {},
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    input: buffer.toString('base64'),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`PDF inspection failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function pdfInfoEntry(info, name) {
  const containers = [info, info?.Custom]
    .filter(value => value && typeof value === 'object');
  for (const container of containers) {
    const match = Object.entries(container)
      .find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match) return match[1];
  }
  return undefined;
}

function decodeXml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function kmlValue(kml, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(kml).match(
    new RegExp(`<Data name="${escapedName}"><value>([\\s\\S]*?)<\\/value><\\/Data>`),
  );
  if (!match) throw new Error(`Missing KML ExtendedData field ${name}`);
  return decodeXml(match[1]);
}

function testContext() {
  const bounds = {
    contains: ([lat, lon]) => lat >= 52.36 && lat <= 52.39 && lon >= 9.71 && lon <= 9.75,
    getSouth: () => 52.36,
    getWest: () => 9.71,
    getNorth: () => 52.39,
    getEast: () => 9.75,
  };
  return {
    CITY_RAW: 'Hannover',
    accidentDataRetrievedAt: '2026-07-22T11:00:00Z',
    allPts: [{
      lat: 52.376,
      lon: 9.732,
      props: {
        year: '2024',
        ukategorie: '2',
        IstRad: '1',
        IstFuss: '0',
        IstPKW: '1',
        IstKrad: '0',
        IstGkfz: '0',
        IstSonstig: '0',
        ustunde: '8',
        uwochentag: '2',
        strzustand: '0',
      },
    }],
    selectionBounds: bounds,
    involvementMode: 'and',
    ui: {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      incBikeEl: { checked: true },
      incPedEl: { checked: false },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      incGkfzEl: { checked: false },
      incSonEl: { checked: false },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      dayTypeEl: { value: 'all' },
    },
  };
}

function installRuntime() {
  jest.resetModules();
  const docx = require('docx');
  const pdfMake = require('pdfmake/build/pdfmake');
  const pdfFonts = require('pdfmake/build/vfs_fonts');
  if (typeof pdfMake.addVirtualFileSystem === 'function') pdfMake.addVirtualFileSystem(pdfFonts);
  else pdfMake.vfs = pdfFonts;

  const downloads = [];
  const produced = { word: null, pdf: null };
  window.fetch = jest.fn().mockRejectedValue(new Error('offline renderer matrix test'));
  window.saveAs = (blob, filename) => downloads.push({ blob, filename });
  window.docx = docx;
  window.pdfMake = pdfMake;
  window.UA = {
    BUILD: 'renderer-matrix-test-build',
    normKey: value => String(value).toLowerCase(),
    matchesNonInvolvementFilters: () => true,
    ensureExportLibraries: jest.fn(async () => undefined),
    exportToCSV: () => window.saveAs(
      new Blob(['lat,lon,year\n52.376,9.732,2024\n'], { type: 'text/csv;charset=utf-8' }),
      'Unfallatlas_hannover.csv',
    ),
    exportToGeoJSON: () => window.saveAs(
      new Blob([JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [9.732, 52.376] },
          properties: { year: '2024' },
        }],
      })], { type: 'application/geo+json' }),
      'Unfallatlas_hannover.geojson',
    ),
    exportToKML: () => window.saveAs(
      new Blob([
        '<?xml version="1.0"?><kml><Document><name>Hannover</name>' +
        '<Placemark><Point><coordinates>9.732,52.376,0</coordinates></Point></Placemark>' +
        '</Document></kml>',
      ], { type: 'application/vnd.google-earth.kml+xml' }),
      'Unfallatlas_hannover.kml',
    ),
  };
  window.UA.__documentProvenanceOriginals = {
    exportToWord: async () => {
      const { Document, Packer, Paragraph, HeadingLevel } = window.docx;
      const document = new Document({
        sections: [{ children: [
          new Paragraph({ text: 'Renderer matrix DOCX' }),
          new Paragraph({ text: 'DATENQUELLE', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: LEGACY_SOURCE }),
        ] }],
      });
      produced.word = await Packer.toBlob(document);
      return 'word-result';
    },
    exportToPDF: async () => {
      const pdf = window.pdfMake.createPdf({ content: [
        { text: 'Renderer matrix PDF' },
        { text: 'DATENQUELLE', style: 'subheader' },
        { text: LEGACY_SOURCE },
      ] });
      produced.pdf = await pdfBuffer(pdf);
      return 'pdf-result';
    },
  };

  require('../../js/ua.source_manifest');
  const artifactProvenance = require('../../js/ua.artifact_provenance');
  require('../../js/ua.zip');
  require('../../js/ua.export_provenance');
  require('../../js/ua.document_export_provenance');
  return { artifactProvenance, downloads, produced };
}

function findDownload(downloads, suffix) {
  const result = downloads.find(item => item.filename.toLowerCase().endsWith(suffix));
  if (!result) throw new Error(`Missing ${suffix} download`);
  return result;
}

describe('renderer-wide SourceManifest golden matrix', () => {
  afterEach(() => {
    delete window.fetch;
    delete window.saveAs;
    delete window.docx;
    delete window.pdfMake;
    delete window.UA;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('PDF, DOCX, CSV, GeoJSON and KML bind the same frozen manifest and hash', async () => {
    const { artifactProvenance, downloads, produced } = installRuntime();
    const ctx = testContext();

    const csvResult = await window.UA.exportToCSV(ctx);
    const geoResult = await window.UA.exportToGeoJSON(ctx);
    const kmlResult = await window.UA.exportToKML(ctx);
    const wordResult = await window.UA.exportToWord(ctx);
    const pdfResult = await window.UA.exportToPDF(ctx);

    expect(csvResult.manifest).toBe(geoResult.manifest);
    expect(geoResult.manifest).toBe(kmlResult.manifest);
    const normalized = await artifactProvenance.normalizeAndHash(csvResult.manifest);
    for (const result of [wordResult, pdfResult]) {
      expect(result.manifest).toEqual(normalized.manifest);
      expect(result.sourceManifestSha256).toBe(normalized.sha256);
    }

    const csvDownload = findDownload(downloads, '.zip');
    const csvArchive = await JSZip.loadAsync(new Uint8Array(await readBlob(csvDownload.blob, 'arrayBuffer')));
    const csvManifest = JSON.parse(await csvArchive.file('sources.json').async('string'));
    const csvReadme = await csvArchive.file('README.txt').async('string');
    expect(csvManifest).toEqual(normalized.manifest);
    expect(csvReadme).toContain(normalized.sha256);

    const geoDownload = findDownload(downloads, '.geojson');
    const geojson = JSON.parse(await readBlob(geoDownload.blob));
    expect(geojson.metadata.sourceManifest).toEqual(normalized.manifest);
    expect(geojson.metadata['unfallatlas:sourceManifestSha256']).toBe(normalized.sha256);
    expect(geojson.features[0].properties['unfallatlas:sourceIds']).toEqual(
      normalized.manifest.sources.map(source => source.sourceId),
    );

    const kmlDownload = findDownload(downloads, '.kml');
    const kml = await readBlob(kmlDownload.blob);
    expect(kmlValue(kml, 'unfallatlas:sourceManifestSha256')).toBe(normalized.sha256);
    expect(JSON.parse(kmlValue(kml, 'unfallatlas:sourceManifestJson'))).toEqual(normalized.manifest);
    expect(kmlValue(kml, 'unfallatlas:sourceIds').split(',')).toEqual(
      normalized.manifest.sources.map(source => source.sourceId),
    );

    const wordArchive = await JSZip.loadAsync(new Uint8Array(await readBlob(produced.word, 'arrayBuffer')));
    const documentXml = await wordArchive.file('word/document.xml').async('string');
    const relationshipsXml = await wordArchive.file('word/_rels/document.xml.rels').async('string');
    const customPropertiesXml = await wordArchive.file('docProps/custom.xml').async('string');
    expect(documentXml).not.toContain(normalized.sha256);
    expect(documentXml).toContain(normalized.sha256.slice(0, 12));
    expect(documentXml).toContain(normalized.manifest.artifactId);
    expect(customPropertiesXml).toContain('UnfallwerkbankSourceManifestSha256');
    expect(customPropertiesXml).toContain(normalized.sha256);
    expect(customPropertiesXml).toContain('UnfallwerkbankSourceManifest');
    expect(customPropertiesXml).toContain(normalized.manifest.artifactId);
    for (const source of normalized.manifest.sources) {
      expect(relationshipsXml).toContain(`Target="${source.datasetUrl}"`);
      if (source.distributionUrl && source.distributionUrl !== source.datasetUrl) {
        expect(relationshipsXml).toContain(`Target="${source.distributionUrl}"`);
      }
      expect(relationshipsXml).toContain(`Target="${source.licenseUrl}"`);
    }

    const pdf = inspectPdf(produced.pdf);
    expect(pdf.visible.replace(/\s+/g, '')).not.toContain(normalized.sha256);
    expect(pdf.visible).toContain(normalized.sha256.slice(0, 12));
    expect(pdf.visible).toContain(normalized.manifest.artifactId);
    expect(pdfInfoEntry(pdf.info, 'UnfallwerkbankSourceManifestSha256'))
      .toBe(normalized.sha256);
    expect(JSON.parse(pdfInfoEntry(pdf.info, 'UnfallwerkbankSourceManifest')))
      .toEqual(normalized.manifest);
    for (const source of normalized.manifest.sources) {
      expect(pdf.urls).toContain(source.datasetUrl);
      if (source.distributionUrl && source.distributionUrl !== source.datasetUrl) {
        expect(pdf.urls).toContain(source.distributionUrl);
      }
      expect(pdf.urls).toContain(source.licenseUrl);
    }
  });
});
