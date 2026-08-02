'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INCLUDE_LIVE_LINKS = /^(?:1|true|yes)$/i.test(
  String(process.env.DOCUMENTATION_LIVE_LINKS || 'false')
);
const INCLUDE_PUBLISHED_RUNTIME_DIAGNOSTIC = /^(?:1|true|yes)$/i.test(
  String(process.env.PUBLISHED_RUNTIME_DIAGNOSTIC || 'false')
);

function runNode(relativeScript, args = [], options = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, relativeScript), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${relativeScript} exited with status ${result.status}`);
}

function cleanCandidates() {
  const screenshotDirectory = path.join(ROOT, 'docs', 'screenshots');
  const readinessDirectory = path.join(ROOT, 'out', 'qa', 'screenshot-readiness');
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  fs.mkdirSync(readinessDirectory, { recursive: true });
  for (const entry of fs.readdirSync(screenshotDirectory)) {
    if (entry.toLowerCase().endsWith('.png')) {
      fs.rmSync(path.join(screenshotDirectory, entry), { force: true });
    }
  }
  for (const entry of fs.readdirSync(readinessDirectory)) {
    if (entry.toLowerCase().endsWith('.json')) {
      fs.rmSync(path.join(readinessDirectory, entry), { force: true });
    }
  }
  fs.rmSync(path.join(ROOT, 'out', 'qa', 'documentation-live-links'), {
    recursive: true,
    force: true,
  });
}

function installChromium() {
  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`Locked Playwright CLI is missing: ${cli}`);
  const result = spawnSync(process.execPath, [cli, 'install', '--with-deps', 'chromium'], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Playwright Chromium installation exited with status ${result.status}`);
}

cleanCandidates();
installChromium();

if (INCLUDE_PUBLISHED_RUNTIME_DIAGNOSTIC) {
  runNode('scripts/diagnose-published-werkbank.cjs');
}

const logPath = path.join(ROOT, 'out', 'qa', 'live-documentation-screenshots.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const screenshots = spawnSync(
  process.execPath,
  [path.join(ROOT, 'scripts', 'run-live-documentation-screenshots.cjs')],
  { cwd: ROOT, env: process.env, encoding: 'utf8' }
);
const screenshotOutput = `${screenshots.stdout || ''}${screenshots.stderr || ''}`;
fs.writeFileSync(logPath, screenshotOutput);
process.stdout.write(screenshotOutput);
if (screenshots.error) throw screenshots.error;
if (screenshots.status !== 0) {
  throw new Error(`Live documentation screenshots exited with status ${screenshots.status}`);
}

if (INCLUDE_LIVE_LINKS) runNode('scripts/run-live-documentation-links.cjs');
runNode('scripts/validate-screenshot-evidence.js', [
  '--report', 'out/qa/screenshot-evidence.json',
]);
runNode('scripts/validate-live-cartography-evidence.cjs', [
  '--report', 'out/qa/live-cartography-evidence.json',
]);
runNode('scripts/validate-doc-media.js', [
  '--candidate-screenshots',
  '--report', 'out/qa/documentation-media.json',
]);

console.log(
  `[documentation-live] PASS (live links: ${INCLUDE_LIVE_LINKS}; ` +
  `published runtime diagnostic: ${INCLUDE_PUBLISHED_RUNTIME_DIAGNOSTIC})`
);
