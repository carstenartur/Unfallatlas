#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { assertRenderedDocument } = require('./rendered-document-audit');
const {
  applyTableHints,
  clusterWordsIntoLines,
} = require('./rendered-table-hints');

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

function positiveInteger(value, path, fallback) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1) {
    fail('invalid_table_section_binding', `${path} must be a positive integer`, { value });
  }
  return candidate;
}

function nonNegativeNumber(value, path, fallback) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate < 0) {
    fail('invalid_table_section_binding', `${path} must be a finite non-negative number`, { value });
  }
  return candidate;
}

function expression(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_table_section_binding', `${path} must be a non-empty regular expression`);
  }
  try {
    return new RegExp(value, 'u');
  } catch (error) {
    fail('invalid_table_section_binding', `${path} is not a valid regular expression`, {
      value,
      cause: error.message,
    });
  }
}

function sameCells(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((cell, index) => cell === right[index]);
}

/**
 * Validates semantic continuity after all rows have been reconstructed from
 * final Poppler coordinates. The checks deliberately operate on the enriched
 * page model rather than on the hint source alone: only headers and rows that
 * actually survived LibreOffice layout may satisfy the contract.
 */
function validateTableContinuity(pages) {
  const tableState = new Map();
  const rowIds = new Set();

  for (const page of pages) {
    const rowsByTable = new Map();
    for (const row of page.tableRows || []) {
      if (!rowsByTable.has(row.tableId)) rowsByTable.set(row.tableId, []);
      rowsByTable.get(row.tableId).push(row);
    }

    for (const [tableId, pageRows] of rowsByTable.entries()) {
      const rows = [...pageRows].sort((left, right) =>
        Number(left.yMin) - Number(right.yMin) || Number(left.xMin) - Number(right.xMin)
      );
      const header = rows[0];
      const repeatedRows = rows.filter((row) => row.repeatedHeader);
      const state = tableState.get(tableId);

      if (!state) {
        if (header.repeatedHeader) {
          fail(
            'initial_table_header_repeated',
            `The first rendered header of table ${tableId} must not be marked as repeated`,
            { tableId, page: page.number, rowId: header.rowId },
          );
        }
        if (repeatedRows.length) {
          fail(
            'repeated_table_header_position',
            `Table ${tableId} marks a non-initial row as a repeated header on page ${page.number}`,
            { tableId, page: page.number, rowIds: repeatedRows.map((row) => row.rowId) },
          );
        }
        tableState.set(tableId, {
          headerCells: [...header.cells],
          firstPage: page.number,
          lastPage: page.number,
        });
      } else {
        if (!header.repeatedHeader) {
          fail(
            'table_continuation_header_missing',
            `Table ${tableId} continues on page ${page.number} without an explicit repeated header`,
            { tableId, firstPage: state.firstPage, page: page.number, rowId: header.rowId },
          );
        }
        if (repeatedRows.length !== 1 || repeatedRows[0] !== header) {
          fail(
            'repeated_table_header_position',
            `Table ${tableId} must have exactly one repeated header as its first row on page ${page.number}`,
            { tableId, page: page.number, rowIds: repeatedRows.map((row) => row.rowId) },
          );
        }
        if (!sameCells(header.cells, state.headerCells)) {
          fail(
            'repeated_table_header_mismatch',
            `The repeated header of table ${tableId} differs from its initial rendered header`,
            {
              tableId,
              firstPage: state.firstPage,
              page: page.number,
              expected: state.headerCells,
              actual: header.cells,
            },
          );
        }
        state.lastPage = page.number;
      }

      for (const row of rows) {
        const key = `${tableId}\u0000${row.rowId}`;
        if (rowIds.has(key)) {
          fail(
            'duplicate_table_row_id',
            `Table ${tableId} contains duplicate rendered row ID ${row.rowId}`,
            { tableId, page: page.number, rowId: row.rowId },
          );
        }
        rowIds.add(key);
      }
    }
  }

  return pages;
}

function renderedLines(pages, tolerance = 3) {
  return pages.flatMap((page) => clusterWordsIntoLines(page.words || [], tolerance)
    .map((line) => ({ ...line, page: page.number })));
}

/**
 * Binds a visible subsection heading to the actual first page of its table.
 * This catches a common office-layout failure where a short heading survives at
 * the bottom of one page while the header and first row move to the next page.
 */
function validateTableSectionBindings(pages, bindings) {
  if (bindings == null) return 0;
  if (!Array.isArray(bindings)) {
    fail('invalid_table_section_binding', 'tableSectionBindings must be an array');
  }
  if (!bindings.length) return 0;

  const lines = renderedLines(pages);
  bindings.forEach((binding, index) => {
    const path = `tableSectionBindings[${index}]`;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      fail('invalid_table_section_binding', `${path} must be an object`);
    }
    const tableId = String(binding.tableId || '').trim();
    if (!tableId) fail('invalid_table_section_binding', `${path}.tableId must not be empty`);
    const matcher = expression(binding.headingPattern, `${path}.headingPattern`);
    const maximumGap = nonNegativeNumber(binding.maximumGap, `${path}.maximumGap`, 80);
    const minimumDataRows = positiveInteger(binding.minimumDataRows, `${path}.minimumDataRows`, 1);

    const headings = lines.filter((line) => matcher.test(line.text));
    if (headings.length !== 1) {
      fail(
        headings.length ? 'table_section_heading_ambiguous' : 'table_section_heading_missing',
        `Expected exactly one rendered heading for table ${tableId}, found ${headings.length}`,
        { tableId, headingPattern: binding.headingPattern, matches: headings },
      );
    }
    const heading = headings[0];
    const tableRows = pages.flatMap((page) => (page.tableRows || [])
      .filter((row) => row.tableId === tableId)
      .map((row) => ({ ...row, page: page.number })))
      .sort((left, right) => left.page - right.page || left.yMin - right.yMin);
    if (!tableRows.length) {
      fail('table_section_table_missing', `No final rows were reconstructed for table ${tableId}`, { tableId });
    }
    const header = tableRows[0];
    const dataRowsOnFirstPage = tableRows.filter((row, rowIndex) =>
      rowIndex > 0 && row.page === header.page && !row.repeatedHeader
    );

    if (heading.page !== header.page) {
      fail(
        'table_section_orphaned',
        `Heading for table ${tableId} is on page ${heading.page}, table starts on page ${header.page}`,
        { tableId, heading, header },
      );
    }
    if (heading.yMax > header.yMin) {
      fail(
        'table_section_order_invalid',
        `Heading for table ${tableId} does not precede its table header`,
        { tableId, heading, header },
      );
    }
    const gap = header.yMin - heading.yMax;
    if (gap > maximumGap) {
      fail(
        'table_section_gap_exceeded',
        `Heading for table ${tableId} is ${gap.toFixed(2)} pt away from its header`,
        { tableId, gap, maximumGap, heading, header },
      );
    }
    if (dataRowsOnFirstPage.length < minimumDataRows) {
      fail(
        'table_section_first_row_missing',
        `Table ${tableId} needs ${minimumDataRows} data row(s) with its heading and header`,
        {
          tableId,
          page: header.page,
          minimumDataRows,
          actual: dataRowsOnFirstPage.length,
        },
      );
    }
  });
  return bindings.length;
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
  validateTableContinuity(pages);
  const bindingCount = validateTableSectionBindings(pages, contract.tableSectionBindings);
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
  return { model: enriched, expected, actual, bindingCount };
}

function enrichMetadata(metadata, expected, actual, hintCount, bindingCount, report) {
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
      tableSectionBindings: bindingCount,
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
    enriched.bindingCount,
    report,
  );

  fs.writeFileSync(modelInput.absolute, `${JSON.stringify(enriched.model, null, 2)}\n`);
  fs.writeFileSync(auditPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(metadataInput.absolute, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(
    `[rendered-table-contract] ${enriched.actual} final row(s) across ` +
      `${contractInput.value.tableHints.length} table hint(s) and ` +
      `${enriched.bindingCount} section binding(s); audit passed.\n`,
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
  positiveInteger,
  nonNegativeNumber,
  expression,
  sameCells,
  validateTableContinuity,
  renderedLines,
  validateTableSectionBindings,
  enrichModel,
  enrichMetadata,
  main,
};
