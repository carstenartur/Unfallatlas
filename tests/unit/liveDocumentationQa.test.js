/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '../../scripts/run-live-documentation-qa.js');
const DIAGNOSTIC = 'out/qa/published-runtime-diagnostic/diagnostic.json';
const LINKS = 'out/qa/documentation-live-links/command-result.json';

// Exercise the actual orchestrator and filesystem. Only external browser/check
// processes are replaced by bounded child scripts with controlled output.
function runCandidate({ diagnostic = '{"healthy":true}', links = '{"status":0}',
  staleDiagnostic, staleLinks, diagnosticExit = 0, requested = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-documentation-qa-'));
  const write = (file, content) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const producer = (file, content, exit) => `
    const fs = require('fs'); const path = require('path');
    const file = ${JSON.stringify(file)};
    const content = ${JSON.stringify(content)};
    if (content !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    process.exitCode = ${exit};
  `;
  try {
    write('scripts/run-live-documentation-qa.js', fs.readFileSync(RUNNER));
    write('node_modules/@playwright/test/cli.js', '');
    write('scripts/diagnose-published-werkbank.cjs', producer(DIAGNOSTIC, diagnostic, diagnosticExit));
    write('scripts/run-live-documentation-links.cjs', producer(LINKS, links, 0));
    for (const script of ['run-live-documentation-screenshots.cjs',
      'validate-screenshot-evidence.js', 'validate-live-cartography-evidence.cjs',
      'validate-doc-media.js']) write(`scripts/${script}`, '');
    if (staleDiagnostic !== undefined) write(DIAGNOSTIC, staleDiagnostic);
    if (staleLinks !== undefined) write(LINKS, staleLinks);
    const result = spawnSync(process.execPath, ['scripts/run-live-documentation-qa.js'], {
      cwd: root,
      env: { ...process.env, PUBLISHED_RUNTIME_DIAGNOSTIC: requested ? '1' : '0',
        DOCUMENTATION_LIVE_LINKS: requested ? 'true' : 'false' },
      encoding: 'utf8', timeout: 15000,
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('live documentation requires evidence from this invocation', () => {
  test.each([
    ['missing', null],
    ['malformed', '{'],
    ['unhealthy', '{"healthy":false}'],
    ['absent health result', '{}'],
    ['truthy nonboolean health result', '{"healthy":"true"}'],
  ])('rejects a %s requested runtime diagnostic despite successful children', (_label, diagnostic) => {
    const result = runCandidate({ diagnostic });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('[documentation-live] PASS');
  });

  test('does not accept an old healthy runtime diagnostic when the child produces none', () => {
    expect(runCandidate({ diagnostic: null, staleDiagnostic: '{"healthy":true}' }).status).not.toBe(0);
  });

  test.each([
    ['missing', null], ['malformed', '{'], ['failed', '{"status":1}'],
    ['absent status', '{}'], ['string status', '{"status":"0"}'],
  ])('rejects a %s requested live-link report despite successful children', (_label, links) => {
    const result = runCandidate({ links });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('[documentation-live] PASS');
  });

  test('does not accept an old successful link report when the child produces none', () => {
    expect(runCandidate({ links: null, staleLinks: '{"status":0}' }).status).not.toBe(0);
  });

  test('accepts fresh healthy runtime and successful link evidence', () => {
    const result = runCandidate();
    expect(result.status).toBe(0);
    expect(result.output).toContain('[documentation-live] PASS');
  });

  test('retains the actual diagnostic process failure even with a healthy report', () => {
    expect(runCandidate({ diagnosticExit: 7 }).status).not.toBe(0);
  });

  test('does not require optional reports when their checks were not requested', () => {
    expect(runCandidate({ requested: false, diagnostic: null, links: null }).status).toBe(0);
  });
});
