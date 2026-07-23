'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const enrichment = require('../../scripts/enrich-rendered-document-tables');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unfallwerkbank-table-contract-'));
}

function word(text, xMin, yMin, xMax, yMax) {
  return { text, xMin, yMin, xMax, yMax, fontSize: 9 };
}

function model() {
  return {
    documentId: 'golden',
    renderer: 'docx-libreoffice-poppler',
    pages: [{
      number: 1,
      width: 595,
      height: 842,
      words: [
        word('Kategorie', 78, 679, 120, 688),
        word('Anzahl', 228, 679, 258, 688),
        word('Anteil', 378, 679, 404, 688),
        word('1', 78, 691, 83, 700),
        word('–', 85, 691, 90, 700),
        word('Getötete', 93, 691, 126, 700),
        word('1', 228, 691, 233, 700),
        word('4,2', 378, 691, 391, 700),
        word('%', 393, 691, 402, 700),
        word('2', 78, 703, 83, 712),
        word('–', 85, 703, 90, 712),
        word('Schwerverletzte', 93, 703, 157, 712),
        word('6', 228, 703, 233, 712),
        word('25,0', 378, 703, 396, 712),
        word('%', 398, 703, 407, 712),
        word('3', 78, 715, 83, 724),
        word('–', 85, 715, 90, 724),
        word('Leichtverletzte', 93, 715, 152, 724),
        word('17', 228, 715, 238, 724),
        word('70,8', 378, 715, 396, 724),
        word('%', 398, 715, 407, 724),
      ],
      images: [],
      links: [],
      headings: [],
      tableRows: [],
    }],
    requiredHeadings: [],
    requiredLinks: [],
    requiredImageKinds: [],
    expectedCounts: [],
  };
}

function contract() {
  return {
    expectedTableRowCount: 4,
    tableHints: [{
      page: 1,
      tableId: 'severity',
      headers: ['Kategorie', 'Anzahl', 'Anteil'],
      rows: [
        { rowId: 'severity.fatal', cellPatterns: ['^1\\s*–\\s*Getötete$', '^1$', '^4,2%$'] },
        { rowId: 'severity.serious', cellPatterns: ['^2\\s*–\\s*Schwerverletzte$', '^6$', '^25,0%$'] },
        { rowId: 'severity.light', cellPatterns: ['^3\\s*–\\s*Leichtverletzte$', '^17$', '^70,8%$'] },
      ],
    }],
  };
}

function writeInputs(directory, contractValue = contract()) {
  const modelPath = path.join(directory, 'rendered-document.json');
  const contractPath = path.join(directory, 'contract.json');
  const auditPath = path.join(directory, 'rendered-document-audit.json');
  const metadataPath = path.join(directory, 'conversion-metadata.json');
  fs.writeFileSync(modelPath, JSON.stringify(model()));
  fs.writeFileSync(contractPath, JSON.stringify(contractValue));
  fs.writeFileSync(auditPath, '{"passed":true,"stale":true}');
  fs.writeFileSync(metadataPath, JSON.stringify({
    semanticEvidence: { expectedMapCount: 4, mapCount: 4, imageHints: 4 },
    audit: {
      model: 'poppler/rendered-document.json',
      report: 'poppler/rendered-document-audit.json',
      asserted: true,
      issues: 9,
      passed: false,
    },
  }));
  return { modelPath, contractPath, auditPath, metadataPath };
}

describe('rendered table contract enrichment', () => {
  let directory;

  beforeEach(() => {
    directory = tempDir();
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('enriches the persisted model, reruns the audit and updates metadata', () => {
    const { modelPath, contractPath, auditPath, metadataPath } = writeInputs(directory);

    const result = enrichment.main([
      '--model', modelPath,
      '--contract', contractPath,
      '--audit', auditPath,
      '--metadata', metadataPath,
    ]);

    expect(result.report.passed).toBe(true);
    expect(result.report.summary.tableRowCount).toBe(4);
    expect(result.model.pages[0].tableRows).toHaveLength(4);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(metadata.semanticEvidence).toEqual({
      expectedMapCount: 4,
      mapCount: 4,
      imageHints: 4,
      expectedTableRowCount: 4,
      tableRowCount: 4,
      tableHints: 1,
    });
    expect(metadata.audit).toEqual({
      model: 'poppler/rendered-document.json',
      report: 'poppler/rendered-document-audit.json',
      asserted: true,
      issues: 0,
      passed: true,
    });
    const finalAudit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    expect(finalAudit.summary.tableRowCount).toBe(4);
    expect(finalAudit.stale).toBeUndefined();
  });

  test('removes the stale pre-table audit when final reconstruction fails', () => {
    const invalidContract = {
      ...contract(),
      tableHints: [{
        ...contract().tableHints[0],
        rows: contract().tableHints[0].rows.map((row) =>
          row.rowId === 'severity.light'
            ? { ...row, cellPatterns: ['^3\\s*–\\s*Leichtverletzte$', '^16$', '^70,8%$'] }
            : row
        ),
      }],
    };
    const { modelPath, contractPath, auditPath, metadataPath } = writeInputs(
      directory,
      invalidContract,
    );

    expect(() => enrichment.main([
      '--model', modelPath,
      '--contract', contractPath,
      '--audit', auditPath,
      '--metadata', metadataPath,
    ])).toThrow(/table_cell_mismatch/);
    expect(fs.existsSync(auditPath)).toBe(false);
  });

  test('fails closed when the reconstructed count does not match the contract', () => {
    expect(() => enrichment.enrichModel(model(), {
      ...contract(),
      expectedTableRowCount: 5,
    })).toThrow(/rendered_table_row_count_mismatch/);
  });

  test('requires a positive expected row count and non-empty table hints', () => {
    expect(() => enrichment.expectedRowCount({ expectedTableRowCount: 0 }))
      .toThrow(/invalid_table_contract/);
    expect(() => enrichment.enrichModel(model(), { expectedTableRowCount: 4, tableHints: [] }))
      .toThrow(/invalid_table_contract/);
  });
});
