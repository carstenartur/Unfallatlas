/** @jest-environment node */

const fs = require('fs');
const path = require('path');

const readModule = name => fs.readFileSync(
  path.resolve(__dirname, '../../js', name),
  'utf8'
);

function evaluate(window, source) {
  new Function('window', source)(window);
}

function chain(fn) {
  const output = [];
  const seen = new Set();
  for (let current = fn; typeof current === 'function' && !seen.has(current);) {
    output.push(current);
    seen.add(current);
    current = current._uaOriginal || current._original || current.original || null;
  }
  return output;
}

describe('issue #644 report bootstrap accessor collision', () => {
  test('restores finalization synchronously after the accident-coverage guard without duplicate report passes', async () => {
    const timers = [];
    const window = {
      UA: {},
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
    };

    evaluate(window, readModule('ua.evidence_safe_semantics.js'));
    evaluate(window, readModule('ua.evidence_safe_semantics_hardening.js'));
    evaluate(window, readModule('ua.evidence_safe_semantics_bridge.js'));

    expect(Object.getOwnPropertyDescriptor(window.UA, 'computeExportReport')?.get?.__uaEvidenceSafe644Bridge)
      .toBe(true);

    // This is the real browser load-order collision: the completeness guard is
    // loaded after the bridge but before ua.export_v2.js defines the report.
    evaluate(window, readModule('ua.accident_coverage.js'));
    expect(Object.getOwnPropertyDescriptor(window.UA, 'computeExportReport')?.get?.__uaEvidenceSafe644Bridge)
      .not.toBe(true);

    let rawCalls = 0;
    const rows = Array.from({ length: 21_539 }, (_, index) => ({
      displayId: `A${String(index + 1).padStart(5, '0')}`,
    }));
    const appendix = { rows };
    const appendixText = rows.map(row => `${row.displayId} | 2025 | Leichtverletzt | Rad + Pkw`).join('\n');

    window.UA.computeExportReport = async () => {
      rawCalls += 1;
      return {
        structured: {
          accidentEvidenceAppendix: appendix,
          methodikScope: { lines: ['Ausgangszeile'] },
        },
        text: 'Auffälliger Unfallschwerpunkt.\n'
          + `VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISANLAGE\n${appendixText}`,
        html: '<p>Auffälliger Unfallschwerpunkt.</p>'
          + `<section data-ua-evidence-appendix="1"><pre>${appendixText}</pre></section>`,
      };
    };

    // The accident-coverage setter must hand the now guarded data property back
    // to the bridge before the assignment returns; no timer race is permitted.
    const descriptor = Object.getOwnPropertyDescriptor(window.UA, 'computeExportReport');
    expect(descriptor?.get?.__uaEvidenceSafe644Bridge).toBe(true);
    expect(chain(window.UA.computeExportReport).some(fn => fn._accidentCoverageGuarded)).toBe(true);

    // Let the existing base/hardening observers run. Because the bridge already
    // owns the live function, they must not add their own full-report wrappers.
    for (let index = 0; index < 8; index += 1) timers.shift()?.();
    expect(chain(window.UA.computeExportReport).filter(fn =>
      !fn.__uaEvidenceSafe644Bridge
      && (fn.__uaEvidenceSafe644 || fn.__uaEvidenceSafe644Hardening)
    )).toHaveLength(0);

    await expect(window.UA.computeExportReport({
      accidentDataCoverage: {
        complete: false,
        loadedFeatureCount: 42,
        sourceTotalCount: 21_539,
      },
    })).rejects.toThrow(/Berichtsexport.*nicht verfügbar/i);
    expect(rawCalls).toBe(0);

    // Reproduce late evidence and semantic decorators. The latter replaces the
    // method scope to prove that the final bridge repairs it after every late
    // decorator, not before it.
    const evidenceOriginal = window.UA.computeExportReport;
    const evidence = async function evidenceDecorator(...args) {
      const report = await evidenceOriginal.apply(this, args);
      report.structured.evidenceCohorts = { status: 'complete' };
      report.structured.methodikScope.lines.push('Suchfilter begrenzen diese Menge nicht.');
      return report;
    };
    evidence._uaOriginal = evidenceOriginal;
    window.UA.computeExportReport = evidence;

    const semanticOriginal = window.UA.computeExportReport;
    const semantic = async function semanticDecorator(...args) {
      const report = await semanticOriginal.apply(this, args);
      return {
        ...report,
        structured: {
          ...report.structured,
          methodikScope: { lines: ['Später normalisiert'] },
        },
      };
    };
    semantic._uaOriginal = semanticOriginal;
    window.UA.computeExportReport = semantic;

    const started = process.hrtime.bigint();
    const report = await window.UA.computeExportReport({
      accidentDataCoverage: { complete: true },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(rawCalls).toBe(1);
    expect(report.structured.accidentEvidenceAppendix).toBe(appendix);
    expect(report.structured.methodikScope.lines.join(' ')).toMatch(
      /Suchfilter begrenzen diese Menge nicht/i
    );
    expect(report.text).toContain('Zu prüfende lokale Unfallauffälligkeit');
    expect(report.text.endsWith(appendixText)).toBe(true);
    expect(report.html).toContain(`<pre>${appendixText}</pre>`);
    expect(report.__uaEvidenceSafe644BridgeProcessed).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
