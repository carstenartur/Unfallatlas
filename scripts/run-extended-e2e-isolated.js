'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
  listGeneratedMedia,
  withCandidateScreenshotWorkspace,
} = require('./candidate-screenshot-workspace');

const ROOT = path.resolve(__dirname, '..');
const runner = path.join(__dirname, 'run-extended-e2e.js');

try {
  withCandidateScreenshotWorkspace(({ canonicalDirectory, candidateDirectory }) => {
    const child = spawnSync(process.execPath, [runner], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      const error = new Error(`Extended browser QA exited with status ${child.status ?? 1}`);
      error.exitCode = child.status ?? 1;
      throw error;
    }
    const generated = listGeneratedMedia(canonicalDirectory);
    if (generated.length === 0) {
      throw new Error('Extended browser QA produced no candidate documentation screenshots');
    }
    process.stdout.write(
      `[candidate-screenshots] generated ${generated.length} isolated media file(s) in ${candidateDirectory}\n`
    );
  });
} catch (error) {
  if (Number.isInteger(error.exitCode)) process.exitCode = error.exitCode;
  else throw error;
}
