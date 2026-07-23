'use strict';

const contract = require('../../scripts/documentation-deeplink-contract.cjs');

describe('README live deep-link repository contract', () => {
  test('keeps only publicly reproducible screenshots linked and exposes named public actions', () => {
    const result = contract.validateDocumentationLinks(process.cwd());
    expect(new Set(result.liveScenarios.map((scenario) => scenario.id))).toEqual(new Set([
      'readme-start',
      'readme-cluster',
      'readme-export',
      'readme-poi-school-route',
      'readme-bonn-hbf',
    ]));
    expect(result.liveScenarios).toHaveLength(Object.keys(contract.SCENARIOS).length);
    expect(result.liveScenarios.filter((scenario) => scenario.imagePath)).toHaveLength(2);
    expect(result.liveScenarios.every((scenario) => scenario.knownMismatch == null)).toBe(true);
    expect(result.liveScenarios.filter((scenario) => scenario.expected.publicPreview)).toHaveLength(3);
    expect(result.liveScenarios.find((scenario) => scenario.id === 'readme-export'))
      .toMatchObject({ expected: { publicPreview: true, verifyDownloads: true } });
  });
});
