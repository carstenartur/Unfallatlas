'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
  DEFAULT_CANDIDATE_DIRECTORY,
  listGeneratedMedia,
  withCandidateScreenshotWorkspace,
} = require('./candidate-screenshot-workspace');

const ROOT = path.resolve(__dirname, '..');
const VALIDATORS = new Map([
  ['validate-screenshot-evidence.js', { mountAtCanonicalPath: true }],
  ['validate-doc-media.js', { mountAtCanonicalPath: true }],
]);

function assertGeneratedMedia(directory) {
  const generated = listGeneratedMedia(directory);
  if (generated.length === 0) {
    throw new Error(`Candidate screenshot directory is empty: ${directory}`);
  }
}

function runValidator(name, args) {
  const script = path.join(__dirname, name);
  const child = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const error = new Error(`${name} exited with status ${child.status ?? 1}`);
    error.exitCode = child.status ?? 1;
    throw error;
  }
}

try {
  const [validatorName, ...validatorArgs] = process.argv.slice(2);
  const validator = VALIDATORS.get(validatorName);
  if (!validator) {
    throw new Error(`Unsupported candidate screenshot validator: ${validatorName || '<missing>'}`);
  }

  if (validator.mountAtCanonicalPath) {
    withCandidateScreenshotWorkspace(({ canonicalDirectory }) => {
      assertGeneratedMedia(canonicalDirectory);
      runValidator(validatorName, validatorArgs);
    }, { prepareCandidate: false });
  } else {
    assertGeneratedMedia(DEFAULT_CANDIDATE_DIRECTORY);
    runValidator(validatorName, validatorArgs);
  }
} catch (error) {
  if (Number.isInteger(error.exitCode)) process.exitCode = error.exitCode;
  else throw error;
}
