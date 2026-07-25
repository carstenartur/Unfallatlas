'use strict';

const fs = require('fs');
const path = require('path');
const contract = require('../../scripts/documentation-deeplink-contract.cjs');
const runner = require('../../scripts/run-live-documentation-links.cjs');

function withCleanExitCode(callback) {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    return callback();
  } finally {
    process.exitCode = previous;
  }
}

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: 'five scenarios passed\n', stderr: '' };
  };
}

function readResolvedContract() {
  return JSON.parse(fs.readFileSync(
    path.join(runner.OUTPUT, 'resolved-contract.json'),
    'utf8',
  ));
}

describe('documentation deep-link runner', () => {
  test('audits the exact local candidate artifact by default', () => {
    const calls = [];
    const status = runner.run({
      published: false,
      applicationBaseUrl: runner.CANDIDATE_BASE_URL,
      spawnSync: successfulSpawn(calls),
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual(expect.arrayContaining([
      'test',
      'tests/e2e/documentation-deeplinks.live.spec.generated.js',
      '--project=documentation-deeplinks-live',
    ]));
    expect(calls[0].options.env.BASE_URL).toBeUndefined();
    expect(calls[0].options.env.DOCUMENTATION_APP_BASE_URL).toBe(runner.CANDIDATE_BASE_URL);
    expect(calls[0].options.env.PLAYWRIGHT_SERVE_EXISTING_SITE).toBe('1');
    expect(calls[0].options.cwd).toBe(runner.ROOT);
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(fs.existsSync(runner.GENERATED)).toBe(false);

    const resolved = readResolvedContract();
    expect(resolved.liveBaseUrl).toBe(runner.LIVE_BASE_URL);
    expect(resolved.auditMode).toBe('candidate');
    expect(resolved.targetBaseUrl).toBe(runner.CANDIDATE_BASE_URL);
    expect(resolved.scenarios).toHaveLength(Object.keys(contract.SCENARIOS).length);
    expect(fs.readFileSync(path.join(runner.OUTPUT, 'command.log'), 'utf8'))
      .toContain('five scenarios passed');
    expect(JSON.parse(fs.readFileSync(path.join(runner.OUTPUT, 'command-result.json'), 'utf8')))
      .toMatchObject({ status: 0, signal: null });
  });

  test('generated audit keeps data downloads while adapting candidate-only capabilities', () => {
    const source = fs.readFileSync(runner.SOURCE, 'utf8');
    const transformed = runner.buildAuditSpec(source);
    expect(transformed).toContain('for (const contract of publicDownloadContracts)');
    expect(transformed).not.toContain('expect(diagnostics.state.export.publicPreview)');
    expect(transformed).not.toContain('expect(diagnostics.state.export.noticeVisible)');
    expect(transformed).not.toContain('expect(diagnostics.state.export.wordDisabled)');
    expect(transformed).not.toContain('expect(diagnostics.state.export.pdfDisabled)');
    expect(transformed).toContain('ctx.visibleViewportPts?.length ?? ctx.viewportPts?.length');
    expect(transformed).toContain("pathname.endsWith('/api/video-export-available')");
  });

  test('retains an explicit audit mode for the published application', () => {
    const calls = [];
    expect(runner.run({ published: true, spawnSync: successfulSpawn(calls) })).toBe(0);

    const expectedBase = new URL('.', `${contract.LIVE_ORIGIN}${contract.LIVE_PATH}`)
      .href.replace(/\/$/, '');
    expect(runner.LIVE_BASE_URL).toBe(expectedBase);
    expect(calls[0].options.env.BASE_URL).toBe(expectedBase);
    expect(calls[0].options.env.DOCUMENTATION_APP_BASE_URL).toBeUndefined();
    expect(calls[0].options.env.PLAYWRIGHT_SERVE_EXISTING_SITE).toBeUndefined();
    expect(readResolvedContract()).toMatchObject({
      liveBaseUrl: expectedBase,
      auditMode: 'published',
      targetBaseUrl: expectedBase,
    });
  });

  test('propagates a non-zero Playwright result and records it', () => {
    withCleanExitCode(() => {
      expect(runner.run({
        published: false,
        spawnSync: () => ({ status: 7, stdout: '', stderr: 'failed\n' }),
      })).toBe(7);
      expect(process.exitCode).toBe(7);
      expect(JSON.parse(fs.readFileSync(path.join(runner.OUTPUT, 'command-result.json'), 'utf8')))
        .toMatchObject({ status: 7 });
    });
  });

  test('maps a signal-terminated child with null status to deterministic failure code 1', () => {
    withCleanExitCode(() => {
      expect(runner.run({
        published: false,
        spawnSync: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
      })).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(fs.readFileSync(path.join(runner.OUTPUT, 'command-result.json'), 'utf8')))
        .toMatchObject({ status: 1, signal: 'SIGTERM' });
    });
  });
});
