/**
 * Integration test: POST /api/export-video against a real `unfallatlas`
 * container started via testcontainers.
 *
 * Why this exists
 * ---------------
 * `server/video-export.js` shells out to `ffmpeg` (palettegen → paletteuse
 * → GIF). The Dockerfile installs ffmpeg via apt, but the in-process unit
 * tests on `videoExport()` never actually invoke that binary. A change
 * that drops `ffmpeg` from the Dockerfile (or moves to a base image
 * without it) would silently regress production while every existing
 * test stays green.
 *
 * This test starts the production container, hits the route, and proves
 * the response is a real GIF — i.e. the full Express + Playwright +
 * ffmpeg pipeline ran end-to-end inside Docker.
 *
 * Skip semantics
 * --------------
 * If the local Docker daemon is unreachable (developer laptop without
 * Docker, sandboxed CI step), the whole describe-block is skipped via
 * `describe.skip` and the reason is logged once. The unit test suite
 * therefore stays green everywhere.
 *
 * Runtime
 * -------
 * - With `UNFALLATLAS_IMAGE` set (CI prefers this — it pulls the tag
 *   produced by `docker-publish.yml`): ~30-60 s (pull + boot + 1 export).
 * - Without: a few minutes on first run for `docker build`, then ~30 s
 *   on incremental rebuilds thanks to Docker layer cache.
 *
 * The test runs only under the dedicated Jest project
 * (`jest.testcontainers.config.js`), not under `npm test`.
 */

'use strict';

const fs = require('fs');
const {
  isDockerAvailable,
  startUnfallatlasContainer
} = require('./lib/startUnfallatlasContainer');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — Playwright recording + ffmpeg can take 60-120 s on a cold container

// Body that drives the new context UI — same payload the docs-asset
// regen script POSTs, so the test and the regen share one URL.
const CONTEXT_BODY = Object.freeze({
  city: 'Hannover',
  ctxSlope: 'steep,very_steep',
  ctxTraffic: 'high,very_high',
  ctxOnlyMatched: '1',
  zoom: '13'
});

/**
 * Synchronous Docker reachability heuristic so `describe.skip` can be
 * decided at file load (Jest cannot turn a describe into a skip from
 * inside `beforeAll`). We accept any of:
 *   - `DOCKER_HOST` env var set (remote daemon, rootless, podman socket),
 *   - `/var/run/docker.sock` exists (default Linux daemon, GitHub-hosted
 *     Ubuntu runners),
 *   - the user explicitly opted in via `RUN_TESTCONTAINERS=1`.
 * If none is true, the suite is skipped with a single console line so
 * developer laptops without Docker don't see a noisy failure.
 *
 * The async `isDockerAvailable()` probe still runs inside `beforeAll`
 * to surface daemon-misconfiguration errors loudly when the heuristic
 * said "should be available" but the daemon refuses the ping.
 */
function dockerLikelyAvailable() {
  if (process.env.RUN_TESTCONTAINERS === '1') return true;
  if (process.env.DOCKER_HOST) return true;
  try { return fs.existsSync('/var/run/docker.sock'); } catch (_) { return false; }
}

const SUITE_DESCRIBE = dockerLikelyAvailable() ? describe : describe.skip;
if (SUITE_DESCRIBE === describe.skip) {
  // eslint-disable-next-line no-console
  console.warn(
    '[videoExport.testcontainers] Skipping suite — no Docker socket and DOCKER_HOST unset. ' +
    'Set RUN_TESTCONTAINERS=1 to force.'
  );
}

async function postExportVideo(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/export-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CONTEXT_BODY),
      signal: controller.signal
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get('content-type') || '', body: buf };
  } finally {
    clearTimeout(timer);
  }
}

SUITE_DESCRIBE('POST /api/export-video — testcontainers integration', () => {
  let handle = null;

  beforeAll(async () => {
    const probe = await isDockerAvailable();
    if (!probe.available) {
      throw new Error(
        `Docker daemon present but unreachable: ${probe.reason}. ` +
        'Either start Docker or unset RUN_TESTCONTAINERS / DOCKER_HOST.'
      );
    }
    handle = await startUnfallatlasContainer();
  }, 10 * 60 * 1000); // up to 10 min for cold image build

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  it('returns a real GIF (ffmpeg pipeline ran inside the container)', async () => {
    const { status, contentType, body } = await postExportVideo(handle.baseUrl);

    expect(status).toBe(200);
    expect(contentType).toMatch(/^image\/gif/i);

    // GIF89a magic — proves it is a real GIF, not an HTML error page or
    // an empty `res.sendFile` stub.
    expect(body.length).toBeGreaterThan(6);
    expect(body.slice(0, 6).toString('ascii')).toBe('GIF89a');

    // GIF trailer — proves the file is complete (ffmpeg did not abort
    // mid-write).
    expect(body[body.length - 1]).toBe(0x3b);

    // Size budget — catches both "empty 1-byte file" and "runaway
    // recording" regressions.
    const MIN = 50 * 1024;        // 50 KB
    const MAX = 8 * 1024 * 1024;  // 8 MB
    expect(body.length).toBeGreaterThanOrEqual(MIN);
    expect(body.length).toBeLessThanOrEqual(MAX);

    // Container logs must not contain the server-side error marker —
    // guards against silent fallbacks where the route returns 200 from
    // a stale on-disk file while ffmpeg actually failed.
    const logs = await handle.getLogs();
    expect(logs).not.toMatch(/\[export-video\] Fehler/);
  }, 6 * 60 * 1000);
});
