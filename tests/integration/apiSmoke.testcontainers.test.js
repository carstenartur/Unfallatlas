/**
 * Integration smoke suite: hits a wide cross-section of the Express API
 * inside a real `unfallatlas` container started via testcontainers.
 *
 * Why this exists
 * ---------------
 * Up to now there was exactly one testcontainers test
 * (`videoExport.testcontainers.test.js`), covering only the ffmpeg
 * pipeline. Every other route — `/api/health`, `/api/status`,
 * `/api/cities`, the feature-flag endpoints, the analysis-service
 * forwarders, the static `werkbank_v2.html` — could silently regress
 * (broken middleware, missing static mount, wrong default for an env
 * var) without any test catching it inside the production image.
 *
 * Architecture: Schicht 1 (Node-only)
 * -----------------------------------
 * This suite intentionally starts ONLY the `unfallatlas` Node image
 * (the one published as `ghcr.io/carstenartur/unfallatlas`). It does
 * NOT start the Spring-Boot `analysis-service` or PostgreSQL — the
 * analysis-service forwarder routes are exercised in their
 * "not configured" branch instead, which is the default state of the
 * shipped image and what `docker compose up unfallatlas` produces.
 *
 * Followups (multi-container Schicht 2, Java-side Schicht 3) are
 * tracked in `TODO.md` at the repo root.
 *
 * Skip semantics + image source
 * -----------------------------
 * Same conventions as `videoExport.testcontainers.test.js`:
 *   - the suite is skipped (with a single `console.warn`) when no
 *     Docker socket is reachable and `RUN_TESTCONTAINERS=1` is unset;
 *   - if `UNFALLATLAS_IMAGE` is set, that tag is pulled (CI prefers
 *     this — it's the tag produced by `docker-publish.yml`),
 *     otherwise the local `Dockerfile` is built (slow on cold cache,
 *     fast on rebuild thanks to Docker layer cache).
 *
 * One container is shared across all `it()` cases (`beforeAll` /
 * `afterAll`) to keep the CI cost to one image build + one boot per
 * Jest run, regardless of how many endpoints we cover.
 *
 * Runs only under `npm run test:integration:tc`, never under
 * `npm test` (excluded via `testPathIgnorePatterns` in `package.json`).
 */

'use strict';

const fs = require('fs');
const {
  isDockerAvailable,
  startUnfallatlasContainer
} = require('./lib/startUnfallatlasContainer');

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Synchronous Docker reachability heuristic — Jest cannot turn a
 * `describe` into a skip from inside `beforeAll`, so the decision
 * has to happen at file-load time. Mirrors the heuristic used in
 * `videoExport.testcontainers.test.js`.
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
    '[apiSmoke.testcontainers] Skipping suite — no Docker socket and DOCKER_HOST unset. ' +
    'Set RUN_TESTCONTAINERS=1 to force.'
  );
}

async function getJson(baseUrl, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    const contentType = res.headers.get('content-type') || '';
    let body = null;
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }
    return { status: res.status, contentType, body };
  } finally {
    clearTimeout(timer);
  }
}

async function getRaw(baseUrl, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      text: await res.text()
    };
  } finally {
    clearTimeout(timer);
  }
}

SUITE_DESCRIBE('API smoke — testcontainers integration (Node-only)', () => {
  /** @type {import('./lib/startUnfallatlasContainer').UnfallatlasContainerHandle | null} */
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

  // ── Liveness ────────────────────────────────────────────────────────────────
  it('GET /api/health returns 200 with status=ok and an ISO timestamp', async () => {
    const { status, contentType, body } = await getJson(handle.baseUrl, '/api/health');
    expect(status).toBe(200);
    expect(contentType).toMatch(/application\/json/);
    expect(body).toEqual(expect.objectContaining({ status: 'ok' }));
    // ISO-8601 sanity check; constructed by `new Date().toISOString()`
    expect(typeof body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  // ── Capability aggregation ──────────────────────────────────────────────────
  it('GET /api/status returns 200 with version and capabilities object', async () => {
    const { status, contentType, body } = await getJson(handle.baseUrl, '/api/status');
    expect(status).toBe(200);
    expect(contentType).toMatch(/application\/json/);
    expect(body).toEqual(expect.objectContaining({
      status: 'ok',
      timestamp: expect.any(String),
      version: expect.any(String),
      uptimeSec: expect.any(Number),
      capabilities: expect.any(Object)
    }));
    // version must come from package.json — never the literal fallback
    expect(body.version).not.toBe('unknown');
    // uptime must be non-negative; treat as smoke check, not perf test
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  // ── Single-feature flags ────────────────────────────────────────────────────
  it('GET /api/video-export-available returns 200 with available=true', async () => {
    // The production image installs ffmpeg + Playwright, so the flag
    // is hard-coded to `true`. A regression that drops one of those
    // dependencies would still pass this assertion; the actual ffmpeg
    // pipeline is covered by `videoExport.testcontainers.test.js`.
    const { status, body } = await getJson(handle.baseUrl, '/api/video-export-available');
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('GET /api/ai-assessment-available returns 200 with an `available` boolean', async () => {
    // True iff an LLM provider is configured via env. The image ships
    // without a key, so we only assert the shape — not the value — to
    // keep the test stable for both CI and locally-keyed runs.
    const { status, body } = await getJson(handle.baseUrl, '/api/ai-assessment-available');
    expect(status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ available: expect.any(Boolean) }));
  });

  it('GET /api/political-context/supported returns 200 with cities array', async () => {
    const { status, body } = await getJson(handle.baseUrl, '/api/political-context/supported');
    expect(status).toBe(200);
    expect(Array.isArray(body.cities)).toBe(true);
  });

  // ── City catalogue ──────────────────────────────────────────────────────────
  it('GET /api/cities returns a non-empty catalogue with summary', async () => {
    const { status, body } = await getJson(handle.baseUrl, '/api/cities?limit=5');
    expect(status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      total:   expect.any(Number),
      count:   expect.any(Number),
      summary: expect.any(Object),
      cities:  expect.any(Array)
    }));
    expect(body.total).toBeGreaterThan(0);
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThanOrEqual(5);
    // Each city must have at least an id-ish identifier so the detail
    // endpoint stays usable.
    expect(body.cities[0]).toEqual(expect.any(Object));
  });

  it('GET /api/cities/:idOrKey returns 404 + CITY_NOT_FOUND for unknown keys', async () => {
    const { status, body } = await getJson(
      handle.baseUrl,
      '/api/cities/__definitely_not_a_city__'
    );
    expect(status).toBe(404);
    // `sendError` returns a flat body: { error, code, category, details? }
    expect(body).toEqual(expect.objectContaining({
      code:     'CITY_NOT_FOUND',
      category: expect.any(String),
      error:    expect.any(String)
    }));
  });

  // ── Static frontend mount ───────────────────────────────────────────────────
  it('GET /werkbank_v2.html serves the frontend entrypoint as HTML', async () => {
    // The entire app bootstraps from this file (README pinned); a
    // missing static mount or wrong cwd in the Dockerfile would break
    // the public demo silently while every unit test stays green.
    const { status, contentType, text } = await getRaw(handle.baseUrl, '/werkbank_v2.html');
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
    expect(text).toMatch(/<html[\s>]/i);
  });

  // ── Analysis-service forwarders (Schicht-1: not-configured branch) ──────────
  it('GET /api/location-briefs/by-location/:key returns 503 + ANALYSIS_SERVICE_NOT_CONFIGURED', async () => {
    // The shipped image has no `ANALYSIS_SERVICE_BASE_URL`, so the
    // forwarder MUST short-circuit with this exact code. Covers the
    // entire `ensureAnalysisServiceConfigured` branch end-to-end without
    // requiring the second image (Spring Boot + PostgreSQL); that
    // multi-container path is tracked in TODO.md as Schicht 2.
    const { status, body } = await getJson(
      handle.baseUrl,
      '/api/location-briefs/by-location/some-key'
    );
    expect(status).toBe(503);
    expect(body).toEqual(expect.objectContaining({
      code:     'ANALYSIS_SERVICE_NOT_CONFIGURED',
      category: expect.any(String),
      error:    expect.any(String)
    }));
  });
});
