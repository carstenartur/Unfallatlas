#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findPackageJSON } = require('node:module');
const { isDeepStrictEqual } = require('node:util');
const { inspectDocx, assertPreserved } = require('./lib/docx-package-audit');
const { saveDocxCopy, convertDocxToPdf, sha256File } = require('./libreoffice-rendered-document');
const sample = require('./qa-sample-docx-rendered');
const { verifyEvidence } = require('./verify-rendered-document-evidence');
const { auditAppendixPdf, verifyDocxManifest } = require('./qa-numbered-appendix-rendered');
const { computeInputEvidence } = require('./validate-word-compatibility-evidence');

const REPORT_DIRECTORY = 'out/qa/docx-compatibility';
const SAMPLE_DIRECTORY = 'out/qa/rendered-document/docx';
const APPENDIX_DIRECTORY = 'out/qa/release-document';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function artifact(root, file, sha256 = sha256File(file)) {
  return { file: path.relative(root, file).split(path.sep).join('/'), bytes: fs.statSync(file).size, sha256 };
}

function verifyOriginal(original, pdf, metadata, name) {
  if (original.sha256 !== metadata.source.sha256 || original.bytes !== metadata.source.bytes ||
      pdf.sha256 !== metadata.convertedPdf.sha256 || pdf.bytes !== metadata.convertedPdf.bytes) {
    throw new Error(`Original ${name} DOCX/PDF does not match the render receipt`);
  }
}

function pdfPages(file) {
  const output = execFileSync('pdfinfo', [file], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const pageCount = Number(/^Pages:\s+(\d+)$/mu.exec(output)?.[1]);
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) throw new Error(`Cannot read PDF page count: ${file}`);
  return pageCount;
}

function assertSamePageLayout(source, reopened, count) {
  if (source.pages.length !== count || reopened.pages.length !== count) throw new Error('DOCX round trip changed PDF page count');
  for (const [index, page] of source.pages.entries()) {
    const saved = reopened.pages[index];
    if (page.width !== saved.width || page.height !== saved.height) {
      throw new Error(`DOCX round trip changed rendered page ${index + 1} size or orientation`);
    }
    if (saved.words.some(word => /\ufffd|\u25a1/u.test(word.text))) {
      throw new Error(`Reopened PDF contains a replacement glyph on page ${index + 1}`);
    }
  }
  const links = model => model.pages.flatMap(page => page.links.map(link => link.uri)).sort();
  if (!isDeepStrictEqual(links(source), links(reopened))) throw new Error('DOCX round trip changed rendered link targets');
}

async function auditSavedSample(root, copy, outDir) {
  sample.main({ root, docx: copy, outDir });
  const result = verifyEvidence(outDir);
  return {
    pdf: path.join(outDir, 'converted.pdf'),
    model: result.model,
    audit: result.audit,
    rowCount: result.audit.summary.tableRowCount,
    mapCount: result.audit.summary.mapCount,
    libreOffice: result.metadata.libreOffice,
  };
}

async function auditSavedAppendix(root, copy, outDir) {
  const inputDir = path.join(root, APPENDIX_DIRECTORY);
  const contract = readJson(path.join(inputDir, 'release-contract.json'));
  const cohorts = readJson(path.join(inputDir, 'cohorts.json'));
  const observedSourceHash = await verifyDocxManifest(copy, contract.expectedSourceManifestHash);
  const conversion = convertDocxToPdf(copy, outDir);
  const result = await auditAppendixPdf(conversion.pdfPath, 'docx-pdf', observedSourceHash,
    contract, cohorts.completeEvidenceCohort.rows, outDir);
  return {
    pdf: conversion.pdfPath,
    model: readJson(path.join(outDir, 'rendered-document.json')),
    audit: result.audit,
    rowCount: result.rowCount,
    mapCount: result.mapBindings.length,
    tablePages: result.tablePages,
    sourceManifestHash: result.sourceManifestHash,
    libreOffice: { version: conversion.version, diagnostics: conversion.diagnostics },
  };
}

async function auditCandidate(root, output, candidate) {
  const docx = path.join(root, candidate.docx);
  const dir = path.join(root, candidate.renderDir);
  const metadata = readJson(path.join(dir, 'conversion-metadata.json'));
  const original = await inspectDocx(fs.readFileSync(docx));
  const originalPdf = artifact(root, path.join(dir, 'converted.pdf'));
  verifyOriginal(original, originalPdf, metadata, candidate.id);

  const candidateOutput = path.join(output, candidate.id);
  const save = saveDocxCopy(docx, path.join(candidateOutput, 'saved'));
  if (sha256File(docx) !== original.sha256) throw new Error('The original DOCX changed during save');
  const saved = await inspectDocx(fs.readFileSync(save.docxPath), { officeSavedCopy: true });
  assertPreserved(original, saved);
  const reopened = await candidate.auditSaved(root, save.docxPath, path.join(candidateOutput, 'reopened'));
  if (sha256File(save.docxPath) !== saved.sha256) throw new Error('The saved DOCX changed during reopen');
  const pages = pdfPages(reopened.pdf);
  assertSamePageLayout(readJson(path.join(root, candidate.model)), reopened.model, pages);
  if (pages !== metadata.convertedPdf.pages) throw new Error(`Reopened ${candidate.id} page count differs from the original`);

  return {
    documentId: candidate.id,
    originalDocx: artifact(root, docx, original.sha256),
    originalPdf,
    savedDocx: artifact(root, save.docxPath, saved.sha256),
    reopenedPdf: artifact(root, reopened.pdf),
    ooxml: {
      originalParts: original.parts,
      savedParts: saved.parts,
      paragraphs: original.signature.paragraphs.length,
      tables: original.signature.tables.length,
      pageSizes: original.signature.pageSizes,
      imageOccurrences: original.signature.images.length,
      hyperlinks: original.signature.links.length,
    },
    libreOffice: {
      version: save.version,
      saveDiagnostics: save.diagnostics,
      reopenVersion: reopened.libreOffice.version,
      reopenDiagnostics: reopened.libreOffice.diagnostics,
    },
    rendered: {
      pages,
      tableRows: reopened.rowCount,
      maps: reopened.mapCount,
      audit: reopened.audit.counts,
      ...(reopened.tablePages ? { tablePages: reopened.tablePages, sourceManifestHash: reopened.sourceManifestHash } : {}),
    },
  };
}

async function main(root = path.resolve(__dirname, '..')) {
  const output = path.join(root, REPORT_DIRECTORY);
  const reportPath = path.join(output, 'report.json');
  fs.rmSync(reportPath, { force: true });
  fs.mkdirSync(output, { recursive: true });
  const report = {
    schemaVersion: 'unfallwerkbank.docx-compatibility-report/v1',
    testedAt: new Date().toISOString(),
    microsoftWordEvidenceVerified: false,
    status: 'failed',
    documents: [],
  };
  try {
    report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const input = computeInputEvidence(root);
    report.inputFingerprint = input.fingerprint;
    report.auditSha256 = Object.fromEntries([
      'scripts/qa-docx-compatibility.js', 'scripts/lib/docx-package-audit.js', 'scripts/lib/strict-zip.js',
      'scripts/libreoffice-rendered-document.js', 'scripts/poppler-rendered-document.js',
      'scripts/rendered-document-audit.js', 'scripts/enrich-rendered-document-tables.js',
      'scripts/verify-rendered-document-evidence.js',
    ].map(file => [file, sha256File(path.join(root, file))]));
    const lock = readJson(path.join(root, 'package-lock.json'));
    report.libraries = {
      docx: readJson(findPackageJSON('docx', __filename)).version,
      jszip: require('jszip/package.json').version,
      saxes: require('saxes/package.json').version,
    };
    for (const [name, version] of Object.entries(report.libraries)) {
      if (version !== lock.packages[`node_modules/${name}`].version) throw new Error(`Unexpected ${name} version ${version}`);
    }
    const candidates = [
      {
        id: 'ci-docx-sample', docx: `${SAMPLE_DIRECTORY}/source.docx`, renderDir: SAMPLE_DIRECTORY,
        model: `${SAMPLE_DIRECTORY}/poppler/rendered-document.json`, auditSaved: auditSavedSample,
      },
      {
        id: 'release-numbered-docx', docx: `${APPENDIX_DIRECTORY}/appendix.docx`, renderDir: `${APPENDIX_DIRECTORY}/docx`,
        model: `${APPENDIX_DIRECTORY}/docx-pdf/rendered-document.json`, auditSaved: auditSavedAppendix,
      },
    ];
    for (const candidate of candidates) {
      try {
        report.documents.push(await auditCandidate(root, output, candidate));
      } catch (error) {
        throw new Error(`${candidate.id}: ${error.message}`, { cause: error });
      }
    }
    report.status = 'passed';
    console.log(`[docx-compatibility] PASS: ${report.documents.map(document => `${document.documentId} ${document.rendered.pages} pages`).join('; ')}`);
    return report;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    const temporaryReport = `${reportPath}.tmp`;
    fs.writeFileSync(temporaryReport, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(temporaryReport, reportPath);
  }
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { main };
