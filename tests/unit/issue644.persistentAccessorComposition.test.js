/** @jest-environment node */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.evidence_safe_semantics_bridge.js'),
  'utf8'
);

function installBridge(initial = {}) {
  const timers = [];
  const fakeWindow = {
    UA: initial,
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
  };
  new Function('window', SOURCE)(fakeWindow);
  return { UA: fakeWindow.UA, timers };
}

function simulatePersistentScopeAccessor(UA) {
  const original = UA.computeExportReport;
  const wrapped = async function computeExportReportWithActiveScope(...args) {
    const report = await original.apply(this, args);
    report.structured.methodikScope = {
      title: 'Methodik – eindeutige Zählbereiche',
      lines: ['Später vom AnalysisScope ersetzt'],
    };
    return report;
  };
  wrapped._uaAnalysisScopeWrapped = true;
  wrapped._original = original;

  let foreignAccessorInstalled = false;
  try {
    Object.defineProperty(UA, 'computeExportReport', {
      configurable: true,
      enumerable: true,
      get() { return wrapped; },
      set() {},
    });
    foreignAccessorInstalled = true;
  } catch (_) {
    // This is the real fallback in ua.analysis_scope.js: a sealed final bridge
    // remains the property owner and receives the scoped wrapper by assignment.
    UA.computeExportReport = wrapped;
  }
  return foreignAccessorInstalled;
}

function installEvidenceDecorator(UA) {
  const original = UA.computeExportReport;
  const wrapped = async function evidenceCohortReport(...args) {
    const report = await original.apply(this, args);
    report.structured.evidenceCohorts = { status: 'complete' };
    report.structured.accidentEvidenceAppendix = { total: 1 };
    return report;
  };
  wrapped._uaEvidenceCohortWrapped = true;
  wrapped._uaOriginal = original;
  wrapped._original = original;
  UA.computeExportReport = wrapped;
}

describe('issue #644 persistent report-accessor composition', () => {
  test('keeps the final bridge outermost when AnalysisScope installs its persistent hook', async () => {
    const raw = jest.fn(async () => ({
      structured: {},
      text: 'Auffälliger Unfallschwerpunkt',
      html: '<p>Auffälliger Unfallschwerpunkt</p>',
    }));
    const { UA } = installBridge({
      computeExportReport: raw,
      EvidenceSafeSemantics: {
        safeText: value => String(value).replace(
          /Auffälliger Unfallschwerpunkt/g,
          'Zu prüfende lokale Unfallauffälligkeit'
        ),
        safeReport: report => report,
      },
      EvidenceSafeSemanticsHardening: {
        eventText: value => value,
        hardenReport: report => report,
      },
    });

    let descriptor = Object.getOwnPropertyDescriptor(UA, 'computeExportReport');
    expect(descriptor?.get?.__uaEvidenceSafe644Bridge).toBe(true);
    expect(descriptor?.configurable).toBe(false);

    expect(simulatePersistentScopeAccessor(UA)).toBe(false);
    installEvidenceDecorator(UA);

    const report = await UA.computeExportReport({ city: 'Bonn' });

    descriptor = Object.getOwnPropertyDescriptor(UA, 'computeExportReport');
    expect(descriptor?.get?.__uaEvidenceSafe644Bridge).toBe(true);
    expect(descriptor?.configurable).toBe(false);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(report.__uaEvidenceSafe644BridgeProcessed).toBe(true);
    expect(report.structured.methodikScope.lines.join(' ')).toMatch(
      /Suchfilter begrenzen diese Menge nicht/i
    );
    expect(report.text).toContain('Zu prüfende lokale Unfallauffälligkeit');
  });

  test('reacquires and seals a foreign accessor that existed before the raw report function', () => {
    const { UA, timers } = installBridge();
    let implementation;
    Object.defineProperty(UA, 'computeExportReport', {
      configurable: true,
      enumerable: true,
      get() { return implementation; },
      set(value) { implementation = value; },
    });
    UA.computeExportReport = async () => ({ structured: {}, text: '', html: '' });

    for (let index = 0; index < 20 && timers.length; index += 1) timers.shift()();

    const descriptor = Object.getOwnPropertyDescriptor(UA, 'computeExportReport');
    expect(descriptor?.get?.__uaEvidenceSafe644Bridge).toBe(true);
    expect(descriptor?.configurable).toBe(false);
    expect(typeof UA.computeExportReport).toBe('function');
  });
});
