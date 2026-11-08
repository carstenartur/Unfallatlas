/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gatePath = path.resolve(__dirname, '../../scripts/run-pages-quality-gate.cjs');

// Execute the actual private lifecycle functions in an isolated Node process.
// Only server startup/readiness IO is substituted: termination uses real OS
// child processes, real signals and the real event loop (including natural exit).
const harness = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const cp = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const [gatePath, logPath, mode] = process.argv.slice(1);
const originalRequire = createRequire(gatePath);
let server, log, logIdentity;
let logCloseVerified = false, logDescriptorReused = false;
const localRequire = name => {
  if (name === 'node:child_process') return { ...cp, spawn() {
    server = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    return server;
  } };
  if (name === 'node:http') return { get(_url, ready) {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => request;
    process.nextTick(() => ready({ statusCode: 200, resume() {} }));
    return request;
  } };
  if (name === 'node:fs') return { ...fs, mkdirSync() {}, openSync() {
    log = fs.openSync(logPath, 'w');
    logIdentity = fs.fstatSync(log);
    return log;
  }, closeSync(fd) {
    const identity = fs.fstatSync(fd);
    const isLog = fd === log && identity.dev === logIdentity.dev && identity.ino === logIdentity.ino;
    fs.closeSync(fd);
    if (isLog) logCloseVerified = true;
    if (isLog && mode.endsWith('-reuse')) {
      // Deterministically model an unrelated native operation reusing the freed
      // descriptor before a lazy stdout/stderr continuation observes it.
      const replacement = fs.openSync(logPath + '.replacement', 'w');
      const other = fs.fstatSync(replacement);
      logDescriptorReused = replacement === fd
        && (identity.dev !== other.dev || identity.ino !== other.ino);
    }
  } };
  return originalRequire(name);
};
const moduleObject = { exports: {} };
vm.runInNewContext(fs.readFileSync(gatePath, 'utf8') + '\nmodule.exports = { stopChild, withSiteServer };', {
  require: localRequire, module: moduleObject, __dirname: path.dirname(gatePath),
  process, setTimeout, clearTimeout,
}, { filename: gatePath });
const { stopChild, withSiteServer } = moduleObject.exports;
process.on('exit', () => {
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
});
function logClosed() {
  // Descriptor numbers are reusable; stdout/stderr initialization may already
  // have assigned this number to another resource by the time we report.
  // This proof is set only after native close succeeds on the original inode.
  return logCloseVerified;
}
async function main() {
  if (mode === 'already-exited' || mode === 'stubborn') {
    server = cp.spawn(process.execPath, ['-e', mode === 'stubborn'
      ? "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
      : "process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await once(server, 'message');
    if (mode === 'already-exited') {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    await stopChild(server);
    process.stdout.write(JSON.stringify({ completed: true, signal: server.signalCode }) + '\n');
    return;
  }
  await withSiteServer(async () => {
    if (mode.startsWith('failure')) throw new Error('browser gate failure must propagate');
  });
  process.stdout.write(JSON.stringify({ completed: true, logClosed: logClosed(), ...(mode.endsWith('-reuse') ? { logDescriptorReused } : {}), signal: server.signalCode }) + '\n');
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message, logClosed: logClosed(), ...(mode.endsWith('-reuse') ? { logDescriptorReused } : {}), signal: server?.signalCode }) + '\n');
  process.exitCode = 1;
});
`;

function runLifecycle(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-gate-lifecycle-'));
  try {
    return spawnSync(process.execPath, ['-e', harness, gatePath, path.join(directory, 'server.log'), mode], {
      encoding: 'utf8', timeout: 8000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Break caught: a SIGTERM exit has exitCode=null, and an unresolved second exit
// wait lets Node terminate successfully before the gate's rejection handler runs.
test('a failed gate exits nonzero after signal-based server cleanup and closes its log', () => {
  const result = runLifecycle('failure');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({
    error: 'browser gate failure must propagate', logClosed: true, signal: 'SIGTERM',
  });
}, 15000);

test('successful server cleanup reaches the continuation instead of silently abandoning it', () => {
  const result = runLifecycle('success');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).not.toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ completed: true, logClosed: true, signal: 'SIGTERM' });
}, 15000);

test('cleanup recognizes a server that already exited by signal', () => {
  const result = runLifecycle('already-exited');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).not.toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ completed: true, signal: 'SIGTERM' });
}, 15000);

test('cleanup still escalates when the server ignores SIGTERM', () => {
  const result = runLifecycle('stubborn');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).not.toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ completed: true, signal: 'SIGKILL' });
}, 15000);

// Break caught: a late fstat on a recycled numeric descriptor mistakes a new
// file for the log that the gate already closed successfully.
test.each(['failure', 'success'])('log closure proof survives descriptor reuse after %s', outcome => {
  const result = runLifecycle(`${outcome}-reuse`);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(outcome === 'failure' ? 1 : 0);
  const report = JSON.parse(outcome === 'failure' ? result.stderr : result.stdout);
  expect(report).toMatchObject({ logClosed: true, logDescriptorReused: true, signal: 'SIGTERM' });
}, 15000);
