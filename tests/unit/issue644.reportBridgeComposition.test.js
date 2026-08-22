/** @jest-environment node */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.evidence_safe_semantics_bridge.js'),
  'utf8'
);

function installBridge(UA) {
  const fakeWindow = { UA };
  const execute = new Function('window', SOURCE);
  execute(fakeWindow);
  return fakeWindow.UA;
}

describe('issue #644 report-wrapper composition', () => {
  test('only the newest wrapper finalizes a report after downstream evidence was added', async () => {
    const safeReport = jest.fn(report => report);
    const hardenReport = jest.fn(report => report);
    const UA = installBridge({
      EvidenceSafeSemantics: {
        safeText: value => value,
        safeReport,
      },
      EvidenceSafeSemanticsHardening: {
        eventText: value => value,
        hardenReport,
      },
    });

    UA.computeExportReport = async () => ({
      structured: { methodikScope: { lines: [] } },
      text: 'Narrative',
      html: '<p>Narrative</p>',
    });

    const reportBeforeEvidence = UA.computeExportReport;
    UA.computeExportReport = async (...args) => {
      const report = await reportBeforeEvidence(...args);
      report.structured.evidenceCohorts = { status: 'complete' };
      return report;
    };

    const report = await UA.computeExportReport({ city: 'Bonn' });

    expect(safeReport).toHaveBeenCalledTimes(1);
    expect(hardenReport).toHaveBeenCalledTimes(1);
    expect(report.structured.methodikScope.lines.join(' ')).toMatch(
      /Suchfilter begrenzen diese Menge nicht/i
    );
    expect(report.__uaEvidenceSafe644BridgeProcessed).toBe(true);
  });
});
