#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const poppler = require('./poppler-rendered-document');

class LibreOfficeRenderedDocumentError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'LibreOfficeRenderedDocumentError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new LibreOfficeRenderedDocumentError(code, message, details);
}

function parseArgs(argv) {
  const options = { audit: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--docx') options.docx = argv[++index];
    else if (arg === '--out-dir') options.outDir = argv[++index];
    else if (arg === '--document-id') options.documentId = argv[++index];
    else if (arg === '--contract') options.contractPath = argv[++index];
    else if (arg === '--libreoffice') options.libreOffice = argv[++index];
    else if (arg === '--pdftoppm') options.pdftoppm = argv[++index];
    else if (arg === '--no-audit') options.audit = false;
    else fail('unknown_argument', `Unknown argument: ${arg}`);
  }
  if (!options.docx) fail('missing_argument', '--docx is required');
  if (!options.outDir) fail('missing_argument', '--out-dir is required');
  return options;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertDocx(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    fail('missing_docx', `DOCX does not exist: ${absolute}`);
  }
  const content = fs.readFileSync(absolute);
  if (content.length < 1024 || content[0] !== 0x50 || content[1] !== 0x4b) {
    fail('invalid_docx', `Input is not a plausible DOCX/ZIP file: ${absolute}`);
  }
  return absolute;
}

function assertPdf(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    fail('missing_converted_pdf', `LibreOffice did not create a PDF: ${absolute}`);
  }
  const content = fs.readFileSync(absolute);
  if (content.length < 1024 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    fail('invalid_converted_pdf', `Converted artifact is not a plausible PDF: ${absolute}`);
  }
  return absolute;
}

function run(command, args, options = {}) {
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env || process.env,
  });
  if (result.error) {
    fail('command_failed', `${command}: ${result.error.message}`, { command, args });
  }
  if (result.status !== 0) {
    fail('command_failed', `${command} exited ${result.status}`, {
      command,
      args,
      stdout: String(result.stdout || '').slice(-4000),
      stderr: String(result.stderr || '').slice(-4000),
    });
  }
  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function libreOfficeVersion(binary, options = {}) {
  const result = run(binary, ['--version'], options);
  return (result.stdout || result.stderr).trim() || 'unknown';
}

function conversionDirectoryEntries(conversionDir) {
  if (!fs.existsSync(conversionDir)) return [];
  return fs.readdirSync(conversionDir, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
      bytes: entry.isFile() ? fs.statSync(path.join(conversionDir, entry.name)).size : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function resolveConvertedPdf(conversionDir, source, diagnostics = '') {
  const expected = path.join(
    conversionDir,
    `${path.basename(source, path.extname(source))}.pdf`,
  );
  if (fs.existsSync(expected)) return assertPdf(expected);

  const entries = conversionDirectoryEntries(conversionDir);
  const candidates = entries
    .filter((entry) => entry.type === 'file' && /\.pdf$/i.test(entry.name))
    .map((entry) => path.join(conversionDir, entry.name));
  if (candidates.length === 1) return assertPdf(candidates[0]);

  fail(
    'missing_converted_pdf',
    candidates.length > 1
      ? `LibreOffice created multiple ambiguous PDF files in ${conversionDir}`
      : `LibreOffice did not create a PDF in ${conversionDir}`,
    {
      expected,
      candidates,
      entries,
      diagnostics: String(diagnostics || '').slice(-4000),
    },
  );
}

function convertDocxToPdf(docxPath, outDir, options = {}) {
  const source = assertDocx(docxPath);
  const absoluteOutDir = path.resolve(outDir);
  const conversionDir = path.join(absoluteOutDir, 'libreoffice-output');
  const profileDir = path.join(absoluteOutDir, 'libreoffice-profile');
  fs.rmSync(conversionDir, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(conversionDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const binary = options.libreOffice || process.env.LIBREOFFICE_BIN || 'soffice';
  const version = libreOfficeVersion(binary, options);
  const args = [
    '--headless',
    '--nologo',
    '--nodefault',
    '--nolockcheck',
    '--nofirststartwizard',
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--convert-to',
    'pdf:writer_pdf_Export',
    '--outdir',
    conversionDir,
    source,
  ];
  const processResult = run(binary, args, options);
  const diagnostics = `${processResult.stdout}\n${processResult.stderr}`.trim();
  if (/corrupt|damaged|repair(?:ed|ing)?|format error|general input\/output error/i.test(diagnostics)) {
    fail('libreoffice_repair_warning', 'LibreOffice reported a repair or format problem', {
      diagnostics: diagnostics.slice(-4000),
    });
  }

  const pdfPath = resolveConvertedPdf(conversionDir, source, diagnostics);
  return {
    source,
    pdfPath,
    binary,
    version,
    args,
    diagnostics,
    profileDir,
    conversionDir,
  };
}

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    fail('invalid_rendered_page', 'Rendered page is not a PNG');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) fail('invalid_rendered_page', 'Rendered page has invalid dimensions');
  return { width, height };
}

function renderPdfPages(pdfPath, pagesDir, options = {}) {
  const absolutePdf = assertPdf(pdfPath);
  const absolutePagesDir = path.resolve(pagesDir);
  fs.rmSync(absolutePagesDir, { recursive: true, force: true });
  fs.mkdirSync(absolutePagesDir, { recursive: true });
  const prefix = path.join(absolutePagesDir, 'page');
  const binary = options.pdftoppm || 'pdftoppm';
  run(binary, ['-png', '-r', '144', absolutePdf, prefix], options);
  const pages = fs.readdirSync(absolutePagesDir)
    .filter((name) => /^page-\d+\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name, index) => {
      const filePath = path.join(absolutePagesDir, name);
      const content = fs.readFileSync(filePath);
      const dimensions = pngDimensions(content);
      if (dimensions.width < 800 || dimensions.height < 800) {
        fail('undersized_rendered_page', `${name} is too small for visual QA`, dimensions);
      }
      return {
        page: index + 1,
        file: path.relative(path.dirname(absolutePagesDir), filePath),
        bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        ...dimensions,
      };
    });
  if (!pages.length) fail('missing_rendered_pages', 'pdftoppm did not create page PNGs');
  return pages;
}

function copyEvidence(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

function main(argv, runtimeOptions = {}) {
  const options = { ...parseArgs(argv), ...runtimeOptions };
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const conversion = convertDocxToPdf(options.docx, outDir, options);

  const evidenceDocx = copyEvidence(conversion.source, path.join(outDir, 'source.docx'));
  const evidencePdf = copyEvidence(conversion.pdfPath, path.join(outDir, 'converted.pdf'));
  const popplerOut = path.join(outDir, 'poppler');
  const popplerArgs = [
    '--pdf', evidencePdf,
    '--out-dir', popplerOut,
    '--document-id', options.documentId || path.basename(evidenceDocx),
    '--renderer', 'docx-libreoffice-poppler',
    ...(options.contractPath ? ['--contract', options.contractPath] : []),
    ...(!options.audit ? ['--no-audit'] : []),
  ];
  const popplerMain = options.popplerMain || poppler.main;
  const audit = popplerMain(popplerArgs, options.popplerRuntimeOptions || {});
  const pages = renderPdfPages(evidencePdf, path.join(outDir, 'pages'), options);
  if (audit.model.pages.length !== pages.length) {
    fail(
      'rendered_page_count_mismatch',
      `Poppler model has ${audit.model.pages.length} pages but pdftoppm rendered ${pages.length}`,
    );
  }

  const auditIssues = Array.isArray(audit.report?.issues) ? audit.report.issues : [];
  const metadata = {
    schemaVersion: 'unfallwerkbank.docx-rendered-evidence/v1',
    documentId: options.documentId || path.basename(evidenceDocx),
    renderer: 'docx-libreoffice-poppler',
    libreOffice: {
      binary: conversion.binary,
      version: conversion.version,
      diagnostics: conversion.diagnostics,
    },
    source: {
      file: path.basename(evidenceDocx),
      bytes: fs.statSync(evidenceDocx).size,
      sha256: sha256File(evidenceDocx),
    },
    convertedPdf: {
      file: path.basename(evidencePdf),
      bytes: fs.statSync(evidencePdf).size,
      sha256: sha256File(evidencePdf),
      pages: pages.length,
    },
    renderedPages: pages,
    audit: {
      model: path.relative(outDir, audit.modelPath),
      report: path.relative(outDir, path.join(popplerOut, 'rendered-document-audit.json')),
      issues: auditIssues.length,
      passed: Boolean(audit.report?.passed),
    },
  };
  const metadataPath = path.join(outDir, 'conversion-metadata.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(
    `[libreoffice-rendered-document] ${metadata.convertedPdf.pages} page(s), ` +
      `${metadata.audit.issues} audit issue(s), LibreOffice ${conversion.version}.\n`,
  );
  return { conversion, audit, pages, metadata, metadataPath };
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error?.details) {
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    }
    process.exitCode = 1;
  }
}

module.exports = {
  LibreOfficeRenderedDocumentError,
  parseArgs,
  sha256File,
  assertDocx,
  assertPdf,
  run,
  conversionDirectoryEntries,
  resolveConvertedPdf,
  convertDocxToPdf,
  pngDimensions,
  renderPdfPages,
  main,
};
