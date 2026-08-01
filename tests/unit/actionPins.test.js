'use strict';

const { validateActionPins } = require('../../scripts/validate-action-pins');

describe('GitHub Actions supply-chain contract', () => {
  test('all external actions are pinned to immutable commit SHAs', () => {
    expect(validateActionPins()).toEqual([]);
  });
});
