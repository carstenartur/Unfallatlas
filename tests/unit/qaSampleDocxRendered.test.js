'use strict';

const path = require('path');
const qa = require('../../scripts/qa-sample-docx-rendered');

describe('sample DOCX rendered QA orchestrator', () => {
  test('runs conversion before table enrichment with one shared evidence tree', () => {
    const root = path.resolve('/tmp/unfallwerkbank-qa-root');
    const order = [];
    const libreOfficeMain = jest.fn((args) => {
      order.push('convert');
      return { pages: Array.from({ length: 6 }, () => ({})), args };
    });
    const tableMain = jest.fn((args) => {
      order.push('tables');
      return {
        report: { summary: { mapCount: 4, tableRowCount: 4 } },
        args,
      };
    });

    const result = qa.main({ root, libreOfficeMain, tableMain });

    expect(order).toEqual(['convert', 'tables']);
    expect(libreOfficeMain.mock.calls[0][0]).toEqual([
      '--docx', path.join(root, 'out', 'ci-render-gate.docx'),
      '--out-dir', path.join(root, 'out', 'qa', 'rendered-document', 'docx'),
      '--document-id', 'ci-docx-sample',
      '--contract', path.join(root, 'tests', 'fixtures', 'rendered-document', 'ci-docx-contract.json'),
    ]);
    expect(tableMain.mock.calls[0][0]).toEqual([
      '--model', path.join(root, 'out', 'qa', 'rendered-document', 'docx', 'poppler', 'rendered-document.json'),
      '--contract', path.join(root, 'tests', 'fixtures', 'rendered-document', 'ci-docx-contract.json'),
      '--audit', path.join(root, 'out', 'qa', 'rendered-document', 'docx', 'poppler', 'rendered-document-audit.json'),
      '--metadata', path.join(root, 'out', 'qa', 'rendered-document', 'docx', 'conversion-metadata.json'),
    ]);
    expect(result.tableEvidence.report.summary).toEqual({ mapCount: 4, tableRowCount: 4 });
  });
});
