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
 * the response is a real animated export file (GIF/WebP/APNG) — i.e.
 * the full Express + Playwright + ffmpeg pipeline ran end-to-end inside
 * Docker.
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
const GIF_BUDGET_BYTES = 10 * 1024 * 1024;
const WEBP_BUDGET_BYTES = 6 * 1024 * 1024;
const APNG_BUDGET_BYTES = 11 * 1024 * 1024;

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

async function postExportVideo(baseUrl, opts = {}) {
  const { bodyFormat, queryFormat } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const body = {
    ...CONTEXT_BODY
  };
  if (bodyFormat !== undefined) body.format = bodyFormat;
  const url = new URL(`${baseUrl}/api/export-video`);
  if (queryFormat !== undefined) url.searchParams.set('format', queryFormat);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

  test.each([
    { request: {}, label: 'default', expectedContentType: /^image\/gif/i, expectedExt: 'gif', budget: GIF_BUDGET_BYTES },
    { request: { bodyFormat: 'gif' }, label: 'body:gif', expectedContentType: /^image\/gif/i, expectedExt: 'gif', budget: GIF_BUDGET_BYTES },
    { request: { bodyFormat: 'webp' }, label: 'body:webp', expectedContentType: /^image\/webp/i, expectedExt: 'webp', budget: WEBP_BUDGET_BYTES },
    { request: { bodyFormat: 'apng' }, label: 'body:apng', expectedContentType: /^image\/apng/i, expectedExt: 'apng', budget: APNG_BUDGET_BYTES },
    { request: { queryFormat: 'webp' }, label: 'query:webp', expectedContentType: /^image\/webp/i, expectedExt: 'webp', budget: WEBP_BUDGET_BYTES }
  ])('returns valid $expectedExt export ($label)', async ({ request, expectedContentType, expectedExt, budget }) => {
    const { status, contentType, body } = await postExportVideo(handle.baseUrl, request);

    expect(status).toBe(200);
    expect(contentType).toMatch(expectedContentType);

    const MIN = 50 * 1024; // 50 KB
    expect(body.length).toBeGreaterThanOrEqual(MIN);
    expect(body.length).toBeLessThanOrEqual(budget);

    if (expectedExt === 'gif') {
      const header = body.slice(0, 6).toString('ascii');
      expect(['GIF87a', 'GIF89a']).toContain(header);
      expect(body[body.length - 1]).toBe(0x3b);
    } else if (expectedExt === 'webp') {
      expect(body.slice(0, 4).toString('ascii')).toBe('RIFF');
      expect(body.slice(8, 12).toString('ascii')).toBe('WEBP');
      expect(body.includes(Buffer.from('VP8X', 'ascii'))).toBe(true);
      expect(body.includes(Buffer.from('ANIM', 'ascii'))).toBe(true);
    } else if (expectedExt === 'apng') {
      const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(body.subarray(0, 8).equals(pngSig)).toBe(true);
      expect(body.includes(Buffer.from('acTL', 'ascii'))).toBe(true);
    }
  }, 6 * 60 * 1000);

  it('rejects unsupported export format', async () => {
    const { status, body } = await postExportVideo(handle.baseUrl, { bodyFormat: 'mp4' });
    const json = JSON.parse(body.toString('utf8'));
    expect(status).toBe(400);
    expect(json).toEqual(expect.objectContaining({
      error: 'unsupported_format'
    }));
    expect(json.supportedFormats).toEqual(['gif', 'webp', 'apng']);
  }, 60 * 1000);

  it('container logs stay free of export-video error marker', async () => {
    const logs = await handle.getLogs();
    expect(logs).not.toMatch(/\[export-video\] Fehler/);
  });
});
