'use strict';

const scenarios = require('../../scripts/document-golden-scenarios');
const matrix = require('../../scripts/generate-document-golden-matrix');

describe('long document Golden scenario layout input', () => {
  test('adds one visible context section and keeps every stress paragraph numbered', () => {
    const scenario = scenarios.getScenario('long-multi-section-report');
    const report = matrix.buildScenarioReportData(scenario);

    expect(report.structured.patterns).toHaveLength(scenario.narrativeParagraphs.length + 1);
    expect(report.structured.patterns).toHaveLength(25);
    expect(report.structured.patterns[0]).toEqual({
      title: 'Kontextstatus',
      content: expect.stringContaining('Kontextstatus: verfügbar.'),
    });
    expect(report.structured.patterns[1]).toEqual({
      title: 'Prüfabschnitt 1',
      content: expect.stringContaining('deterministischer Layout- und Umbruchfall'),
    });
    expect(report.structured.patterns[24].title).toBe('Prüfabschnitt 24');
    expect(report.structured.patterns.slice(1).every((item) =>
      item.content.includes('keine zusätzliche fachliche Tatsachenbehauptung')
    )).toBe(true);
  });

  test('adds context status without changing the established Bonn reference figures', () => {
    const report = matrix.buildScenarioReportData(
      scenarios.getScenario('bonn-urban-junction'),
    );
    expect(report.structured.patterns).toEqual([{
      title: 'Kontextstatus',
      content: expect.stringContaining('Kontextstatus: verfügbar.'),
    }]);
    expect(report.text).toContain('24 Unfälle');
    expect(report.structured.severity.total).toBe(24);
  });
});
