/** @jest-environment node */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.evidence_safe_semantics_bridge.js'),
  'utf8'
);

const EVIDENCE_HOOK_MARK = '_uaEvidenceCohortWrapped';

function installBridge(initial = {}) {
  const fakeWindow = { UA: initial };
  const execute = new Function('window', SOURCE);
  execute(fakeWindow);
  return fakeWindow.UA;
}

function chainContains(fn, marker) {
  let current = fn;
  const seen = new Set();
  for (let depth = 0; typeof current === 'function' && depth < 32 && !seen.has(current); depth += 1) {
    if (current[marker]) return true;
    seen.add(current);
    current = current._uaOriginal || current._original || current.original || null;
  }
  return false;
}

function installEvidenceHook(UA, counters) {
  const current = UA.computeExportReport;
  if (typeof current !== 'function' || chainContains(current, EVIDENCE_HOOK_MARK)) return;

  counters.installs += 1;
  const wrapped = async function evidenceCohortReport(...args) {
    const report = await current.apply(this, args);
    counters.decorations += 1;
    report.structured = {
      ...(report.structured || {}),
      evidenceCohorts: { status: 'complete' },
    };
    return report;
  };
  wrapped[EVIDENCE_HOOK_MARK] = true;
  wrapped._uaOriginal = current;
  wrapped._original = current;
  UA.computeExportReport = wrapped;
}

describe('issue #644 report bridge lifecycle', () => {
  test('preserves the wrapped chain so late-binding observers install an expensive hook only once', async () => {
    const UA = installBridge();
    const counters = { installs: 0, decorations: 0 };
    const raw = jest.fn(async () => ({
      structured: { methodikScope: { lines: [] } },
      text: 'Narrative',
      html: '<p>Narrative</p>',
    }));
    UA.computeExportReport = raw;

    for (let index = 0; index < 100; index += 1) installEvidenceHook(UA, counters);

    expect(counters.installs).toBe(1);
    expect(chainContains(UA.computeExportReport, EVIDENCE_HOOK_MARK)).toBe(true);

    const report = await UA.computeExportReport({ city: 'Bonn' });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(counters.decorations).toBe(1);
    expect(report.structured.methodikScope.lines.join(' ')).toMatch(
      /Suchfilter begrenzen diese Menge nicht/i
    );
    expect(report.__uaEvidenceSafe644BridgeProcessed).toBe(true);
  });

  test('finishes an invocation that owned finalization when a replacement arrives during await', async () => {
    const UA = installBridge();
    let resolveRaw;
    UA.computeExportReport = () => new Promise(resolve => { resolveRaw = resolve; });

    const inFlightWrapper = UA.computeExportReport;
    const pending = inFlightWrapper({ city: 'Bonn' });

    const replacement = async (...args) => inFlightWrapper(...args);
    UA.computeExportReport = replacement;

    resolveRaw({
      structured: {
        evidenceCohorts: { status: 'complete' },
        methodikScope: { lines: [] },
      },
      text: 'Narrative',
      html: '<p>Narrative</p>',
    });

    const report = await pending;
    expect(report.__uaEvidenceSafe644BridgeProcessed).toBe(true);
    expect(report.structured.methodikScope.lines.join(' ')).toMatch(
      /Suchfilter begrenzen diese Menge nicht/i
    );
  });
});
