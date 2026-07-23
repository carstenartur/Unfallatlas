#!/usr/bin/env node
'use strict';

const path = require('path');
const libreOffice = require('./libreoffice-rendered-document');
const tables = require('./enrich-rendered-document-tables');

function paths(root = path.resolve(__dirname, '..')) {
  const outDir = path.join(root, 'out', 'qa', 'rendered-document', 'docx');
  return {
    root,
    docx: path.join(root, 'out', 'ci-render-gate.docx'),
    contract: path.join(root, 'tests', 'fixtures', 'rendered-document', 'ci-docx-contract.json'),
    outDir,
    model: path.join(outDir, 'poppler', 'rendered-document.json'),
    audit: path.join(outDir, 'poppler', 'rendered-document-audit.json'),
    metadata: path.join(outDir, 'conversion-metadata.json'),
  };
}

function main(runtimeOptions = {}) {
  const resolved = paths(runtimeOptions.root);
  const conversion = (runtimeOptions.libreOfficeMain || libreOffice.main)([
    '--docx', resolved.docx,
    '--out-dir', resolved.outDir,
    '--document-id', 'ci-docx-sample',
    '--contract', resolved.contract,
  ], runtimeOptions.libreOfficeRuntimeOptions || {});
  const tableEvidence = (runtimeOptions.tableMain || tables.main)([
    '--model', resolved.model,
    '--contract', resolved.contract,
    '--audit', resolved.audit,
    '--metadata', resolved.metadata,
  ]);
  process.stdout.write(
    `[qa-sample-docx-rendered] ${conversion.pages.length} page(s), ` +
      `${tableEvidence.report.summary.mapCount} map(s), ` +
      `${tableEvidence.report.summary.tableRowCount} table row(s).\n`,
  );
  return { paths: resolved, conversion, tableEvidence };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error?.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { paths, main };
