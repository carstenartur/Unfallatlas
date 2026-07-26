'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const screenshotsDir = path.join(ROOT, 'docs', 'screenshots');
const readinessDir = path.join(ROOT, 'out', 'qa', 'screenshot-readiness');

function removeMatchingFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !predicate(entry.name)) continue;
    fs.rmSync(path.join(directory, entry.name), { force: true });
  }
}

fs.mkdirSync(screenshotsDir, { recursive: true });
removeMatchingFiles(screenshotsDir, name => name.toLowerCase().endsWith('.png'));

fs.mkdirSync(readinessDir, { recursive: true });
removeMatchingFiles(readinessDir, name => name.toLowerCase().endsWith('.json'));

console.log('[extended-e2e] Prepared deterministic screenshot candidate directories.');
