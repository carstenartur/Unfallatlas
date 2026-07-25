'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LIVE_ORIGIN,
  LIVE_PATH,
  validateDocumentationLinks,
} = require('./documentation-deeplink-contract.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'documentation-live-links');
const SOURCE = path.join(ROOT, 'tests', 'e2e', 'documentation-deeplinks.live.spec.js');
const GENERATED = path.join(ROOT, 'tests', 'e2e', 'documentation-deeplinks.live.spec.generated.js');
const LIVE_BASE_URL = new URL('.', `${LIVE_ORIGIN}${LIVE_PATH}`).href.replace(/\/$/, '');
const CANDIDATE_BASE_URL = 'http://localhost:8000';

function writeJson(filename, value) {
  fs.writeFileSync(path.join(OUTPUT, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function resolveAuditTarget(options = {}) {
  const published = options.published !== undefined
    ? Boolean(options.published)
    : process.env.DOCUMENTATION_AUDIT_PUBLISHED === '1';
  if (published) return Object.freeze({ mode: 'published', baseUrl: LIVE_BASE_URL });
  const baseUrl = options.applicationBaseUrl ||
    process.env.DOCUMENTATION_APP_BASE_URL || CANDIDATE_BASE_URL;
  return Object.freeze({ mode: 'candidate', baseUrl });
}

function buildAuditSpec(source) {
  const startAnchor = "  expect(diagnostics.state.export.publicPreview).toBe('public-preview-core-v1');";
  const loopAnchor = '\n  for (const contract of publicDownloadContracts) {';
  const start = source.indexOf(startAnchor);
  if (start < 0 || source.indexOf(startAnchor, start + startAnchor.length) >= 0) {
    throw new Error('[documentation-links] Expected exactly one public-profile assertion block');
  }
  const end = source.indexOf(loopAnchor, start);
  if (end < 0) throw new Error('[documentation-links] Cannot locate data-download contract loop');
  const removed = source.slice(start, end);
  for (const expected of ['noticeVisible', 'antragGroupHidden', 'wordDisabled', 'pdfDisabled']) {
    if (!removed.includes(expected)) {
      throw new Error(`[documentation-links] Incomplete public-profile assertion block: ${expected}`);
    }
  }
  return source.slice(0, start) + startAnchor + '\n' + source.slice(end);
}

function run(options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const target = resolveAuditTarget(options);
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT, { recursive: true });

  let contract;
  try {
    contract = validateDocumentationLinks(ROOT);
    writeJson('resolved-contract.json', {
      liveBaseUrl: LIVE_BASE_URL,
      auditMode: target.mode,
      targetBaseUrl: target.baseUrl,
      scenarios: contract.liveScenarios.map((scenario) => ({
        id: scenario.id,
        imagePath: scenario.imagePath,
        description: scenario.description,
        url: scenario.url,
        canonicalUrl: scenario.canonicalUrl || scenario.url,
        expected: scenario.expected,
        references: scenario.references,
      })),
    });
  } catch (error) {
    writeJson('contract-error.json', {
      name: error?.name || 'Error',
      code: error?.code || null,
      message: error?.message || String(error),
      stack: error?.stack || null,
      details: error?.details || null,
    });
    throw error;
  }

  const transformed = buildAuditSpec(fs.readFileSync(SOURCE, 'utf8'));
  fs.rmSync(GENERATED, { force: true });
  fs.writeFileSync(GENERATED, transformed, { flag: 'wx' });

  const packageEntry = require.resolve('@playwright/test');
  const cli = path.join(path.dirname(packageEntry), 'cli.js');
  const generatedRelative = path.relative(ROOT, GENERATED).replace(/\\/g, '/');
  const args = [cli, 'test', generatedRelative, '--project=documentation-deeplinks-live'];
  const childEnv = { ...process.env };
  if (target.mode === 'published') {
    childEnv.BASE_URL = target.baseUrl;
    delete childEnv.DOCUMENTATION_APP_BASE_URL;
  } else {
    delete childEnv.BASE_URL;
    childEnv.DOCUMENTATION_APP_BASE_URL = target.baseUrl;
  }

  let result;
  try {
    result = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: childEnv,
    });
  } finally {
    fs.rmSync(GENERATED, { force: true });
  }

  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  fs.writeFileSync(path.join(OUTPUT, 'command.log'), [
    `$ ${process.execPath} ${args.join(' ')}`,
    '',
    `auditMode=${target.mode}`,
    `targetBaseUrl=${target.baseUrl}`,
    '',
    '--- stdout ---', stdout,
    '--- stderr ---', stderr,
    '',
    `signal=${result.signal || ''}`,
    `status=${result.status == null ? '' : result.status}`,
  ].join('\n'));

  if (result.error) {
    writeJson('spawn-error.json', {
      name: result.error.name || 'Error',
      message: result.error.message || String(result.error),
      stack: result.error.stack || null,
    });
    throw result.error;
  }
  const status = result.status == null ? 1 : result.status;
  writeJson('command-result.json', {
    status,
    signal: result.signal || null,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  });
  if (status !== 0) process.exitCode = status;
  return status;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ROOT, OUTPUT, SOURCE, GENERATED, LIVE_BASE_URL, CANDIDATE_BASE_URL,
  resolveAuditTarget, buildAuditSpec, run,
});
