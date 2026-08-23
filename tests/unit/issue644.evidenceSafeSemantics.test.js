const fs = require('fs');
const path = require('path');

function loadBootstrap() {
  const window = {
    __UA_DISABLE_EVIDENCE_SAFE_AUTOINSTALL__: true,
    setTimeout: () => 0,
  };
  window.UA = { BUILD: 'test' };
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.evidence_safe_semantics.js'), 'utf8');
  (function evaluateSemantics(window) { eval(source); })(window);
  return window.UA;
}

describe('issue #644 evidence-safe semantics', () => {
  test('uses neutral labels for published involvement categories', () => {
    const UA = loadBootstrap();
    const labels = [1, 5, 17, 33].map(mask => UA.EvidenceSafeSemantics.involvementLabel(mask));

    expect(labels[0]).toMatch(/ausschließlich gesetzter Beteiligungskategorie Radverkehr/);
    expect(labels[1]).toMatch(/Radverkehr.*Pkw/);
    expect(labels[2]).toMatch(/Radverkehr.*Güterkraftfahrzeug/);
    expect(labels[3]).toMatch(/Radverkehr.*sonstiger veröffentlichter Beteiligungskategorie/);
    expect(labels.join(' ')).not.toMatch(/Kollision|Konflikt|Alleinunfall|Bus|ÖPNV|Abbiegen/i);

    UA.COMBO_LABEL = { 1: '🚲', 33: '🚲+🚌' };
    UA.EvidenceSafeSemantics.install();
    expect(UA.COMBO_LABEL[1]).toBe('Beteiligungskategorie: Rad');
    expect(UA.COMBO_LABEL[33]).toBe('Beteiligungskategorien: Rad + Sonstige');
  });

  test('escalates severity only from the same involvement cohort', () => {
    const UA = loadBootstrap();
    UA.contextMeasures = {
      classifyPatterns() {
        return new Set(['rad_alleinunfall', 'rad_alleinunfall_schwer']);
      },
      deriveContextualMeasures() {
        return { kurzfristig: [], mittelfristig: [], pruefauftraege: [], rationale: '', matchedRules: [] };
      },
    };
    UA.EvidenceSafeSemantics.install();

    const mixed = UA.contextMeasures.classifyPatterns({
      deviations: { focus: [{ mask: 1 }] },
      severity: { bySev: { '2': 1, '3': 2 } },
      accidentDetails: { rows: [
        { mask: 1, severity: 3 },
        { mask: 1, severity: 3 },
        { mask: 6, severity: 2 },
      ] },
    });
    expect(mixed.has('rad_alleinunfall_schwer')).toBe(false);

    const sameCohort = UA.contextMeasures.classifyPatterns({
      deviations: { focus: [{ mask: 1 }] },
      accidentDetails: { rows: [{ mask: 1, severity: 2 }] },
    });
    expect(sameCohort.has('rad_alleinunfall_schwer')).toBe(true);
  });

  test('turns purpose-inference clusters into descriptive time windows', async () => {
    const UA = loadBootstrap();
    const clusters = [{
      id: 'werktag_schule_morgens',
      label: 'Schulverkehr (morgens)',
      weekdayGroup: 'Werktag',
      hours: [[7, 0], [8, 30]],
      typicalParticipants: ['Kinder', 'Rad', 'Fuß'],
    }];
    UA.timeClusters = {
      DEFAULT_CLUSTERS: clusters,
      FALLBACK: { version: 1, clusters },
      async loadTimeClusters() { return { version: 1, clusters }; },
      classify() { return 'werktag_schule_morgens'; },
    };
    UA.EvidenceSafeSemantics.install();

    expect(UA.timeClusters.DEFAULT_CLUSTERS[0].label).toBe('Werktägliches Morgenfenster');
    expect(UA.timeClusters.DEFAULT_CLUSTERS[0].typicalParticipants).toEqual([]);
    expect(UA.timeClusters.DEFAULT_CLUSTERS[0].interpretation).toMatch(/nicht veröffentlicht/);
    const loaded = await UA.timeClusters.loadTimeClusters('bonn');
    expect(loaded.clusters[0].label).toBe('Werktägliches Morgenfenster');
  });

  test('renders accident events instead of person counts and removes the bus inference', () => {
    const UA = loadBootstrap();
    UA.applyAccidentView = () => ({
      groups: [{
        key: '2',
        meta: { mask: 33, label: '🚲+🚌', sevLabel: 'Schwerverletzte' },
        rows: [{ mask: 33, severity: 2, involved: '🚲+🚌', sevLabel: 'Schwerverletzt' }],
        headers: {
          text: '--- Schwerverletzte (n=1) · 🚌 ---',
          html: '<div>Schwerverletzte (n=1) · 🚌</div>',
          docx: [{ text: 'Schwerverletzte (n=1) · 🚌' }],
        },
      }],
    });
    UA.EvidenceSafeSemantics.install();

    const result = UA.applyAccidentView([], 'bySeverity');
    const group = result.groups[0];
    expect(group.meta.label).toBe('Beteiligungskategorien: Rad + Sonstige');
    expect(group.meta.sevLabel).toBe('Unfälle mit Schwerverletzten');
    expect(group.rows[0].sevLabel).toBe('Unfall mit Schwerverletzten');
    expect(group.rows[0].involved).toBe('Beteiligungskategorien: Rad + Sonstige');
    expect(JSON.stringify(group.headers)).not.toMatch(/🚌|ÖPNV|Bus/);
  });

  test('fills interior zero years in the trend axis', () => {
    const UA = loadBootstrap();
    UA.trend = {
      computeYearlyTrend() {
        return { years: [2019, 2021], counts: { fatal: [0, 0], severe: [0, 0], light: [1, 1], total: [1, 1] }, slope: 0, intercept: 1, r2: 1, classification: 'stagnierend', nYears: 2 };
      },
      linearRegression(xs, ys) {
        return { slope: 0, intercept: ys.reduce((a, b) => a + b, 0) / ys.length, r2: 0, mean: ys.reduce((a, b) => a + b, 0) / ys.length };
      },
      classifyTrend() { return 'stagnierend'; },
    };
    UA.EvidenceSafeSemantics.install();

    const result = UA.trend.computeYearlyTrend([
      { props: { year: 2019, ukategorie: 3 } },
      { props: { year: 2021, ukategorie: 3 } },
    ]);
    expect(result.years).toEqual([2019, 2020, 2021]);
    expect(result.counts.total).toEqual([1, 0, 1]);
    expect(result.zeroYears).toEqual([2020]);
  });

  test('normalises final report, fallback title, measures and AI facts fail-closed', async () => {
    const UA = loadBootstrap();
    UA.computeExportReport = async () => ({
      text: 'Betreff: Auffälliger Unfallschwerpunkt. URSACHEN UND MASSNAHMEN. Fahrrad-Alleinunfälle. Die tatsächliche Belastung kann je nach Verkehrsart um den Faktor 2–10 höher liegen.',
      html: '<h1>Auffälliger Unfallschwerpunkt</h1><p>Rad+Pkw-Kollisionen</p>',
      structured: {
        title: 'Auffälliger Unfallschwerpunkt',
        deviations: {
          rows: [{ mask: 5, factor: 1.2, isSignificant: false }],
          focus: [{ mask: 5, factor: 1.2, isSignificant: false }],
        },
        executiveSummary: {
          classification: 'Lokaler Häufungspunkt mit erhöhtem Risikoprofil',
          bullets: ['Schwerpunktmuster Rad-/Pkw-Konflikt.'],
          urgency: 'Befassung empfohlen.',
        },
        contextualMeasures: {
          kurzfristig: ['Gefahrenstelle markieren.'],
          mittelfristig: ['Radweg bauen.'],
          pruefauftraege: ['Prüfung der Geometrie.'],
          rationale: 'Die Unfalldaten belegen die Häufung.',
          patterns: ['rad_pkw_kollision'],
        },
        darkFigureNote: { body: 'Die tatsächliche Belastung kann je nach Verkehrsart um den Faktor 2–10 höher liegen.' },
      },
    });
    UA.EvidenceSafeSemantics.install();

    const report = await UA.computeExportReport({});
    expect(report.text).not.toMatch(/Auffälliger Unfallschwerpunkt|URSACHEN UND MASSNAHMEN|Fahrrad-Alleinunfall|Faktor 2[–-]10/);
    expect(report.html).not.toMatch(/Auffälliger Unfallschwerpunkt|Kollision/);
    expect(report.structured.deviations.focus[0].textLabel).toMatch(/Radverkehr.*Pkw/);
    expect(report.structured.executiveSummary.classification).toMatch(/Explorative Abweichung/);
    expect(report.structured.executiveSummary.classification).toMatch(/kein räumlicher oder amtlicher Unfallschwerpunkt/);
    expect(report.structured.contextualMeasures.kurzfristig[0]).toMatch(/^Prüfoption/);
    expect(report.structured.contextualMeasures.mittelfristig[0]).toMatch(/^Prüfoption/);
    expect(report.structured.contextualMeasures.evidenceStage).toBe('mechanism-candidate');
    expect(report.structured.darkFigureNote.body).not.toMatch(/Faktor 2[–-]10/);
    expect(report.structured.semanticContract.schemaVersion).toBe('unfallwerkbank.evidenceSafeSemantics.v1');
  });
});
