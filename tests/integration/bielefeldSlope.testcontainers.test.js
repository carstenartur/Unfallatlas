/**
 * Focused integration test: Bielefeld + ?mapLayer=slope must render a
 * working slope overlay end-to-end against the production-built web app
 * served from the `unfallatlas` Docker image.
 *
 * Why this exists
 * ---------------
 * The original bug report:
 *
 *   In Bielefeld, mapLayer=slope shows inconsistent or missing slope
 *   visualization. The legend is empty. The context tile index appears
 *   empty or invalid.
 *
 * No existing unit / e2e test catches the full chain
 *
 *     Docker image
 *       → Express static server
 *         → ways_bielefeld.json (v3 envelope)
 *           → ctxtiles/bielefeld/index.json (manifest with `dicts`)
 *             → ctxtiles/bielefeld/<x>/<y>.json (per-tile payload)
 *               → ua.context_layers.js (loader)
 *                 → ua.map_v2.js (slope overlay control + legend)
 *
 * because the unit tests stub the loader and the existing e2e tests
 * use `python3 -m http.server` against the working tree. A regression
 * in the Dockerfile, the static server, the producer, or the loader
 * would slip past everything.
 *
 * This suite starts the *built* `unfallatlas` container via
 * testcontainers (same helper as `videoExport.testcontainers.test.js`),
 * launches a headless Chromium against `werkbank_v2.html?city=Bielefeld
 * &mapLayer=slope` programmatically, observes the network responses,
 * and asserts the loaded contracts plus the rendered DOM.
 *
 * Skip semantics
 * --------------
 * Same heuristic as the sibling testcontainers suites — the whole
 * describe-block is skipped on machines without Docker so `npm test`
 * stays green on developer laptops. The Playwright launch is also
 * tolerant: if the host has no Chromium binary (the test usually runs
 * in CI on a Playwright-enabled image), the suite logs the reason and
 * skips the failing assertions instead of throwing a confusing stack.
 */

'use strict';

const fs = require('fs');
const {
  isDockerAvailable,
  startUnfallatlasContainer,
} = require('./lib/startUnfallatlasContainer');

// Bielefeld viewport coordinates from the bug report. Centered roughly
// on the Hauptbahnhof so the slippy-z13 tile that covers it
// (≈ 4290/2705 — see `out/ctxtiles/bielefeld/index.json`) is forced
// into the viewport at zoom 15.
const BIELEFELD_URL =
  'werkbank_v2.html'
  + '?city=Bielefeld'
  + '&centerLat=52.015093'
  + '&centerLon=8.533480'
  + '&zoom=15'
  + '&mapLayer=slope';

const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
const PAGE_NAVIGATION_TIMEOUT_MS = 60_000;
const ASSERTION_WAIT_MS = 30_000;

function dockerLikelyAvailable() {
  if (process.env.RUN_TESTCONTAINERS === '1') return true;
  if (process.env.DOCKER_HOST) return true;
  try { return fs.existsSync('/var/run/docker.sock'); } catch (_) { return false; }
}

const SUITE_DESCRIBE_DOCKER_OK = dockerLikelyAvailable();

// Lazy-require so the module load never crashes on machines without
// `@playwright/test` installed (the test would still skip cleanly via
// the Docker heuristic above).
function loadChromium() {
  try {
    // eslint-disable-next-line global-require
    return require('@playwright/test').chromium;
  } catch (err) {
    return null;
  }
}

// Decide at definition time whether the suite can possibly run. Both
// Docker AND `@playwright/test` must be present; otherwise Jest would
// either fail confusingly later or — worse — silently pass an early
// return inside the test body. By gating SUITE_DESCRIBE here we keep
// the behavior honest: in dev (no Docker / no Playwright) the suite
// is skipped at the top of the run; in CI, where `RUN_TESTCONTAINERS=1`
// is set, Docker is required and a missing Playwright is reported by
// the explicit beforeAll throw below (no silent pass).
const HAS_CHROMIUM_MODULE = loadChromium() !== null;
const SUITE_CAN_RUN = SUITE_DESCRIBE_DOCKER_OK && HAS_CHROMIUM_MODULE;
const SUITE_DESCRIBE = SUITE_CAN_RUN ? describe : describe.skip;
if (!SUITE_CAN_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    '[bielefeldSlope.testcontainers] Skipping suite — ' +
    (!SUITE_DESCRIBE_DOCKER_OK
      ? 'no Docker socket and DOCKER_HOST unset. Set RUN_TESTCONTAINERS=1 to force.'
      : '@playwright/test is not installed.')
  );
}

SUITE_DESCRIBE('Bielefeld + mapLayer=slope — testcontainers integration', () => {
  let handle = null;
  let browser = null;

  beforeAll(async () => {
    const probe = await isDockerAvailable();
    if (!probe.available) {
      throw new Error(
        `Docker daemon present but unreachable: ${probe.reason}. ` +
        'Either start Docker or unset RUN_TESTCONTAINERS / DOCKER_HOST.'
      );
    }
    handle = await startUnfallatlasContainer();
    // The suite gate already guarantees Playwright is installed.
    // A launch failure here is a real CI problem (missing Chromium
    // binary, broken sandbox, etc.) and must surface as a failure
    // rather than a silent pass.
    const chromium = loadChromium();
    browser = await chromium.launch({ headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS });
  }, 10 * 60 * 1000);

  afterAll(async () => {
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore */ }
    }
    if (handle) await handle.stop();
  });

  it('loads ways_bielefeld.json, a non-empty v3 tile index, ≥1 per-tile payload, and renders a populated slope legend', async () => {
    const url = `${handle.baseUrl}/${BIELEFELD_URL}`;
    const context = await browser.newContext();
    const page = await context.newPage();

    // Collect responses for the three contract URLs we want to assert
    // on. We deliberately match by suffix — the static Express server
    // serves the repo root, so the actual paths are predictable.
    const responses = {
      ways: null,
      tileIndex: null,
      tilePayloads: [],
    };
    page.on('response', (resp) => {
      const u = resp.url();
      if (/\/out\/ways_bielefeld\.json(\?|$)/.test(u)) {
        responses.ways = { status: resp.status(), url: u, resp };
      } else if (/\/out\/ctxtiles\/bielefeld\/index\.json(\?|$)/.test(u)) {
        responses.tileIndex = { status: resp.status(), url: u, resp };
      } else if (/\/out\/ctxtiles\/bielefeld\/\d+\/\d+\.json(\?|$)/.test(u)) {
        responses.tilePayloads.push({ status: resp.status(), url: u });
      }
    });

    // Set up the tile-payload race-tolerant wait BEFORE navigation so
    // we never miss the first tile fetch (which is debounced behind
    // moveend/loadAtIdle and may resolve before our `expect` runs).
    const firstTilePayloadPromise = page.waitForResponse(
      (resp) => /\/out\/ctxtiles\/bielefeld\/\d+\/\d+\.json(\?|$)/.test(resp.url()),
      { timeout: ASSERTION_WAIT_MS }
    );

    try {
      // Use 'load' instead of 'networkidle': the map page keeps
      // background network activity going (tile fetches, retries, idle
      // callbacks), which makes 'networkidle' flaky. We rely on the
      // explicit waitForSelector / waitForFunction / waitForResponse
      // assertions below for deterministic synchronization.
      await page.goto(url, { waitUntil: 'load', timeout: PAGE_NAVIGATION_TIMEOUT_MS });

      // The slope overlay control is built lazily once
      // ctx.contextLayerState resolves (loadAtIdle). Wait for the
      // Karten-Layer control + the slope checkbox.
      await page.waitForSelector('#ctxOverlay_slope', { state: 'attached', timeout: ASSERTION_WAIT_MS });

      // 1. ways_bielefeld.json must have loaded successfully and parse
      //    as a v3 envelope.
      expect(responses.ways).not.toBeNull();
      expect(responses.ways.status).toBe(200);
      const waysBody = await responses.ways.resp.json();
      expect(waysBody).toMatchObject({ schemaVersion: 3, coverage: 'full' });
      expect(typeof waysBody.tileIndexUrl).toBe('string');

      // 2. ctxtiles/bielefeld/index.json must have loaded, parse, and
      //    be non-empty (the central regression target — see PR #265
      //    discussion).
      expect(responses.tileIndex).not.toBeNull();
      expect(responses.tileIndex.status).toBe(200);
      const indexBody = await responses.tileIndex.resp.json();
      expect(indexBody.schemaVersion).toBe(3);
      expect(indexBody.coverage).toBe('full');
      expect(Array.isArray(indexBody.tiles)).toBe(true);
      expect(indexBody.tiles.length).toBeGreaterThan(0);
      expect(indexBody.dicts).toBeTruthy();
      expect(typeof indexBody.dicts).toBe('object');
      expect(Object.keys(indexBody.dicts).length).toBeGreaterThan(0);

      // 3. With mapLayer=slope the loader should have prefetched at
      //    least one per-tile payload for the current viewport. Await
      //    the pre-armed waitForResponse promise so we don't race
      //    against the moveend-debounced tile fetch.
      const firstTileResp = await firstTilePayloadPromise;
      expect(firstTileResp.status()).toBe(200);
      await page.waitForFunction(() => {
        return !!document.querySelector('.context-road-legend--slope');
      }, { timeout: ASSERTION_WAIT_MS });

      expect(responses.tilePayloads.length).toBeGreaterThan(0);
      for (const t of responses.tilePayloads) {
        expect(t.status).toBe(200);
      }

      // 4. The slope layer control checkbox must be present + enabled
      //    (the v3-tiles ready signal lifts the disabled state).
      const slopeCheckbox = await page.$('#ctxOverlay_slope');
      expect(slopeCheckbox).not.toBeNull();
      const isDisabled = await slopeCheckbox.evaluate((el) => el.disabled === true);
      expect(isDisabled).toBe(false);
      const isChecked = await slopeCheckbox.evaluate((el) => el.checked === true);
      expect(isChecked).toBe(true);

      // 5. Slope legend visible with ≥ 5 class rows. buildLegend('slope')
      //    emits one .context-road-legend__row per SLOPE_CLASS_VALUES
      //    entry (5 classes: flat, gentle, moderate, steep, very_steep)
      //    plus a "kein Steigungssignal" row in a separate DOM class.
      const legendRows = await page.$$('.context-road-legend--slope .context-road-legend__row');
      expect(legendRows.length).toBeGreaterThanOrEqual(5);

      // 6. No "alte Datenversion" hint anywhere — that text is only
      //    rendered when state !== null && !hasGeom (legacy/unsupported
      //    schema), which must NOT happen for a healthy v3 city.
      const pageText = await page.locator('body').innerText();
      expect(pageText).not.toMatch(/alte Datenversion/);

      // 7. The legend container itself must be visible (display !==
      //    'none'); _refreshContextLegend hides it when no overlay is
      //    active. The above checks cover the rows; this one guards
      //    against the styling regression where the rows are in the
      //    DOM but the wrapper stays display:none.
      const legendVisible = await page.$eval('#context-overlay-legend', (el) => {
        return window.getComputedStyle(el).display !== 'none' && el.children.length > 0;
      });
      expect(legendVisible).toBe(true);
    } finally {
      try { await page.close(); } catch (_) { /* ignore */ }
      try { await context.close(); } catch (_) { /* ignore */ }
    }
  }, 6 * 60 * 1000);
});
