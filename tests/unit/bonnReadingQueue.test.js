/** @jest-environment node */
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Bonn reading producer verifies local catalogues, file ownership, versions and request budgets', () => {
  const fixture = path.resolve(__dirname, '../fixtures/bonn-reading/check.py');
  execFileSync('python3', ['-B', fixture], { encoding: 'utf8', timeout: 15000 });
});
