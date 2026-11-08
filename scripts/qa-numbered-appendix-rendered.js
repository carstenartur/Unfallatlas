#!/usr/bin/env node
'use strict';

// Release acceptance: real published Unfallatlas points, production cohort /
// document/provenance exporters, and an explicitly synthetic test basemap.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');
const JSZip = require('jszip');
const evidence = require('../js/ua.evidence_cohort');
const provenance = require('../js/ua.export_provenance');
const artifact = require('../js/ua.artifact_provenance');
const documentProvenance = require('../js/ua.document_export_provenance');
const {
  createRoleMapFixture,
  verifyRoleMapFixtures,
  sha256
} = require('./release-map-fixture');
const {
  toDataUrl
} = require('./deterministic-map-fixture');
const poppler = require('./poppler-rendered-document');
const libreOffice = require('./libreoffice-rendered-document');
const audit = require('./rendered-document-audit');
const tables = require('./rendered-table-hints');
const {
  validateTableContinuity
} = require('./enrich-rendered-document-tables');
const BOUNDS = Object.freeze({
  south: 50.730,
  west: 7.091,
  north: 50.732,
  east: 7.101
});
const HEADERS = Object.freeze(['ID', 'Jahr', 'Schwere', 'Beteiligte', 'Zeit', 'Zustand', 'Rolle', 'Karte']);
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true
  });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function assertSameIds(expected, actual, label) {
  const a = [...expected].sort(),
    b = [...actual].sort();
  if (new Set(b).size !== b.length || JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: missing, duplicate or unexpected accident IDs`);
  return true;
}
function cellsForEvidenceRow(row) {
  return [row.displayId, String(row.year ?? '—'), row.severityLabel, row.involvementLabel, row.hour == null ? '—' : `${String(row.hour).padStart(2, '0')}:00`, row.roadConditionLabel, row.discoveryMatch ? 'Suchmuster' : 'weitere Gebietsevidenz', row.mapRef || '—'];
}
function pattern(value) {
  return '^' + tables.normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '/\\s*') + '$';
}
function reconstructAppendixTables(model, expectedRows, options = {}) {
  const expected = new Map(expectedRows.map(r => [r.displayId, r]));
  const ids = [],
    tablePages = [];
  for (const page of model.pages) {
    const lines = tables.clusterWordsIntoLines(page.words);
    // Only a page with the complete real table header can supply rows; IDs in
    // map captions and explanatory prose must never satisfy table evidence.
    let header;
    try {
      header = tables.locateHeader(lines, HEADERS, 'complete-evidence');
    } catch (error) {
      if (error.code === 'table_header_missing') continue;
      throw error;
    }
    const left = header.centres[0],
      right = (header.centres[0] + header.centres[1]) / 2;
    const found = lines.slice(header.lineIndex + 1).flatMap(line => line.words.filter(w => /^A\d{3,}$/.test(w.text) && w.xMin < right && w.xMax > left - 25).map(w => w.text));
    if (!found.length) throw new Error(`Header without complete evidence rows on page ${page.number}`);
    const rowHints = found.map(id => {
      if (!expected.has(id)) throw new Error(`Unexpected rendered table ID ${id}`);
      if (ids.includes(id)) throw new Error(`Duplicate rendered table ID ${id}`);
      ids.push(id);
      return {
        rowId: id,
        cellPatterns: cellsForEvidenceRow(expected.get(id)).map(pattern),
        maxLines: 5
      };
    });
    const hint = {
      page: page.number,
      tableId: 'complete-evidence',
      headers: HEADERS,
      headerAlignment: 'left',
      rowIds: found,
      rows: rowHints,
      maxLinesPerRow: 5,
      repeatedHeader: tablePages.length > 0
    };
    // reconstructTable independently locates all visible cells and their boxes.
    page.tableRows = tables.reconstructTable(page.words, hint).map(r => ({
      ...r
    }));
    tablePages.push(page.number);
  }
  assertSameIds(expectedRows.map(r => r.displayId), ids, 'final rendered table');
  if (options.requirePagination !== false && tablePages.length < 2) throw new Error('Release appendix did not exercise table pagination');
  validateTableContinuity(model.pages);
  return {
    ids,
    tablePages,
    rowCount: ids.length,
    headerCount: tablePages.length
  };
}
function loadRealContext(root, { clock = () => new Date() } = {}) {
  const sourcePath = path.join(root, 'out', 'output_all_years_bonn.geojson.gz');
  const sourceBytes = fs.readFileSync(sourcePath);
  // One observed local acquisition clock for these bytes; this is not an
  // upstream download timestamp and never derives from file mtime.
  const sourceAcquisition = Object.freeze({
    kind: 'local-file-read',
    acquiredAt: clock().toISOString(),
    upstreamRetrievedAt: null
  });
  const collection = JSON.parse(zlib.gunzipSync(sourceBytes));
  const points = collection.features.filter(f => {
    const [lon, lat] = f.geometry.coordinates;
    return lat >= BOUNDS.south && lat <= BOUNDS.north && lon >= BOUNDS.west && lon <= BOUNDS.east;
  }).map(f => ({
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    props: {
      ...f.properties
    }
  }));
  if (points.length < 80) throw new Error('Published Bonn fixture must contain enough real accidents to paginate');
  const bounds = {
    ...BOUNDS,
    getSouth: () => BOUNDS.south,
    getWest: () => BOUNDS.west,
    getNorth: () => BOUNDS.north,
    getEast: () => BOUNDS.east
  };
  const filtered = points.filter(p => p.props.istrad === '1' && p.props.istpkw === '1');
  return {
    sourcePath,
    sourceSha256: sha256(sourceBytes),
    sourceAcquisition,
    ctx: {
      CITY_RAW: 'Bonn',
      // The numbered appendix displays core accident fields, not context layers.
      exportContextEvidence: false,
      allPts: points,
      filteredAll: filtered,
      viewportPts: filtered,
      selectionBounds: bounds,
      involvementMode: 'and',
      dataRetrievedAt: sourceAcquisition.acquiredAt,
      ui: {
        severityEl: {
          value: 'all'
        },
        roadConditionEl: {
          value: 'all'
        },
        dayTypeEl: {
          value: 'all'
        },
        hFromEl: {
          value: '0'
        },
        hToEl: {
          value: '23'
        },
        incBikeEl: {
          checked: true
        },
        incCarEl: {
          checked: true
        },
        incPedEl: {
          checked: false
        },
        incMotoEl: {
          checked: false
        },
        incGkfzEl: {
          checked: false
        },
        incSonEl: {
          checked: false
        }
      }
    }
  };
}
function paddedBounds(b) {
  const dy = Math.max(b.north - b.south, .00015) * .08,
    dx = Math.max(b.east - b.west, .00015) * .08;
  return {
    south: b.south - dy,
    west: b.west - dx,
    north: b.north + dy,
    east: b.east + dx
  };
}
async function generateReleaseEvidence(options = {}) {
  const rootDir = options.root || path.resolve(__dirname, '..'),
    outDir = path.resolve(options.outDir || path.join(rootDir, 'out/qa/release-document'));
  fs.mkdirSync(outDir, {
    recursive: true
  });
  fs.rmSync(path.join(outDir, 'release-evidence.json'), {
    force: true
  });
  const loaded = loadRealContext(rootDir),
    ctx = loaded.ctx;
  const report = {
    structured: {
      meta: {
        city: 'Bonn',
        areaName: 'Bonn Hauptbahnhof – veröffentlichte Gebietsevidenz auf deterministischer Testkarte',
        link: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&selSouth=50.730&selWest=7.091&selNorth=50.732&selEast=7.101',
        filters: {
          includeCyclist: true,
          includeCar: true,
          involvementMode: 'and'
        }
      }
    }
  };
  const pdfMake = require('./pdfmake-node');
  let pdfDownload, wordDownload;
  const capturedMaps = [];
  const root = {
    UA: {},
    location: {
      href: report.structured.meta.link
    },
    docx: require('docx'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: fn => setTimeout(fn, 0),
    saveAs: blob => {
      wordDownload = blob;
    },
    pdfMake: {
      createPdf(def) {
        const doc = pdfMake.createPdf(def);
        doc.download = () => {
          pdfDownload = doc.getBuffer();
        };
        return doc;
      }
    }
  };
  const UA = root.UA;
  const rendererFingerprint = sha256(['ua.evidence_cohort.js', 'ua.report_v2.js', 'ua.document_export_provenance.js'].map(f => fs.readFileSync(path.join(rootDir, 'js', f), 'utf8')).join('\n'));
  UA.BUILD = 'Unfallwerkbank 2.1.4 – Release-QA';
  UA.normKey = value => String(value).toLowerCase();
  UA.ensureExportLibraries = async () => {};
  UA.artifactProvenance = artifact;
  UA.exportProvenanceRuntime = {
    createManifest: provenance.createManifest
  };
  UA.readPngDimensions = () => ({
    width: 1200,
    height: 800
  });
  UA.fitWithAspectRatio = (size, max) => {
    const scale = Math.min(max.width / size.width, max.height / size.height);
    return {
      width: size.width * scale,
      height: size.height * scale
    };
  };
  const cohorts = evidence.buildCohorts(UA, ctx, report, root);
  const rows = cohorts.completeEvidenceCohort.rows;
  let manifest = JSON.parse(JSON.stringify(await provenance.createManifest(ctx, {
    UA,
    root
  })));
  manifest.buildFingerprint = rendererFingerprint;
  const accidentSource = manifest.sources.find(s => s.sourceId === 'accidents.de.unfallatlas');
  accidentSource.qualityNotes = [...(accidentSource.qualityNotes || []),
    'retrievedAt records local QA fixture file acquisition; original upstream retrieval time is unknown.'];
  manifest.sources.push({
    sourceId: 'qa.basemap.deterministic',
    role: 'basemap',
    publisher: 'Unfallwerkbank QA',
    datasetTitle: 'Deterministic test basemap — illustrative roads; no live tiles',
    datasetUrl: 'https://github.com/carstenartur/Unfallatlas',
    licenseId: 'CC0-1.0',
    licenseName: 'Creative Commons CC0 1.0 Universal',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    retrievedAt: manifest.generatedAt,
    changedOrDerived: false,
    qualityNotes: ['Synthetic test cartography; accident positions are real published Unfallatlas records.']
  });
  manifest.transformations.push({
    transformationId: 'qa-real-bonn-numbered-appendix',
    label: 'Reale Gebietsevidenz auf deterministischer Testkarte',
    description: 'Vollständige veröffentlichte Unfallmenge innerhalb der festen Grenzen; stabile A###-IDs, räumlich partitionierte Detailkarten; keine Live-Kacheln.',
    sourceIds: ['accidents.de.unfallatlas', 'qa.basemap.deterministic'],
    softwareVersion: UA.BUILD,
    parameters: {
      sourceSha256: loaded.sourceSha256,
      sourceAcquisition: loaded.sourceAcquisition,
      bounds: BOUNDS,
      accidentIds: rows.map(r => r.displayId)
    },
    outputFields: ['evidence_id', 'source_fingerprint', 'map_ref']
  });
  const normalized = await artifact.normalizeAndHash(manifest);
  ctx.exportSourceManifest = normalized.manifest;
  let currentBounds = BOUNDS;
  ctx.map = {
    getCenter: () => ({
      lat: 50.731,
      lng: 7.096
    }),
    getZoom: () => 16,
    getBounds: () => ctx.selectionBounds,
    fitBounds: b => {
      currentBounds = paddedBounds({
        south: b[0][0],
        west: b[0][1],
        north: b[1][0],
        east: b[1][1]
      });
    },
    setView: () => {}
  };
  UA.captureExportMapImage = async (_ctx, opts) => {
    const mapRows = opts.evidenceRows,
      role = mapRows.length === rows.length ? 'overview' : `detail-${mapRows[0].mapRef.toLowerCase()}`;
    const map = createRoleMapFixture({
      role,
      points: mapRows.map(r => ({
        id: r.displayId,
        lat: r.lat,
        lon: r.lon,
        severity: r.severity
      })),
      bounds: currentBounds,
      snapshotHash: normalized.sha256
    });
    capturedMaps.push(map);
    return toDataUrl(map.png);
  };
  UA.__documentProvenanceOriginals = {
    exportToWord: () => evidence._internal.exportEvidenceWord(UA, root, ctx, report, cohorts),
    exportToPDF: () => evidence._internal.exportEvidencePdf(UA, root, ctx, report, cohorts)
  };
  documentProvenance.install(UA, root);
  const word = await UA.exportToWord(ctx);
  if (!wordDownload) throw new Error('Production Word appendix did not download');
  fs.writeFileSync(path.join(outDir, 'appendix.docx'), Buffer.from(await wordDownload.arrayBuffer()));
  const wordMaps = capturedMaps.splice(0);
  verifyRoleMapFixtures(wordMaps, normalized.sha256);
  const pdf = await UA.exportToPDF(ctx);
  if (!pdfDownload) throw new Error('Production PDF appendix did not download');
  fs.writeFileSync(path.join(outDir, 'appendix.pdf'), Buffer.from(await pdfDownload));
  const pdfMaps = capturedMaps.splice(0);
  verifyRoleMapFixtures(pdfMaps, normalized.sha256);
  assertSameIds(wordMaps.map(m => m.receipt.sha256), pdfMaps.map(m => m.receipt.sha256), 'PDF/Word map roles and pixels');
  for (const m of wordMaps) fs.writeFileSync(path.join(outDir, `${m.receipt.role}.png`), m.png);
  const csv = evidence.appendixCsv(cohorts);
  const geojson = (await artifact.attachGeoJsonProvenance(evidence.appendixGeoJson(cohorts), normalized.manifest, {
    defaultSourceIds: ['accidents.de.unfallatlas']
  })).geojson;
  const csvPackage = await artifact.buildCsvPackageEntries({
    baseName: 'appendix',
    csv,
    manifest: normalized.manifest
  });
  const packageZip = new JSZip();
  for (const entry of csvPackage.entries) packageZip.file(entry.name, entry.content);
  fs.writeFileSync(path.join(outDir, 'appendix.zip'), await packageZip.generateAsync({
    type: 'nodebuffer'
  }));
  fs.writeFileSync(path.join(outDir, 'appendix.csv'), csv);
  writeJson(path.join(outDir, 'appendix.geojson'), geojson);
  const diskCsv = fs.readFileSync(path.join(outDir, 'appendix.csv'), 'utf8'),
    diskGeoJson = JSON.parse(fs.readFileSync(path.join(outDir, 'appendix.geojson'), 'utf8'));
  const ids = rows.map(r => r.displayId);
  assertSameIds(ids, diskCsv.trim().split(/\r?\n/).slice(1).map(line => line.split(';')[0].replace(/^"|"$/g, '')), 'CSV');
  assertSameIds(ids, diskGeoJson.features.map(f => f.properties.evidence_id), 'GeoJSON');
  assertSameIds(ids, wordMaps[0].receipt.accidentIds, 'overview map');
  assertSameIds(ids, wordMaps.slice(1).flatMap(m => m.receipt.accidentIds), 'partitioned detail maps');
  writeJson(path.join(outDir, 'source-manifest.json'), normalized.manifest);
  writeJson(path.join(outDir, 'cohorts.json'), cohorts);
  writeJson(path.join(outDir, 'maps.json'), wordMaps.map(m => m.receipt));
  const contract = {
    schemaVersion: 1,
    requireSourceManifestHash: true,
    expectedSourceManifestHash: normalized.sha256,
    sourceGeoJsonSha256: loaded.sourceSha256,
    sourceAcquisition: loaded.sourceAcquisition,
    expectedAccidentIds: ids,
    expectedTableHeaders: HEADERS,
    expectedMaps: wordMaps.map(m => m.receipt),
    requiredLinks: ['https://www.statistikportal.de/de/karten/unfallatlas'],
    microsoftWordEvidenceVerified: false
  };
  writeJson(path.join(outDir, 'release-contract.json'), contract);
  return {
    outDir,
    ctx,
    cohorts,
    contract,
    word,
    pdf
  };
}
function decodeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
async function verifyEmbeddedManifest(hash, json, expected, label) {
  if (hash !== expected) throw new Error(`${label} source manifest hash mismatch`);
  const actual = await artifact.normalizeAndHash(JSON.parse(json));
  if (actual.sha256 !== expected) throw new Error(`${label} embedded source manifest content mismatch`);
  return actual.sha256;
}
async function verifyDocxManifest(file, manifestHash) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const part = zip.file('docProps/custom.xml');
  if (!part) throw new Error('DOCX source manifest metadata is missing');
  const xml = await part.async('string');
  const properties = [...xml.matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property>/g)];
  const value = name => {
    const property = properties.find(item => item[1].includes(`name="${name}"`));
    const match = property && property[2].match(/<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/);
    if (!match) throw new Error(`DOCX ${name} metadata is missing`);
    return decodeXml(match[1]);
  };
  return verifyEmbeddedManifest(value('UnfallwerkbankSourceManifestSha256'), value('UnfallwerkbankSourceManifest'), manifestHash, 'DOCX');
}
async function verifyPdfManifest(file, manifestHash) {
  const result = cp.spawnSync('pdfinfo', ['-custom', file], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`Cannot inspect PDF source metadata: ${result.stderr}`);
  const hash = result.stdout.match(/^UnfallwerkbankSourceManifestSha256:\s*([a-f0-9]{64})/m);
  const json = result.stdout.match(/^UnfallwerkbankSourceManifest:\s*(.*)$/m);
  if (!hash || !json) throw new Error('PDF source manifest metadata is missing');
  return verifyEmbeddedManifest(hash[1], json[1], manifestHash, 'PDF');
}
async function verifyRenderedMapPixels(model, contract) {
  // png-js is the PNG decoder already pinned by pdfmake in package-lock.json.
  const PNG = require('png-js');
  const images = model.pages.flatMap(page => page.images.map(image => ({
    page: page.number,
    image
  })));
  if (images.length !== contract.expectedMaps.length) throw new Error('Final rendered map count mismatch');
  const bindings = [];
  for (const [index, {
    page,
    image
  }] of images.entries()) {
    const expected = contract.expectedMaps[index];
    const png = new PNG(fs.readFileSync(image.imageId));
    const pixels = await new Promise(resolve => png.decode(resolve));
    if (png.width !== expected.width || png.height !== expected.height || sha256(pixels) !== expected.pixelSha256) throw new Error(`Final map pixels differ for role ${expected.role}`);
    bindings.push({
      role: expected.role,
      page,
      imageId: image.imageId,
      pixelSha256: expected.pixelSha256,
      accidentIds: expected.accidentIds
    });
  }
  return bindings;
}
function verifyRenderedMapCaptions(model, contract, format) {
  if (!['native-pdf', 'docx-pdf'].includes(format)) throw new Error('Unknown caption format');
  const images = model.pages.flatMap(page => page.images.map(image => ({ page, image })));
  if (images.length !== contract.expectedMaps.length) throw new Error('Caption map count mismatch');
  return images.map(({ page, image }, index) => {
    const expected = contract.expectedMaps[index];
    const overview = expected.role === 'overview';
    const mapRef = overview ? 'E0' : expected.role.replace(/^detail-/, '').toUpperCase();
    const title = overview ? 'Übersicht – vollständiges Gebietskollektiv' :
      `Detail ${mapRef} – ${expected.accidentIds[0]} bis ${expected.accidentIds.at(-1)}`;
    const idCaption = format === 'docx-pdf' || !overview;
    const expectedText = tables.normalizeText(`Abbildung ${index + 1}: ${
      format === 'native-pdf' && !overview ? mapRef : title}; ${idCaption ?
      `Unfall-IDs: ${expected.accidentIds.join(', ')}.` :
      `dargestellt und nummeriert: ${expected.markerCount} Unfälle.`}`);
    const nextImage = page.images.filter(other => other.yMin > image.yMax)
      .sort((a, b) => a.yMin - b.yMin)[0];
    const lines = tables.clusterWordsIntoLines(page.words).filter(line =>
      line.yMin >= image.yMax - 2 && (!nextImage || line.yMax < nextImage.yMin));
    // The actual caption must start directly below its own image on this page.
    // Only consecutive positioned lines may supply its text; prose elsewhere
    // or our later map annotations cannot satisfy this assertion.
    if (!lines.length || lines[0].yMin - image.yMax > 36) {
      throw new Error(`Missing adjacent caption for ${expected.role} on page ${page.number}`);
    }
    const found = [];
    let text = '';
    for (const line of lines) {
      if (found.length && line.yMin - found.at(-1).yMax > 20) break;
      found.push(line);
      text = tables.normalizeText(found.map(item => item.text).join(' '));
      if (text.length >= expectedText.length) break;
    }
    if (text !== expectedText) throw new Error(`Rendered caption mismatch for ${expected.role} on page ${page.number}: ${text}`);
    return {
      role: expected.role,
      page: page.number,
      text,
      assertedFields: idCaption ? ['figure', 'role', 'accidentIds'] : ['figure', 'role', 'populationCount'],
      ...(idCaption ? { accidentIds: expected.accidentIds } : { markerCount: expected.markerCount }),
      bounds: {
        xMin: Math.min(...found.map(line => line.xMin)),
        xMax: Math.max(...found.map(line => line.xMax)),
        yMin: found[0].yMin,
        yMax: found.at(-1).yMax
      }
    };
  });
}
function addMapEvidence(model, contract, captionBindings) {
  const images = model.pages.flatMap(page => page.images.map(image => ({
    page,
    image
  })));
  if (images.length !== contract.expectedMaps.length) throw new Error(`Expected ${contract.expectedMaps.length} final maps, got ${images.length}`);
  images.forEach(({
    image
  }, i) => Object.assign(image, {
    kind: 'map',
    altText: `Numbered ${contract.expectedMaps[i].role}`,
    caption: captionBindings[i].text,
    sourceIds: ['accidents.de.unfallatlas', 'qa.basemap.deterministic'],
    sourceWidth: 1200,
    sourceHeight: 800
  }));
  return model;
}
async function runReleaseQa(options = {}) {
  const generated = await generateReleaseEvidence(options),
    {
      outDir,
      contract,
      cohorts
    } = generated;
  const nativeFile = path.join(outDir, 'appendix.pdf'),
    wordFile = path.join(outDir, 'appendix.docx');
  const nativeHash = await verifyPdfManifest(nativeFile, contract.expectedSourceManifestHash),
    wordHash = await verifyDocxManifest(wordFile, contract.expectedSourceManifestHash);
  const conversion = libreOffice.main(['--docx', wordFile, '--out-dir', path.join(outDir, 'docx'), '--document-id', 'release-numbered-bonn', '--no-audit']);
  const results = [];
  for (const [format, file, observed] of [['native-pdf', nativeFile, nativeHash], ['docx-pdf', path.join(outDir, 'docx', 'converted.pdf'), wordHash]]) {
    const model = poppler.extractPopplerDocument(file, {
      documentId: `release-numbered-${format}`,
      contract,
      verifiedSourceManifestHash: observed
    });
    const mapBindings = await verifyRenderedMapPixels(model, contract);
    const captionBindings = verifyRenderedMapCaptions(model, contract, format);
    addMapEvidence(model, contract, captionBindings);
    const rows = reconstructAppendixTables(model, cohorts.completeEvidenceCohort.rows);
    const dir = path.join(outDir, format);
    writeJson(path.join(dir, 'rendered-document.json'), model);
    const report = audit.assertRenderedDocument(model);
    writeJson(path.join(dir, 'audit.json'), report);
    const pages = libreOffice.renderPdfPages(file, path.join(dir, 'pages'));
    if (pages.length !== model.pages.length) throw new Error('Final page image count differs from independently extracted model');
    results.push({
      format,
      sourceManifestHash: observed,
      pdfSha256: sha256(fs.readFileSync(file)),
      pages: model.pages.length,
      ...rows,
      mapBindings,
      captionBindings,
      audit: report
    });
  }
  const artifactHashes = Object.fromEntries(['appendix.docx', 'appendix.pdf', 'appendix.csv', 'appendix.geojson', 'appendix.zip', 'source-manifest.json', 'cohorts.json', 'maps.json', 'release-contract.json'].map(file => [file, sha256(fs.readFileSync(path.join(outDir, file)))]));
  const receipt = {
    schemaVersion: 1,
    artifactHashes,
    passed: true,
    sourceManifestHash: contract.expectedSourceManifestHash,
    sourceGeoJsonSha256: contract.sourceGeoJsonSha256,
    sourceAcquisition: contract.sourceAcquisition,
    accidents: contract.expectedAccidentIds.length,
    mapCount: contract.expectedMaps.length,
    results,
    microsoftWordEvidenceVerified: false
  };
  writeJson(path.join(outDir, 'release-evidence.json'), receipt);
  console.log(`[release-document] PASS: ${receipt.accidents} real accidents, ${receipt.mapCount} numbered maps; ${results.map(r => `${r.format} ${r.pages} pages/${r.rowCount} reconstructed rows`).join('; ')}`);
  return receipt;
}
if (require.main === module) runReleaseQa().catch(e => {
  console.error(e.stack);
  if (e.details) console.error(JSON.stringify(e.details, null, 2));
  process.exitCode = 1;
});
module.exports = {
  BOUNDS,
  HEADERS,
  assertSameIds,
  cellsForEvidenceRow,
  reconstructAppendixTables,
  loadRealContext,
  generateReleaseEvidence,
  verifyEmbeddedManifest,
  verifyDocxManifest,
  verifyPdfManifest,
  verifyRenderedMapPixels,
  verifyRenderedMapCaptions,
  addMapEvidence,
  runReleaseQa
};
