'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
  listGeneratedMedia,
  withCandidateScreenshotWorkspace,
} = require('./candidate-screenshot-workspace');

const ROOT = path.resolve(__dirname, '..');
const commands = [
  [
    path.join(__dirname, 'validate-screenshot-evidence.js'),
    ['--report', 'out/qa/screenshot-evidence.json'],
  ],
  [
    path.join(__dirname, 'validate-doc-media.js'),
    ['--candidate-screenshots', '--report', 'out/qa/documentation-media.json'],
  ],
];

try {
  withCandidateScreenshotWorkspace(({ candidateDirectory }) => {
    const generated = listGeneratedMedia(candidateDirectory);
    if (generated.length === 0) {
      throw new Error(`Candidate screenshot directory is empty: ${candidateDirectory}`);
    }

    for (const [script, args] of commands) {
      const child = spawnSync(process.execPath, [script, ...args], {
        cwd: ROOT,
        env: process.env,
        stdio: 'inherit',
      });
      if (child.error) throw child.error;
      if (child.status !== 0) {
        const error = new Error(`${path.basename(script)} exited with status ${child.status ?? 1}`);
        error.exitCode = child.status ?? 1;
        throw error;
      }
    }
  }, { prepareCandidate: false });
} catch (error) {
  if (Number.isInteger(error.exitCode)) process.exitCode = error.exitCode;
  else throw error;
}
