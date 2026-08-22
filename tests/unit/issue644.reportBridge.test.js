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

describe('issue #644 deterministic report semantics bridge', () => {
  test('wraps a report function assigned after bootstrap and marks both legacy guards', async () => {
    const safeText = jest.fn(value => String(value).replaceAll(
      'Auffälliger Unfallschwerpunkt',
      'Zu prüfende lokale Unfallauffälligkeit'
    ));
    const hardeningText = jest.fn(value => String(value).replaceAll(
      'Rad-Pkw-Konflikt',
      'Rad- und Pkw-Beteiligungsmuster'
    ));
    const safeReport = jest.fn(report => {
      report.structured = { ...report.structured, baseGuardApplied: true };
      return report;
    });
    const hardenReport = jest.fn(report => {
      report.structured = { ...report.structured, hardeningGuardApplied: true };
      return report;
    });

    const UA = installBridge({
      EvidenceSafeSemantics: { safeText, safeReport },
      EvidenceSafeSemanticsHardening: {
        eventText: hardeningText,
        hardenReport,
      },
    });

    const raw = jest.fn(async () => ({
      structured: {
        evidenceCohorts: { status: 'complete' },
        methodikScope: { lines: ['Bestehende Methodenzeile.'] },
      },
      text: 'Auffälliger Unfallschwerpunkt und Rad-Pkw-Konflikt.',
      html: '<p>Auffälliger Unfallschwerpunkt und Rad-Pkw-Konflikt.</p>',
    }));

    UA.computeExportReport = raw;
    expect(UA.computeExportReport.__uaEvidenceSafe644).toBe(true);
    expect(UA.computeExportReport.__uaEvidenceSafe644Hardening).toBe(true);
    expect(UA.computeExportReport.__uaEvidenceSafe644Bridge).toBe(true);

    const report = await UA.computeExportReport({ city: 'Hannover' });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(report.structured.baseGuardApplied).toBe(true);
    expect(report.structured.hardeningGuardApplied).toBe(true);
    expect(report.structured.methodikScope.lines.join(' ')).toMatch(
      /Suchfilter begrenzen diese Menge nicht/i
    );
    expect(report.text).toContain('Zu prüfende lokale Unfallauffälligkeit');
    expect(report.text).toContain('Rad- und Pkw-Beteiligungsmuster');
    expect(report.html).toContain('Zu prüfende lokale Unfallauffälligkeit');
  });

  test('does not scan or copy the complete numbered accident appendix', async () => {
    const appendix = Array.from(
      { length: 50_000 },
      (_, index) => `A${String(index + 1).padStart(5, '0')} | 2025 | Leichtverletzt | Rad + Pkw`
    ).join('\n');
    const textMarker = 'VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISANLAGE';
    const safeText = jest.fn(value => String(value).replaceAll(
      'Auffälliger Unfallschwerpunkt',
      'Zu prüfende lokale Unfallauffälligkeit'
    ));

    const UA = installBridge({
      EvidenceSafeSemantics: {
        safeText,
        safeReport: report => report,
      },
      EvidenceSafeSemanticsHardening: {
        eventText: value => value,
        hardenReport: report => report,
      },
    });

    UA.computeExportReport = async () => ({
      structured: {
        accidentEvidenceAppendix: { rows: [{ displayId: 'A00001' }] },
        methodikScope: { lines: [] },
      },
      text: `Auffälliger Unfallschwerpunkt.\n${textMarker}\n${appendix}`,
      html: '<p>Auffälliger Unfallschwerpunkt.</p>'
        + `<section data-ua-evidence-appendix="true"><pre>${appendix}</pre></section>`
        + '<p>Auffälliger Unfallschwerpunkt.</p>',
    });

    const started = process.hrtime.bigint();
    const report = await UA.computeExportReport({});
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(report.text).toContain('Zu prüfende lokale Unfallauffälligkeit');
    expect(report.text.endsWith(`${textMarker}\n${appendix}`)).toBe(true);
    expect(report.html).toContain(`<pre>${appendix}</pre>`);
    expect(report.html).not.toContain('<p>Auffälliger Unfallschwerpunkt.</p>');
    expect(safeText).toHaveBeenCalled();
    expect(Math.max(...safeText.mock.calls.map(([value]) => String(value).length)))
      .toBeLessThan(10_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
