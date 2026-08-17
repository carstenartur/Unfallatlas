/** @jest-environment jsdom */
'use strict';

const fs = require('fs');
const path = require('path');

function loadModules() {
  jest.resetModules();
  window.UA = {};
  window.__UA_DISABLE_PATTERN_PLUGIN_AUTOINSTALL__ = true;
  for (const relative of ['../../js/ua.analysis_pipeline.js', '../../js/ua.pattern_plugins.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
    (function evaluate(window) { eval(source); })(window); // eslint-disable-line no-eval
  }
  return window.UA;
}

function point(lat, lon, overrides = {}) {
  return {
    lat,
    lon,
    props: {
      IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '0', IstSonstig: '0',
      ukategorie: '3', year: '2024', ustunde: '8', uwochentag: '2', strzustand: '0',
      ...overrides,
    },
  };
}

function fixture(points) {
  return {
    meta: { city: 'Hannover', date: '2026-08-16' },
    severity: { total: points.length, bySev: { '1': 0, '2': 1, '3': points.length - 1 } },
    yearTable: [
      { year: 2019, total: 1 }, { year: 2020, total: 1 }, { year: 2021, total: 1 },
      { year: 2022, total: 1 }, { year: 2023, total: 1 }, { year: 2024, total: 1 },
      { year: 2025, total: Math.max(0, points.length - 6) },
    ],
    yearlyTrend: { classification: 'stagnierend', slope: 0.1, r2: 0.1, nYears: 7 },
    crossTable: { rows: [{ mask: 1, total: points.length }] },
    deviations: {
      local: { total: points.length }, baseline: { total: 100 },
      focus: [{
        mask: 1, locCnt: points.length, baseCnt: 40,
        locR: 1, baseR: 0.4, factor: 2.5, ciLow: 0.7, ciHigh: 1,
        isSignificant: true,
      }],
    },
    contextualMeasures: {
      contexts: ['straßenbahn_schienen', 'gleisquerung'],
      matchedRules: [{ id: 'legacy-rail', pattern: 'rad_alleinunfall', context: 'straßenbahn_schienen' }],
      patterns: ['rad_alleinunfall'],
      pruefauftraege: ['Bestehender Prüfauftrag'],
    },
  };
}

describe('UA.PatternPlugins', () => {
  afterEach(() => {
    delete window.UA;
    delete window.__UA_DISABLE_PATTERN_PLUGIN_AUTOINSTALL__;
    jest.restoreAllMocks();
  });

  test('runs deterministic detectors before the aggregate and exposes a canonical AI contract', async () => {
    const UA = loadModules();
    const points = Array.from({ length: 8 }, (_, index) =>
      point(52.3910 + index * 0.00030, 9.7200 + index * 0.00001, {
        ukategorie: index === 0 ? '2' : '3',
        ustunde: String(7 + (index % 3)),
        strzustand: index < 3 ? '1' : '0',
      }));

    const result = await UA.PatternPlugins.runPatternPipeline({
      structured: fixture(points), accidents: points,
    });

    expect(result.pipeline.orderedPluginIds.at(-1)).toBe('pattern-aggregate');
    expect(result.artifact.schemaVersion).toBe('unfallwerkbank.patternDetection.v1');
    expect(result.artifact.aiEvaluationContract.ordering)
      .toBe('deterministic-pattern-detection-before-model-evaluation');
    expect(result.artifact.detectorRuns).toHaveLength(6);
  });

  test('treats bike-only accidents plus rail context as an explicit mechanism candidate, not a proven cause', async () => {
    const UA = loadModules();
    const points = Array.from({ length: 8 }, (_, index) =>
      point(52.3910 + index * 0.00030, 9.7200 + index * 0.00001));

    const { artifact } = await UA.PatternPlugins.runPatternPipeline({
      structured: fixture(points), accidents: points,
    });
    const rail = artifact.findings.find(item => item.id === 'bike-solo-rail-mechanism-candidate');

    expect(rail).toBeDefined();
    expect(rail.classification).toBe('primary');
    expect(rail.causalStatus).toBe('mechanism-candidate');
    expect(rail.limitations.join(' ')).toMatch(/Ko-Präsenz.*beweist noch nicht/i);
    expect(rail.requiredVerification.join(' ')).toMatch(/Abstand.*Schienenachse/i);
    expect(artifact.findings.map(item => item.id)).toContain('bike-only-linear-corridor-pattern');
  });

  test('blocks downstream certainty when fundamental totals conflict', async () => {
    const UA = loadModules();
    const points = [point(52.39, 9.72), point(52.391, 9.721), point(52.392, 9.722), point(52.393, 9.723)];
    const structured = fixture(points);
    structured.severity.bySev['3'] = 2;

    const { artifact } = await UA.PatternPlugins.runPatternPipeline({ structured, accidents: points });

    expect(artifact.status).toBe('blocked-by-data-quality');
    expect(artifact.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'severity-total-mismatch', status: 'blocking-data-issue' }),
    ]));
  });

  test('degrades transparently when raw points are unavailable', async () => {
    const UA = loadModules();
    const points = Array.from({ length: 8 }, (_, index) => point(52.39 + index * 0.0001, 9.72));

    const { artifact } = await UA.PatternPlugins.runPatternPipeline({ structured: fixture(points) });

    expect(artifact.status).toBe('partial');
    expect(artifact.detectorRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'pattern-spatial-morphology', status: 'partial' }),
    ]));
  });

  test('wraps the export once and bridges findings into the existing server-AI input path', async () => {
    const UA = loadModules();
    const points = Array.from({ length: 8 }, (_, index) => point(52.3910 + index * 0.00030, 9.7200));
    const structured = fixture(points);
    UA.computeExportReport = jest.fn(async () => ({ text: 'report', structured }));

    expect(UA.PatternPlugins.wrapExportReport()).toBe(true);
    expect(UA.PatternPlugins.wrapExportReport()).toBe(true);
    const report = await UA.computeExportReport({ filteredAll: points });

    expect(report.structured.patternDetection.schemaVersion)
      .toBe('unfallwerkbank.patternDetection.v1');
    expect(report.structured.contextualMeasures.patternFindings.length).toBeGreaterThan(0);
    expect(report.structured.contextualMeasures.patterns.join(' '))
      .toMatch(/bike-solo-rail-mechanism-candidate.*mechanism-candidate/i);
    expect(report.structured.contextualMeasures.matchedRules)
      .toEqual(expect.arrayContaining([expect.objectContaining({ detectorId: 'pattern-context-combination' })]));
  });
});
