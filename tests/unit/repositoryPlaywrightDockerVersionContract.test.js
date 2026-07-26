'use strict';

const path = require('path');
const {
  checkVersions,
} = require('../../scripts/check-playwright-docker-version.js');

describe('checked-in Playwright Docker contract', () => {
  test('keeps package.json, package-lock.json and Dockerfile aligned', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const result = checkVersions(repoRoot);

    if (!result.ok) {
      throw new Error([
        result.message,
        ...(result.details || []),
      ].join('\n'));
    }

    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
