'use strict';

const contract = require('../../scripts/documentation-deeplink-contract.cjs');

describe('README live deep-link repository contract', () => {
  test('keeps all canonical screenshot scenarios linked from the checked-in README', () => {
    const result = contract.validateDocumentationLinks(process.cwd());
    expect(new Set(result.liveScenarios.map((scenario) => scenario.id))).toEqual(new Set([
      'readme-start',
      'readme-cluster',
      'readme-export',
      'readme-poi-school-route',
      'readme-bonn-hbf',
    ]));
    expect(result.liveScenarios).toHaveLength(Object.keys(contract.SCENARIOS).length);
    expect(result.liveScenarios.find((scenario) => scenario.id === 'readme-cluster'))
      .toMatchObject({ knownMismatch: { issue: 509 } });
  });
});
