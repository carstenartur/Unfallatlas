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
        evaluate(options = {}) {
          const errors = Array.isArray(options.errors) ? options.errors : [];
          const warnings = Array.isArray(options.warnings) ? options.warnings : [];
          const blocked = errors.length > 0;
          const conditional = !blocked && warnings.length > 0;
          return {
            passed: !blocked,
            readyForApplication: !blocked,
            filingReady: !blocked && !conditional,
            filingReadinessStatus: blocked
              ? 'blocked'
              : (conditional ? 'conditional' : 'ready'),
            errors,
            warnings,
            checks: Array.isArray(options.checks) ? options.checks : [],
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

function facts(classification, mapReality) {
  return {
    visualSceneAnalysisContract: mapReality ? { mapReality } : undefined,
    structured: {
      deviations: { focus: [] },
      executiveSummary: { classification, bullets: [], urgency: '' },
      meta: { activeFilterMask: 0, involvementMode: 'or' },
    },
  };
}

function codes(messages) {
  return messages.map(message => message.code);
}

describe('semantic filing preflight edge cases', () => {
  test('postposed negation does not become a positive hotspot claim', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts('Ein Unfallschwerpunkt ist nicht belegt.'),
      result: { candidateMeasures: [] },
    });

    expect(gate.passed).toBe(true);
    expect(codes(gate.errors)).not.toContain('semantic-official-hotspot-overclaim');
  });

  test('a synthetic map permits an administrative decision for a qualified investigation', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts(
        'Keine belastbare lokale Musterabweichung.',
        'synthetic QA-only map'
      ),
      result: {
        candidateMeasures: [{
          option: 'Einen Prüfauftrag zur Vor-Ort-Untersuchung beschließen.',
          findingRefs: ['map-1'],
        }],
      },
    });

    expect(gate.passed).toBe(true);
    expect(gate.filingReadinessStatus).toBe('conditional');
    expect(codes(gate.errors)).not.toContain('semantic-synthetic-map-concrete-measure');
  });

  test('a physical implementation remains blocked even when a later review is mentioned', () => {
    const UA = loadGate();
    const gate = UA.filingReadiness.evaluate({
      facts: facts(
        'Keine belastbare lokale Musterabweichung.',
        'synthetic QA-only map'
      ),
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
});
