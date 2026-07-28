'use strict';

const scenarios = require('../../scripts/document-golden-scenarios');
const matrix = require('../../scripts/generate-document-golden-matrix');

describe('long document Golden scenario layout input', () => {
  test('converts every declared stress paragraph into a renderer-owned structured section', () => {
    const scenario = scenarios.getScenario('long-multi-section-report');
    const report = matrix.buildScenarioReportData(scenario);

    expect(report.structured.patterns).toHaveLength(scenario.narrativeParagraphs.length);
    expect(report.structured.patterns).toHaveLength(24);
    expect(report.structured.patterns[0]).toEqual({
      title: 'Prüfabschnitt 1',
      content: expect.stringContaining('deterministischer Layout- und Umbruchfall'),
    });
    expect(report.structured.patterns[23].title).toBe('Prüfabschnitt 24');
    expect(report.structured.patterns.every((item) =>
      item.content.includes('keine zusätzliche fachliche Tatsachenbehauptung')
    )).toBe(true);
  });

  test('does not change the established Bonn reference report', () => {
    const report = matrix.buildScenarioReportData(
      scenarios.getScenario('bonn-urban-junction'),
    );
    expect(report.structured.patterns).toEqual([]);
    expect(report.text).toContain('24 Unfälle');
    expect(report.structured.severity.total).toBe(24);
  });
});
