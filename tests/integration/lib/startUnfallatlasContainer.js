/**
 * Shared helper to start an `unfallatlas` container via testcontainers.
 *
 * Used by:
 *   - `tests/integration/videoExport.testcontainers.test.js`
 *     (asserts POST /api/export-video returns valid animated files — i.e. ffmpeg
 *     from the Dockerfile actually ran).
 *   - `scripts/regen-context-assets.js`
 *     (regenerates `docs/demo-context.gif` + Kontext-PNGs from the
 *     same container, so test and regen share one source of truth).
 *
 * Image source priority:
 *   1. `process.env.UNFALLATLAS_IMAGE` (e.g. the tag produced by
 *      `.github/workflows/docker-publish.yml`,
 *      `ghcr.io/carstenartur/unfallatlas:latest`).
 *   2. Build the local Dockerfile via `GenericContainer.fromDockerfile`
 *      (cached by Docker layers — slow on cold cache, fast on rebuild).
 *
 * The helper waits for `/api/health` to return 200 (no sleeps) and
 * gives the Playwright browser fingerprint check up to 120 s on first
 * boot. Callers must invoke `.stop()` in a `finally` block.
 *
 * `isDockerAvailable()` performs a cheap reachability check so test
 * suites can `describe.skip` cleanly on machines without Docker
 * instead of crashing inside `start()`.
 *
 * @module tests/integration/lib/startUnfallatlasContainer
 */

'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_PORT = 8000;
const HEALTH_PATH = '/api/health';
const STARTUP_TIMEOUT_MS = 120_000;

let cachedTestcontainers = null;
function loadTestcontainers() {
  if (cachedTestcontainers) return cachedTestcontainers;
  // eslint-disable-next-line global-require
  cachedTestcontainers = require('testcontainers');
  return cachedTestcontainers;
}

/**
 * Cheap reachability check. Returns `{ available: true }` if the local
 * Docker daemon answers, otherwise `{ available: false, reason: <string> }`.
 * Never throws.
 *
 * @returns {Promise<{available: boolean, reason?: string}>}
 */
async function isDockerAvailable() {
  let tc;
  try {
    tc = loadTestcontainers();
  } catch (err) {
    return { available: false, reason: `testcontainers package not installed: ${err.message}` };
  }
  try {
    // getContainerRuntimeClient() resolves the daemon and pings it.
    // It is the same call testcontainers performs internally before
    // starting any container, so this gives us an honest signal.
    const client = await tc.getContainerRuntimeClient();
    if (!client) return { available: false, reason: 'no container runtime client' };
    return { available: true };
  } catch (err) {
    return { available: false, reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * Start an `unfallatlas` container. Returns a handle with the mapped
 * base URL plus `stop()` and `getLogs()`.
 *
 * @param {object} [opts]
 * @param {number} [opts.startupTimeoutMs] override startup timeout
 * @returns {Promise<{baseUrl: string, container: object, stop: () => Promise<void>, getLogs: () => Promise<string>}>}
 */
async function startUnfallatlasContainer(opts = {}) {
  const { GenericContainer, Wait } = loadTestcontainers();
  const startupTimeoutMs = opts.startupTimeoutMs || STARTUP_TIMEOUT_MS;

  const imageTag = process.env.UNFALLATLAS_IMAGE;
  let builder;
  if (imageTag) {
    builder = new GenericContainer(imageTag);
  } else {
    builder = await GenericContainer.fromDockerfile(REPO_ROOT).build(
      'unfallatlas:integration-test',
      { deleteOnExit: false }
    );
  }

  const container = await builder
    .withExposedPorts(SERVER_PORT)
    .withWaitStrategy(
      Wait.forHttp(HEALTH_PATH, SERVER_PORT).forStatusCode(200)
    )
    .withStartupTimeout(startupTimeoutMs)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(SERVER_PORT);
  const baseUrl = `http://${host}:${port}`;

  async function getLogs() {
    // testcontainers' `container.logs()` returns a stream that follows
    // the container indefinitely (the underlying `docker logs --follow`
    // never emits `end` while the container is up). We collect what's
    // available and resolve after a short period of inactivity so the
    // helper returns even though the container is still running.
    const stream = await container.logs();
    return new Promise((resolve) => {
      const chunks = [];
      let idle = null;
      const done = () => {
        try { stream.destroy(); } catch (_) { /* ignore */ }
        resolve(Buffer.concat(chunks).toString('utf8'));
      };
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(done, 1500);
      };
      stream.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); arm(); });
      stream.on('end', done);
      stream.on('error', done);
      arm();
    });
  }

  async function stop() {
    try { await container.stop({ timeout: 10 }); } catch (_) { /* best-effort */ }
  }

  return { baseUrl, container, stop, getLogs };
}

module.exports = {
  isDockerAvailable,
  startUnfallatlasContainer,
  SERVER_PORT,
  HEALTH_PATH,
  REPO_ROOT
};
