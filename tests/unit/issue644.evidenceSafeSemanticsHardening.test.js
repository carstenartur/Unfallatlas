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

describe('issue #644 evidence-safe hardening', () => {
  test('uses accident-event wording in rendered severity headers', () => {
    const UA = loadModules();
    UA.applyAccidentView = () => ({
      groups: [{
        headers: {
          text: '--- Schwerverletzte (n=2) ---',
          html: '<strong>Schwerverletzte (n=2)</strong>',
          docx: [{ text: 'Schwerverletzte (n=2)' }],
        },
      }],
    });

    UA.EvidenceSafeSemanticsHardening.install();
    const result = UA.applyAccidentView([], 'bySeverity');
    expect(result.groups[0].headers.text).toContain('Unfälle mit Schwerverletzten');
    expect(result.groups[0].headers.html).toContain('Unfälle mit Schwerverletzten');
    expect(result.groups[0].headers.docx[0].text).toContain('Unfälle mit Schwerverletzten');
  });

  test('downgrades unverified catalogue recommendations to measure options', async () => {
    const UA = loadModules();
    UA.computeExportReport = async () => ({
      structured: {
        deviations: { focus: [] },
        recommendedMeasures: {
          measures: [{
            measure: {
              id: 'tempo_30',
              label: 'Tempo-30-Anordnung',
              description: 'Tempo 30 anordnen.',
            },
          }],
        },
      },
    });

    UA.EvidenceSafeSemanticsHardening.install();
    const report = await UA.computeExportReport({});
    const item = report.structured.recommendedMeasures.measures[0].measure;
    expect(item.label).toMatch(/^Prüfoption/);
    expect(item.description).toMatch(/^Prüfoption/);
    expect(item.evidenceStage).toBe('measure-option');
  });

  test('retains a measure as supported only with an explicit supported mechanism stage', () => {
    const UA = loadModules();
    const result = UA.EvidenceSafeSemanticsHardening.hardenRecommendedMeasures({
      measures: [{
        evidenceStage: 'supported-mechanism',
        measure: {
          label: 'Geometrie anpassen',
          description: 'Die fachlich bestätigte Variante umsetzen.',
        },
      }],
    });
    const item = result.measures[0].measure;
    expect(item.label).toBe('Geometrie anpassen');
    expect(item.evidenceStage).toBe('supported-mechanism');
  });

  test('normalises pattern labels throughout the structured AI facts', async () => {
    const UA = loadModules();
    UA.computeExportReport = async () => ({
      structured: {
        deviations: { focus: [] },
        patternDetection: {
          findings: [{
            id: 'legacy-bike-hgv',
            label: 'Rad-/Lkw-Konflikt',
            rationale: 'Rad-/Lkw-Kollision als möglicher Mechanismus.',
          }],
        },
      },
    });

    UA.EvidenceSafeSemanticsHardening.install();
    const report = await UA.computeExportReport({});
    const finding = report.structured.patternDetection.findings[0];
    expect(finding.label).toBe('Rad- und Güterkraftfahrzeug-Beteiligungsmuster');
    expect(finding.rationale).not.toMatch(/Konflikt|Kollision/);
  });

  test('does not recursively traverse or copy bulk accident rows', async () => {
    const UA = loadModules();
    let bulkRowWasRead = false;
    const bulkRow = {};
    Object.defineProperty(bulkRow, 'legacyLabel', {
      enumerable: true,
      get() {
        bulkRowWasRead = true;
        throw new Error('bulk accident rows must not be traversed by text hardening');
      },
    });
    const accidentDetails = { rows: [bulkRow], groups: [] };

    UA.computeExportReport = async () => ({
      structured: {
        deviations: { focus: [] },
        accidentDetails,
        patternDetection: {
          findings: [{ label: 'Rad-/Lkw-Konflikt' }],
        },
      },
    });

    UA.EvidenceSafeSemanticsHardening.install();
    const report = await UA.computeExportReport({});

    expect(bulkRowWasRead).toBe(false);
    expect(report.structured.accidentDetails).toBe(accidentDetails);
    expect(report.structured.accidentDetails.rows).toBe(accidentDetails.rows);
    expect(report.structured.patternDetection.findings[0].label)
      .toBe('Rad- und Güterkraftfahrzeug-Beteiligungsmuster');
  });

  test('states that discovery filters do not limit the complete evidence cohort', async () => {
    const UA = loadModules();
    UA.computeExportReport = async () => ({
      structured: {
        deviations: { focus: [] },
        evidenceCohorts: { status: 'complete' },
        methodikScope: {
          title: 'Methodik – eindeutige Zählbereiche',
          lines: ['Aktive Auswertung: 44 Unfälle im markierten Bereich.'],
        },
      },
    });

    UA.EvidenceSafeSemanticsHardening.install();
    const report = await UA.computeExportReport({});
    expect(report.structured.methodikScope.lines.join(' '))
      .toMatch(/Suchfilter begrenzen diese Menge nicht/i);
  });
});
