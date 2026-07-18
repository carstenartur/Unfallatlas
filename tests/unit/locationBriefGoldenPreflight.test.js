'use strict';

const path = require('path');
const {
  buildArtifact,
  renderMarkdown
} = require('../../scripts/qa-location-brief-golden-cases');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.resolve(REPO_ROOT, 'tests/fixtures/location-brief-golden-cases.json');

describe('Location Action Brief real-data golden preflight', () => {
  test('Bonn and Hannover positive cases outrank their negative controls', () => {
    const artifact = buildArtifact(FIXTURE);

    expect(artifact.summary).toMatchObject({
      cityCount: 2,
      caseCount: 6,
      positiveCaseCount: 4,
      negativeCaseCount: 2,
      failedCheckCount: 0,
      passed: true
    });
    expect(artifact.cities.map((city) => city.city)).toEqual(['Bonn', 'Hannover']);
    for (const city of artifact.cities) {
      const positives = city.cases.filter((item) => item.kind === 'positive');
      const negative = city.cases.find((item) => item.kind === 'negative');
      expect(positives).toHaveLength(2);
      expect(negative).toBeDefined();
      expect(negative.confidence.overall).toBe('low');
      expect(negative.localPreflightRank).toBeGreaterThan(
        Math.max(...positives.map((item) => item.localPreflightRank))
      );
    }
  });

  test('renders the interpretation boundary into the reviewable Markdown report', () => {
    const markdown = renderMarkdown(buildArtifact(FIXTURE));
    expect(markdown).toContain('Result: **PASS**');
    expect(markdown).toContain('Selected context hints and political references are fixture inputs');
    expect(markdown).toContain('does not prove accident causation');
    expect(markdown).toContain('npm run test:location-brief-golden:tc');
  });
});
