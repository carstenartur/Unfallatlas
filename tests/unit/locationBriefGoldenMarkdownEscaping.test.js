'use strict';

const {
  markdownCell,
  renderMarkdown
} = require('../../scripts/qa-location-brief-golden-cases');

describe('Location Brief golden-case Markdown escaping', () => {
  test('encodes backslashes and table separators without ambiguous escaping', () => {
    expect(markdownCell('A\\B|C\nD')).toBe('A&#92;B&#124;C D');
  });

  test('keeps generated table rows structurally intact for untrusted labels', () => {
    const markdown = renderMarkdown({
      generatedAt: '2026-07-18T00:00:00.000Z',
      summary: { passed: true, passedCaseCount: 1, caseCount: 1 },
      failedChecks: [],
      cities: [{
        city: 'Bonn|West',
        cases: [{
          caseId: 'case\\id|variant',
          kind: 'positive',
          accidentCount: 1,
          severeAccidentCount: 0,
          score: 0.5,
          localPreflightRank: 1,
          patterns: ['pattern|one'],
          recommendedMeasures: ['measure\\one'],
          confidence: { overall: 'high' },
          passed: true
        }]
      }]
    });

    expect(markdown).toContain('## Bonn&#124;West');
    expect(markdown).toContain('case&#92;id&#124;variant');
    expect(markdown).toContain('pattern&#124;one');
    expect(markdown).toContain('measure&#92;one');
  });
});
