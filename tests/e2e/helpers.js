/**
 * Gemeinsame Hilfsfunktionen für E2E-Tests
 */

/**
 * Legacy-named guard retained for existing callers. Browser dependencies now
 * come from the canonical `_site/vendor` build. Any CDN request is therefore
 * an architecture regression and is blocked instead of being replaced with
 * potentially different local bytes.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setupCDNRoutes(page) {
  await page.route(/https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)\//, route => route.abort('blockedbyclient'));
}

/**
 * Wartet auf stabilen Leaflet-Tile-Zustand:
 * - keine `leaflet-tile-loading`-Tiles mehr
 * - mindestens ein `leaflet-tile-loaded`-Tile vorhanden
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} timeout
 */
export async function waitForMapTiles(page, timeout = 15000) {
  let helperResult;
  try {
    helperResult = await page.evaluate(async (timeoutMs) => {
      if (!window.UA || typeof window.UA.waitForMapFullyRendered !== 'function') {
        return { available: false };
      }
      const map = window._uaMap;
      if (!map) throw new Error('window._uaMap is unavailable');
      const ok = await window.UA.waitForMapFullyRendered(map, {
        timeoutMs,
        minTileImages: 1
      });
      return {
        available: true,
        ok: ok === true,
        lifecycle: window.UA.lifecycle && typeof window.UA.lifecycle.getSnapshot === 'function'
          ? window.UA.lifecycle.getSnapshot()
          : null
      };
    }, timeout);
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      lifecycle: window.UA && window.UA.lifecycle && typeof window.UA.lifecycle.getSnapshot === 'function'
        ? window.UA.lifecycle.getSnapshot()
        : null,
      tileImages: document.querySelectorAll('.leaflet-tile-pane img').length,
      loadingTileImages: document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loading').length
    })).catch(() => null);
    throw new Error(
      `UA.waitForMapFullyRendered failed: ${error && error.message ? error.message : error}` +
      `\nMap diagnostics: ${JSON.stringify(diagnostics, null, 2)}`
    );
  }

  // The DOM-only check is retained for isolated pages that do not ship the UA
  // helper. Once the application exposes the helper, a negative result is an
  // explicit readiness failure and must never degrade to the weaker fallback.
  if (helperResult && helperResult.available) {
    if (helperResult.ok) return;
    throw new Error(
      `UA.waitForMapFullyRendered returned false within ${timeout}ms` +
      `\nMap diagnostics: ${JSON.stringify(helperResult.lifecycle, null, 2)}`
    );
  }
  try {
    await page.waitForFunction(() => {
      const map = document.querySelector('.leaflet-container');
      if (!map) return false;
      const loadingTiles = map.querySelectorAll('img.leaflet-tile-loading').length;
      const loadedTiles = map.querySelectorAll('img.leaflet-tile-loaded').length;
      return loadingTiles === 0 && loadedTiles > 0;
    }, null, { timeout });
  } catch (err) {
    throw new Error(
      `Leaflet tiles did not reach a stable loaded state within ${timeout}ms: ${err && err.message ? err.message : err}`
    );
  }
  // kurzes Zusatzfenster für finales Paint nach dem letzten Tile-Decode
  await page.waitForTimeout(250);
}

/**
 * Defensiv auf Font-Readiness warten (kein Fehler ohne Font-API)
 *
 * @param {import('@playwright/test').Page} page
 */
export async function waitForFonts(page) {
  await page.evaluate(() => (document.fonts && document.fonts.ready) || null);
}

/**
 * Wait for the public application lifecycle rather than inferring readiness
 * from network-idle or a translated status string.  Defaults are deliberately
 * fail-closed for documentation screenshots: a complete full-city data source,
 * non-empty loaded/filtered/viewport sets, and every requested render layer
 * must be complete.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{city?: string, layers?: string[], minLoaded?: number, minFiltered?: number,
 *   minViewport?: number, afterRevision?: number, requireCompleteCoverage?: boolean,
 *   timeout?: number}} options
 */
export async function waitForScreenshotReady(page, options = {}) {
  const timeout = Math.max(1000, Number(options.timeout) || 30000);
  const criteria = {
    city: options.city || undefined,
    layers: Array.isArray(options.layers) ? options.layers : [],
    minLoaded: options.minLoaded == null ? 1 : Number(options.minLoaded),
    minFiltered: options.minFiltered == null ? 1 : Number(options.minFiltered),
    minViewport: options.minViewport == null ? 1 : Number(options.minViewport),
    afterRevision: options.afterRevision == null ? undefined : Number(options.afterRevision),
    requireCompleteCoverage: options.requireCompleteCoverage !== false
  };

  try {
    return await page.evaluate(async ({ criteria: expected, timeoutMs }) => {
      const lifecycle = window.UA && window.UA.lifecycle;
      if (!lifecycle || typeof lifecycle.whenReady !== 'function') {
        throw new Error('UA.lifecycle.whenReady is unavailable');
      }
      return lifecycle.whenReady(expected, { timeoutMs });
    }, { criteria, timeoutMs: timeout });
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const lifecycle = window.UA && window.UA.lifecycle;
      return lifecycle && typeof lifecycle.getSnapshot === 'function'
        ? lifecycle.getSnapshot()
        : null;
    }).catch(() => null);
    throw new Error(
      `Screenshot scenario did not reach semantic readiness: ${error && error.message ? error.message : error}` +
      `\nLifecycle diagnostics: ${JSON.stringify(diagnostics, null, 2)}`
    );
  }
}

/**
 * Validate the semantic part of screenshot evidence without filesystem or
 * browser dependencies. Kept separate so the fail-closed contract is directly
 * unit-testable in Jest.
 *
 * @param {object} snapshot
 * @param {{city?: string, layers?: string[]}} criteria
 * @param {string} label
 */
export function assertScreenshotSnapshot(snapshot, criteria = {}, label = 'screenshot') {
  if (!snapshot || snapshot.status !== 'ready') {
    throw new Error(`Screenshot evidence requires a ready lifecycle snapshot: ${label}`);
  }
  if (criteria.city && snapshot.city !== criteria.city) {
    throw new Error(`Screenshot evidence expected city ${criteria.city}, got ${snapshot.city || '(none)'}: ${label}`);
  }
  if (!snapshot.counts || snapshot.counts.loaded < 1 || snapshot.counts.filtered < 1 || snapshot.counts.viewport < 1) {
    throw new Error(`Screenshot evidence requires non-empty accident data: ${label}`);
  }
  if (!snapshot.coverage || snapshot.coverage.complete !== true) {
    throw new Error(`Screenshot evidence requires complete city-data coverage: ${label}`);
  }
  if (!snapshot.render || snapshot.render.submitted !== true ||
      snapshot.render.completedRevision !== snapshot.render.revision) {
    throw new Error(`Screenshot evidence requires a completed render revision: ${label}`);
  }
  for (const layerName of Array.isArray(criteria.layers) ? criteria.layers : []) {
    const layer = snapshot.render.layers && snapshot.render.layers[layerName];
    if (!layer || layer.requested !== true || layer.complete !== true || layer.visible < 1 ||
        (layerName === 'heatmap' && layer.painted !== true)) {
      throw new Error(`Screenshot evidence requires visible completed layer ${layerName}: ${label}`);
    }
  }
  return snapshot;
}

/**
 * Prove that no lifecycle/data/render transition straddled the browser's
 * screenshot operation. Volatile browser timing is intentionally excluded;
 * all application state that can change rendered accident pixels is bound.
 */
export function assertStableScreenshotSnapshot(before, after, criteria = {}, label = 'screenshot') {
  assertScreenshotSnapshot(before, criteria, label);
  assertScreenshotSnapshot(after, criteria, label);
  // The canonical PDF evidence image is rendered from an already downloaded,
  // immutable PDF. A later live-map render revision cannot change those canvas
  // pixels, so only data/coverage state must remain stable for that detached
  // artifact. Every ordinary application screenshot remains render-strict.
  const detachedRenderedArtifact = /(?:^|\/)15-export-pdf-rendered\.png$/.test(String(label));
  const projection = snapshot => ({
    city: snapshot.city,
    counts: snapshot.counts,
    coverage: snapshot.coverage,
    ...(detachedRenderedArtifact ? {} : { render: snapshot.render })
  });
  if (JSON.stringify(projection(before)) !== JSON.stringify(projection(after))) {
    throw new Error(`Screenshot lifecycle changed while pixels were captured: ${label}`);
  }
  return after;
}

/**
 * Persist machine-readable evidence for a generated documentation screenshot.
 * Each screenshot gets its own sidecar file so parallel Playwright workers
 * cannot overwrite a shared report.  The sidecar binds the image bytes to the
 * exact application/data build and the lifecycle snapshot that passed the
 * semantic readiness gate.
 *
 * @param {string} screenshotPath
 * @param {object} snapshot
 * @param {{city?: string, layers?: string[], mapSourceMode?: 'fixture'|'live'}} criteria
 */
export async function recordScreenshotEvidence(screenshotPath, snapshot, criteria = {}) {
  const [{ default: crypto }, { default: fs }, { default: path }] = await Promise.all([
    import('crypto'),
    import('fs'),
    import('path')
  ]);
  const repoRoot = path.resolve(process.cwd());
  const absoluteScreenshot = path.resolve(repoRoot, screenshotPath);
  const relativeScreenshot = path.relative(repoRoot, absoluteScreenshot).replace(/\\/g, '/');
  if (!relativeScreenshot || relativeScreenshot.startsWith('..') || path.isAbsolute(relativeScreenshot)) {
    throw new Error(`Screenshot path is outside the repository: ${screenshotPath}`);
  }
  if (path.posix.dirname(relativeScreenshot) !== 'docs/screenshots' ||
      path.posix.extname(relativeScreenshot).toLowerCase() !== '.png') {
    throw new Error(`Canonical screenshot evidence requires a flat docs/screenshots/*.png path: ${relativeScreenshot}`);
  }
  if (!fs.existsSync(absoluteScreenshot) || !fs.lstatSync(absoluteScreenshot).isFile() ||
      fs.lstatSync(absoluteScreenshot).isSymbolicLink()) {
    throw new Error(`Screenshot evidence cannot be recorded before the image exists: ${relativeScreenshot}`);
  }
  const screenshotRealRelative = path.relative(repoRoot, fs.realpathSync(absoluteScreenshot));
  if (screenshotRealRelative.startsWith('..') || path.isAbsolute(screenshotRealRelative)) {
    throw new Error(`Screenshot resolves outside the repository: ${relativeScreenshot}`);
  }
  if (typeof criteria.city !== 'string' || !criteria.city || !Array.isArray(criteria.layers) || criteria.layers.length === 0 ||
      criteria.requireCompleteCoverage === false) {
    throw new Error(`Canonical screenshot evidence requires city, render layers and complete coverage: ${relativeScreenshot}`);
  }
  assertScreenshotSnapshot(snapshot, criteria, relativeScreenshot);

  const buildManifestPath = path.join(repoRoot, '_site', 'build-manifest.json');
  if (!fs.existsSync(buildManifestPath) || !fs.statSync(buildManifestPath).isFile()) {
    throw new Error('Canonical _site/build-manifest.json is required for screenshot provenance');
  }
  const buildBytes = fs.readFileSync(buildManifestPath);
  const buildManifest = JSON.parse(buildBytes.toString('utf8'));
  const fingerprints = [
    buildManifest.fingerprint,
    buildManifest.application && buildManifest.application.fingerprint,
    buildManifest.data && buildManifest.data.fingerprint
  ];
  if (!fingerprints.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('Canonical build manifest lacks application/data fingerprints');
  }
  const imageBytes = fs.readFileSync(absoluteScreenshot);
  const detachedPdfArtifact = /(?:^|\/)15-export-pdf-rendered\.png$/.test(relativeScreenshot);
  const mapSourceMode = criteria.mapSourceMode || (detachedPdfArtifact ? 'fixture' : null);
  if (!['fixture', 'live'].includes(mapSourceMode)) {
    throw new Error(`Canonical screenshot evidence requires an explicit map source mode: ${relativeScreenshot}`);
  }
  const evidence = {
    schemaVersion: 1,
    revision: process.env.GITHUB_SHA || null,
    screenshot: {
      path: relativeScreenshot,
      bytes: imageBytes.length,
      sha256: crypto.createHash('sha256').update(imageBytes).digest('hex')
    },
    build: {
      path: '_site/build-manifest.json',
      sha256: crypto.createHash('sha256').update(buildBytes).digest('hex'),
      fingerprint: buildManifest.fingerprint,
      applicationFingerprint: buildManifest.application && buildManifest.application.fingerprint,
      dataFingerprint: buildManifest.data.fingerprint
    },
    criteria: {
      city: criteria.city || null,
      layers: Array.isArray(criteria.layers) ? criteria.layers.slice() : [],
      requireCompleteCoverage: criteria.requireCompleteCoverage !== false,
      mapSourceMode
    },
    lifecycle: snapshot
  };
  const basename = path.basename(relativeScreenshot, path.extname(relativeScreenshot));
  const reportPath = path.join(repoRoot, 'out', 'qa', 'screenshot-readiness', `${basename}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporaryPath = `${reportPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.renameSync(temporaryPath, reportPath);
  return evidence;
}

/**
 * Capture a documentation screenshot only after semantic application,
 * Leaflet-tile and font readiness have all been established.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{path: string, selector?: string, fullPage?: boolean, city?: string,
 *   layers?: string[], minLoaded?: number, minFiltered?: number, minViewport?: number,
 *   afterRevision?: number, requireCompleteCoverage?: boolean, timeout?: number}} options
 */
export async function captureDataScreenshot(page, options) {
  if (!options || !options.path) throw new Error('captureDataScreenshot requires a path');
  await waitForScreenshotReady(page, options);
  await waitForMapTiles(page, Math.min(Math.max(1000, Number(options.timeout) || 15000), 30000));
  await waitForFonts(page);
  const [{ default: fs }, { default: path }] = await Promise.all([
    import('fs/promises'),
    import('path')
  ]);
  const parsed = path.parse(options.path);
  const temporaryPath = path.join(
    parsed.dir,
    `.${parsed.name}.capture-${process.pid}-${Date.now()}${parsed.ext || '.png'}`
  );
  let lastTransition = null;
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let beforeCapture = await waitForScreenshotReady(page, options);
      let stableObservations = 0;
      for (let observation = 0; observation < 10 && stableObservations < 2; observation += 1) {
        await page.waitForTimeout(200);
        const next = await waitForScreenshotReady(page, options);
        try {
          assertStableScreenshotSnapshot(beforeCapture, next, options, options.path);
          stableObservations += 1;
        } catch (error) {
          stableObservations = 0;
          lastTransition = error;
        }
        beforeCapture = next;
      }
      if (stableObservations < 2) continue;

      if (options.selector) {
        await page.locator(options.selector).screenshot({ path: temporaryPath });
      } else {
        await page.screenshot({ path: temporaryPath, fullPage: options.fullPage === true });
      }
      const afterCapture = await waitForScreenshotReady(page, options);
      try {
        assertStableScreenshotSnapshot(beforeCapture, afterCapture, options, options.path);
      } catch (error) {
        lastTransition = error;
        await fs.rm(temporaryPath, { force: true });
        continue;
      }
      await fs.rename(temporaryPath, options.path);
      const mapSourceMode = await page.evaluate(() =>
        document.documentElement.dataset.mapSourceMode || 'live'
      );
      await recordScreenshotEvidence(options.path, afterCapture, { ...options, mapSourceMode });
      return afterCapture;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  throw lastTransition || new Error(`Screenshot lifecycle did not become quiescent: ${options.path}`);
}
