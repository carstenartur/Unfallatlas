'use strict';

const contract = require('../../scripts/documentation-deeplink-contract.cjs');

describe('user-facing documentation deep-link repository contract', () => {
  test('keeps every shown screenshot reproducible and exposes representative live checks', () => {
    const result = contract.validateDocumentationLinks(process.cwd());

    expect(new Set(result.liveScenarios.map((scenario) => scenario.id))).toEqual(new Set([
      'docs-cluster-hannover',
      'docs-selection-bonn',
      'docs-poi-bonn',
      'readme-start',
      'readme-export',
      'readme-bonn-hbf',
    ]));
    expect(result.liveScenarios).toHaveLength(Object.keys(contract.SCENARIOS).length);
    expect(result.liveScenarios.filter((scenario) => scenario.imagePath)).toHaveLength(3);
    expect(result.liveScenarios.every((scenario) => scenario.knownMismatch == null)).toBe(true);
    expect(result.liveScenarios.filter((scenario) => scenario.expected.publicPreview)).toHaveLength(3);

    const documentedPaths = new Set(result.links.map((link) => link.imagePath));
    expect(documentedPaths).toEqual(new Set(Object.keys(contract.SCREENSHOT_SCENARIOS)));
    expect(result.links.every((link) => link.url.startsWith(
      `${contract.LIVE_ORIGIN}${contract.LIVE_PATH}?`,
    ))).toBe(true);

    const exportScenario = result.liveScenarios.find((scenario) => scenario.id === 'readme-export');
    expect(exportScenario).toMatchObject({
      expected: {
        publicPreview: true,
        hourFrom: 6,
        hourTo: 18,
        showCluster: true,
        showHeatmap: false,
      },
    });
    expect(exportScenario.expected.exportOpen).toBeUndefined();
    expect(exportScenario.expected.verifyDownloads).toBeUndefined();
    expect(new URL(exportScenario.canonicalUrl).searchParams.has('export')).toBe(false);
  });
});
