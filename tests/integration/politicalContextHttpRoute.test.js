/** @jest-environment node */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('production political-context HTTP route', () => {
  let child;
  let baseUrl;
  let stdout = '';
  let stderr = '';

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        ANALYSIS_SERVICE_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    const deadline = Date.now() + 25_000;
    let lastError = null;
    while (Date.now() < deadline) {
      if (child.exitCode != null) {
        throw new Error(
          `Unfallwerkbank server exited before readiness (code=${child.exitCode}).\n`
            + `stdout:\n${stdout}\nstderr:\n${stderr}`
        );
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
        lastError = new Error(`Health endpoint returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(
      `Unfallwerkbank server did not become ready: ${lastError && lastError.message}\n`
        + `stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }, 30_000);

  afterAll(async () => {
    if (!child || child.exitCode != null) return;
    child.kill('SIGTERM');
    const exited = new Promise(resolve => child.once('exit', resolve));
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode == null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(2_000)]);
    }
  });

  test('accepts the real POST route instead of returning 404/405', async () => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city: 'Musterstadt',
        searchTerms: ['Radverkehr'],
        maxResults: 1,
      }),
    });

    expect(response.status).not.toBe(404);
    expect(response.status).not.toBe(405);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/i);

    const body = await response.json();
    expect(body).toMatchObject({
      references: [],
      meta: {
        city: 'Musterstadt',
        supported: false,
      },
    });
  });

  test('validates POST payloads through the production handler', async () => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'CITY_REQUIRED',
      category: 'invalid_request',
    });
  });
});
