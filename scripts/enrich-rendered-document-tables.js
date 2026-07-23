#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { assertRenderedDocument } = require('./rendered-document-audit');
const { applyTableHints } = require('./rendered-table-hints');

class RenderedTableContractError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'RenderedTableContractError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new RenderedTableContractError(code, message, details);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') options.modelPath = argv[++index];
    else if (arg === '--contract') options.contractPath = argv[++index];
    else if (arg === '--audit') options.auditPath = argv[++index];
    else if (arg === '--metadata') options.metadataPath = argv[++index];
    else fail('unknown_argument', `Unknown argument: ${arg}`);
  }
  for (const [key, flag] of [
    ['modelPath', '--model'],
    ['contractPath', '--contract'],
    ['auditPath', '--audit'],
    ['metadataPath', '--metadata'],
  ]) {
    if (!options[key]) fail('missing_argument', `${flag} is required`);
  }
  return options;
}

function readJson(filePath, label) {
  const absolute = path.resolve(filePath);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    fail('invalid_json', `Cannot read ${label}: ${absolute}`, { cause: error.message });
  }
  return { absolute, value };
}

function expectedRowCount(contract) {
  const value = Number(contract.expectedTableRowCount);
  if (!Number.isInteger(value) || value < 1) {
    fail(
      'invalid_table_contract',
      'expectedTableRowCount must be a positive integer when tableHints are present',
      { value: contract.expectedTableRowCount },
    );
  }
  return value;
}

function enrichModel(model, contract) {
  if (!model || typeof model !== 'object' || !Array.isArray(model.pages)) {
    fail('invalid_rendered_model', 'rendered document model requires pages');
  }
  if (!Array.isArray(contract.tableHints) || !contract.tableHints.length) {
    fail('invalid_table_contract', 'tableHints must not be empty');
  }
  const pages = model.pages.map((page) => ({
    ...page,
    tableRows: applyTableHints(page.words || [], contract.tableHints, page.number),
  }));
  const enriched = { ...model, pages };
  const actual = pages.reduce((sum, page) => sum + page.tableRows.length, 0);
  const expected = expectedRowCount(contract);
  if (actual !== expected) {
    fail(
      'rendered_table_row_count_mismatch',
      `Expected ${expected} final table row(s), reconstructed ${actual}`,
      { expected, actual },
    );
  }
  return { model: enriched, expected, actual };
}

function enrichMetadata(metadata, expected, actual, hintCount, report) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('invalid_conversion_metadata', 'conversion metadata must be an object');
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail('invalid_final_audit', 'final rendered-document audit report must be an object');
  }
  return {
    ...metadata,
    semanticEvidence: {
      ...(metadata.semanticEvidence || {}),
      expectedTableRowCount: expected,
      tableRowCount: actual,
      tableHints: hintCount,
    },
    audit: {
      ...(metadata.audit || {}),
      issues: Array.isArray(report.issues) ? report.issues.length : 0,
      passed: Boolean(report.passed),
    },
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const auditPath = path.resolve(options.auditPath);
  // The pre-table Poppler audit is only an intermediate result. Remove it
  // before reconstruction so a failed table contract cannot leave a stale,
  // apparently final passed report in the evidence package.
  fs.rmSync(auditPath, { force: true });

  const modelInput = readJson(options.modelPath, 'rendered document model');
  const contractInput = readJson(options.contractPath, 'rendered document contract');
  const metadataInput = readJson(options.metadataPath, 'conversion metadata');
  const enriched = enrichModel(modelInput.value, contractInput.value);
  const report = assertRenderedDocument(enriched.model);
  const metadata = enrichMetadata(
    metadataInput.value,
    enriched.expected,
    enriched.actual,
    contractInput.value.tableHints.length,
    report,
  );

  fs.writeFileSync(modelInput.absolute, `${JSON.stringify(enriched.model, null, 2)}\n`);
  fs.writeFileSync(auditPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(metadataInput.absolute, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(
    `[rendered-table-contract] ${enriched.actual} final row(s) across ` +
      `${contractInput.value.tableHints.length} table hint(s); audit passed.\n`,
  );
  return { model: enriched.model, report, metadata };
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error?.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  RenderedTableContractError,
  parseArgs,
  readJson,
  expectedRowCount,
  enrichModel,
  enrichMetadata,
  main,
};
