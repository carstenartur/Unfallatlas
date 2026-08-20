'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'js', 'ua.semantic_filing_gate.js'),
  'utf8'
);

function loadGate() {
  const root = {
    UA: {
      filingReadiness: Object.freeze({
        SCHEMA_VERSION: 'unfallwerkbank.filingReadiness.v1',
        evaluate(options = {}) {
          const errors = Array.isArray(options.errors) ? options.errors : [];
          const warnings = Array.isArray(options.warnings) ? options.warnings : [];
          const checks = Array.isArray(options.checks) ? options.checks : [];
          const blocked = errors.length > 0;
          const conditional = !blocked && warnings.length > 0;
          return {
            schemaVersion: 'unfallwerkbank.filingReadiness.v1',
            passed: !blocked,
            readyForApplication: !blocked,
            filingReady: !blocked && !conditional,
            analysisQaStatus: blocked ? 'blocked' : (conditional ? 'conditional' : 'ready'),
            politicalResearchStatus: 'complete',
            filingReadinessStatus: blocked ? 'blocked' : (conditional ? 'conditional' : 'ready'),
            modelFilingReadinessStatus: 'ready',
            score: blocked ? 0 : (conditional ? 80 : 100),
            expectedPatternIds: [],
            errors,
            warnings,
            checks,
          };
        },
      }),
      async computeExportReport(report) {
        return report || {};
      },
    },
    setInterval,
    clearInterval,
  };
  root.window = root;
  root.globalThis = root;
  vm.runInNewContext(SOURCE, root, { filename: 'ua.semantic_filing_gate.js' });
  return root.UA;
}

function facts({
  focus = [],
  classification = '',
  bullets = [],
  activeFilterMask = 0,
  involvementMode = 'or',
  mapReality,
  title = '',
  subject = '',
  resolution = '',
  spatialClusterSupported = false,
  corridorProblemSupported = false,
  officialAccidentHotspot = false,
  text = '',
  html = '',
} = {}) {
  return {
    title,
    subject,
    text,
    html,
    visualSceneAnalysisContract: mapReality ? { mapReality } : undefined,
    structured: {
      title,
      subject,
      resolution,
      deviations: { focus },
      executiveSummary: { classification, bullets, urgency: '' },
      spatialClusterSupported,
      corridorProblemSupported,
      officialAccidentHotspot,
      meta: { activeFilterMask, involvementMode },
    },
  };
}

function codes(messages) {
  return messages.map(message => message.code);
}

describe('semantic filing preflight', () => {
  test('blocks the current non-significant Häufungspunkt and Schwerpunktmuster wording', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        focus: [{
          label: 'Rad + Pkw',
          factor: 1.52,
          isSignificant: false,
          mask: 5,
        }],
        classification: 'Lokaler Häufungspunkt mit erhöhtem Risikoprofil – Prüfung empfohlen.',
        bullets: ['Schwerpunktmuster Rad + Pkw: lokal 1,52× so häufig.'],
      }),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(false);
    expect(gate.readyForApplication).toBe(false);
    expect(gate.semanticAnalysisClassification.patternComposition).toBe('exploratory');
    expect(codes(gate.errors)).toEqual(expect.arrayContaining([
      'semantic-spatial-cluster-overclaim',
      'semantic-pattern-composition-overclaim',
    ]));
    expect(codes(gate.warnings)).toContain('semantic-focus-exploratory');
  });

  test('accepts explicitly exploratory wording but keeps filing readiness conditional', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        focus: [{
          label: 'Rad + Pkw',
          factor: 1.52,
          isSignificant: false,
          mask: 5,
        }],
        classification: 'Explorative Abweichung in der Musterzusammensetzung; kein räumlicher oder amtlicher Unfallschwerpunkt belegt.',
      }),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(true);
    expect(gate.readyForApplication).toBe(true);
    expect(gate.filingReady).toBe(false);
    expect(gate.filingReadinessStatus).toBe('conditional');
    expect(gate.errors).toEqual([]);
    expect(codes(gate.warnings)).toContain('semantic-focus-exploratory');
  });

  test('a significant pattern-composition deviation does not prove a spatial or official hotspot', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        focus: [{
          label: 'Rad + Pkw',
          factor: 2.1,
          isSignificant: true,
          mask: 5,
        }],
        classification: 'Auffälliger Unfallschwerpunkt im markierten Bereich.',
      }),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(false);
    expect(codes(gate.errors)).toContain('semantic-official-hotspot-overclaim');
    expect(codes(gate.errors)).not.toContain('semantic-spatial-cluster-overclaim');
    expect(gate.semanticAnalysisClassification.patternComposition).toBe('supported-anomaly');
    expect(gate.semanticAnalysisClassification.spatialCluster).toBe('not-established');
    expect(gate.semanticAnalysisClassification.officialAccidentHotspot).toBe('not-established');
  });

  test('separated pattern-composition language passes for a significant focus row', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        focus: [{
          label: 'Rad + Pkw',
          factor: 2.1,
          isSignificant: true,
          mask: 5,
        }],
        classification: 'Signifikante Abweichung in der lokalen Musterzusammensetzung.',
      }),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(true);
    expect(gate.filingReady).toBe(true);
    expect(gate.errors).toEqual([]);
    expect(gate.semanticAnalysisClassification.patternComposition).toBe('supported-anomaly');
  });

  test('blocks a filter-forced involvement feature presented as a separate local finding', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        focus: [{
          label: 'Rad + Pkw',
          factor: 2.1,
          isSignificant: true,
          mask: 5,
        }],
        activeFilterMask: 5,
        involvementMode: 'and',
        classification: 'Schwerpunktmuster Rad + Pkw ist statistisch signifikant.',
      }),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(false);
    expect(codes(gate.errors)).toContain('semantic-filter-scope-tautology');
    expect(gate.semanticAnalysisClassification.forcedByFilterCount).toBe(1);
  });

  test('synthetic map evidence blocks concrete infrastructure measures', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        mapReality: 'deterministic-map-fixture',
        classification: 'Keine belastbare lokale Musterabweichung.',
      }),
      result: {
        candidateMeasures: [{
          option: 'Geschützten Radfahrstreifen einrichten und Poller installieren.',
          findingRefs: ['map-1'],
        }],
      },
    });

    expect(gate.passed).toBe(false);
    expect(codes(gate.errors)).toContain('semantic-synthetic-map-concrete-measure');
    expect(codes(gate.warnings)).toContain('semantic-synthetic-map-context');
    expect(gate.semanticAnalysisClassification.mapReality).toBe('synthetic');
  });

  test('synthetic map evidence permits only a conditional qualified investigation task', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        mapReality: 'synthetic QA-only map',
        classification: 'Keine belastbare lokale Musterabweichung.',
      }),
      result: {
        candidateMeasures: [{
          option: 'Machbarkeit eines geschützten Radfahrstreifens in einer Vor-Ort-Prüfung untersuchen.',
          prerequisites: ['Fachprüfung und reale Ortsbesichtigung'],
          findingRefs: ['map-1'],
        }],
      },
    });

    expect(gate.passed).toBe(true);
    expect(gate.filingReady).toBe(false);
    expect(gate.filingReadinessStatus).toBe('conditional');
    expect(codes(gate.errors)).not.toContain('semantic-synthetic-map-concrete-measure');
    expect(codes(gate.warnings)).toContain('semantic-synthetic-map-context');
  });

  test('blocks a stronger static title when the executive summary is explicitly exploratory', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        focus: [{
          label: 'Rad + Pkw',
          factor: 1.4,
          isSignificant: false,
          mask: 5,
        }],
        title: 'Auffälliger Unfallschwerpunkt im markierten Bereich',
        classification: 'Explorative Abweichung in der Beteiligungsmuster-Zusammensetzung; kein räumlicher oder amtlicher Unfallschwerpunkt belegt.',
      }),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(false);
    expect(codes(gate.errors)).toContain('semantic-static-summary-conflict');
    expect(codes(gate.errors)).toContain('semantic-official-hotspot-overclaim');
  });

  test('conditional template language about checking whether a hotspot exists is not treated as a claim', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        classification: 'Keine belastbare lokale Musterabweichung.',
        resolution: 'Die Verwaltung soll prüfen und klären, ob ein einzelner Unfallschwerpunkt oder mehrere Teilprobleme vorliegen.',
      }),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(true);
    expect(codes(gate.errors)).not.toContain('semantic-official-hotspot-overclaim');
  });

  test('model output cannot upgrade missing spatial or official evidence', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        classification: 'Auffälliger Unfallschwerpunkt im markierten Bereich.',
      }),
      result: {
        officialAccidentHotspot: true,
        spatialClusterSupported: true,
        candidateMeasures: [],
      },
    });

    expect(gate.passed).toBe(false);
    expect(codes(gate.errors)).toContain('semantic-official-hotspot-overclaim');
    expect(gate.semanticAnalysisClassification.officialAccidentHotspot).toBe('not-established');
    expect(gate.semanticAnalysisClassification.spatialCluster).toBe('not-established');
  });

  test('corridor claims require an independent deterministic corridor finding', () => {
    const UA = loadGate();
    const blocked = UA.filingReadiness.evaluate({
      facts: facts({
        classification: 'Streckenbezogene Unfallhäufung mit Korridorproblem.',
      }),
      result: { candidateMeasures: [] },
    });
    expect(codes(blocked.errors)).toContain('semantic-corridor-overclaim');

    const supported = UA.filingReadiness.evaluate({
      facts: facts({
        classification: 'Streckenbezogene Unfallhäufung mit Korridorproblem.',
        corridorProblemSupported: true,
      }),
      result: { candidateMeasures: [] },
    });
    expect(codes(supported.errors)).not.toContain('semantic-corridor-overclaim');
    expect(supported.semanticAnalysisClassification.corridorProblem).toBe('supported');
  });

  test('a concrete implementation verb remains blocked even when a later Fachprüfung is mentioned', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts({
        mapReality: 'synthetic QA-only map',
        classification: 'Keine belastbare lokale Musterabweichung.',
      }),
      result: {
        candidateMeasures: [{
          option: 'Poller installieren und anschließend durch die Fachplanung prüfen lassen.',
          findingRefs: ['map-1'],
        }],
      },
    });

    expect(gate.passed).toBe(false);
    expect(codes(gate.errors)).toContain('semantic-synthetic-map-concrete-measure');
  });

  test('normalises the deterministic report before the AI handoff', () => {
    const UA = loadGate();
    const raw = {
      text: [
        'Betreff: Verbesserung der Verkehrssicherheit – Auffälliger Unfallschwerpunkt im markierten Bereich',
        'Lokaler Häufungspunkt mit erhöhtem Risikoprofil – Prüfung empfohlen.',
        'Schwerpunktmuster Rad + Pkw: rund 1,5-mal so häufig wie im Stadtmittel.',
        'Schwerpunkt der Häufung: Beispielstraße.',
      ].join('\n'),
      html: [
        '<h1>Auffälliger Unfallschwerpunkt im markierten Bereich</h1>',
        '<p>Lokaler Häufungspunkt mit erhöhtem Risikoprofil – Prüfung empfohlen.</p>',
        '<li>Schwerpunktmuster Rad + Pkw: rund 1,5-mal so häufig wie im Stadtmittel.</li>',
        '<p>Schwerpunkt der Häufung: Beispielstraße.</p>',
      ].join(''),
      structured: {
        title: 'Auffälliger Unfallschwerpunkt im markierten Bereich',
        deviations: {
          focus: [{
            label: 'Rad + Pkw',
            factor: 1.52,
            isSignificant: false,
            mask: 5,
          }],
        },
        executiveSummary: {
          classification: 'Lokaler Häufungspunkt mit erhöhtem Risikoprofil – Prüfung empfohlen.',
          bullets: ['Schwerpunktmuster Rad + Pkw: rund 1,5-mal so häufig wie im Stadtmittel.'],
          urgency: 'Befassung empfohlen; Wirksamkeit der Maßnahmen monitoren.',
        },
        mapReferences: ['Schwerpunkt der Häufung: Beispielstraße.'],
        meta: { activeFilterMask: 0, involvementMode: 'or' },
      },
    };

    const normalised = UA.semanticFilingGate.normaliseReport(raw);
    expect(normalised).not.toBe(raw);
    expect(normalised.structured.executiveSummary.classification)
      .toMatch(/^Explorative Abweichung/);
    expect(normalised.structured.executiveSummary.bullets[0])
      .toContain('Anteilvergleich, keine absolute Unfallrate');
    expect(normalised.text).not.toContain('Lokaler Häufungspunkt');
    expect(normalised.text).not.toContain('Schwerpunktmuster');
    expect(normalised.text).not.toContain('Auffälliger Unfallschwerpunkt im markierten Bereich');
    expect(normalised.text).toContain('Räumlicher Bezugspunkt der Auswahl:');
    expect(normalised.structured.semanticAnalysisClassification.patternComposition)
      .toBe('exploratory');

    const residualCodes = codes(normalised.structured.semanticPreflight.errors);
    expect(residualCodes).not.toContain('semantic-official-hotspot-overclaim');
    expect(residualCodes).not.toContain('semantic-spatial-cluster-overclaim');
    expect(residualCodes).not.toContain('semantic-pattern-composition-overclaim');
  });

  test('installation is idempotent and preserves the original evaluator chain', () => {
    const UA = loadGate();
    const first = UA.filingReadiness.evaluate;
    expect(first._uaSemanticFilingGate).toBe(true);
    expect(typeof first._original).toBe('function');

    const reportAdapter = UA.computeExportReport;
    expect(reportAdapter._uaSemanticReportAdapter).toBe(true);
    expect(typeof reportAdapter._original).toBe('function');

    expect(UA.semanticFilingGate.install()).toBe(true);
    expect(UA.semanticFilingGate.installReportAdapter()).toBe(true);
    expect(UA.filingReadiness.evaluate).toBe(first);
    expect(UA.computeExportReport).toBe(reportAdapter);
  });
});
