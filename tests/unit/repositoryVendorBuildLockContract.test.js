'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyVendorAssets } = require('../../scripts/build-site');
const { createBuildLock } = require('../../scripts/vendor-build-lock');

const repoRoot = path.resolve(__dirname, '../..');

test('the checked-in recipe attests the installed browser export assets', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-repository-vendor-lock-'));
  try {
    copyVendorAssets(repoRoot, outputRoot);
    const lock = createBuildLock({ repoRoot, outputRoot });
    expect(lock.operations).toHaveLength(3);
    for (const operation of lock.operations) {
      expect(operation.output.sha256).toBe(operation.input.sha256);
    }
    const pkg = require('../../package.json');
    expect(lock.recipe.packageManager).toBe(pkg.packageManager);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
