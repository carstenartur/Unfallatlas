const fs = require('fs');
const path = require('path');

function loadModules() {
  const window = {
    __UA_DISABLE_EVIDENCE_SAFE_AUTOINSTALL__: true,
    setTimeout: () => 0,
  };
  window.UA = {};
  for (const file of [
    'ua.evidence_safe_semantics.js',
    'ua.evidence_safe_semantics_hardening.js',
  ]) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../js', file), 'utf8');
    (function evaluate(window) { eval(source); })(window);
  }
  return window.UA;
}

describe('issue #644 cross-layer wrapper idempotency', () => {
  test('repeated installers keep one wrapper per layer and execute the base report once', async () => {
    const UA = loadModules();
    let reportCalls = 0;
    let viewCalls = 0;

    UA.computeExportReport = async () => {
      reportCalls += 1;
      return { structured: { deviations: { focus: [] } } };
    };
    UA.applyAccidentView = () => {
      viewCalls += 1;
      return { groups: [] };
    };

    UA.EvidenceSafeSemantics.install();
    UA.EvidenceSafeSemanticsHardening.install();
    const reportWrapper = UA.computeExportReport;
    const viewWrapper = UA.applyAccidentView;

    for (let index = 0; index < 25; index += 1) {
      UA.EvidenceSafeSemantics.install();
      UA.EvidenceSafeSemanticsHardening.install();
    }

    expect(UA.computeExportReport).toBe(reportWrapper);
    expect(UA.applyAccidentView).toBe(viewWrapper);
    expect(reportWrapper.__uaEvidenceSafe644).toBe(true);
    expect(reportWrapper.__uaEvidenceSafe644Hardening).toBe(true);
    expect(viewWrapper.__uaEvidenceSafe644).toBe(true);
    expect(viewWrapper.__uaEvidenceSafe644Hardening).toBe(true);

    await UA.computeExportReport({});
    UA.applyAccidentView([], 'bySeverity');

    expect(reportCalls).toBe(1);
    expect(viewCalls).toBe(1);
  });
});
