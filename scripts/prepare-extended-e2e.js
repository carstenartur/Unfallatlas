'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function removeMatchingFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !predicate(entry.name)) continue;
    fs.rmSync(path.join(directory, entry.name), { force: true });
  }
}

function prepareExtendedE2E(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const readinessDirectory = path.join(root, 'out', 'qa', 'screenshot-readiness');

  // Generated screenshots are isolated later by run-extended-e2e-isolated.js.
  // Never delete the reviewed files in docs/screenshots here: doing so before
  // withCandidateScreenshotWorkspace() snapshots the canonical directory turns
  // the empty directory into the state that is faithfully restored afterwards.
  fs.mkdirSync(readinessDirectory, { recursive: true });
  removeMatchingFiles(
    readinessDirectory,
    name => name.toLowerCase().endsWith('.json')
  );

  if (options.log !== false) {
    console.log(
      '[extended-e2e] Prepared transient screenshot readiness evidence; ' +
      'canonical documentation media remain untouched.'
    );
  }
  return { readinessDirectory };
}

if (require.main === module) prepareExtendedE2E();

module.exports = {
  prepareExtendedE2E,
  removeMatchingFiles,
};
