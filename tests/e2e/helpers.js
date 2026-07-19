/**
 * Gemeinsame Hilfsfunktionen für E2E-Tests
 */

/**
 * Richtet CDN-Routen auf lokale node_modules um, damit Export-Bibliotheken
 * offline verfügbar sind.
 *
 * NOTE: Keep CDN versions and file paths in sync with package.json and
 * the loadScript() calls in js/ua.report_v2.js ensureExportLibraries().
 * docx@9.x uses dist/index.iife.js; docx@8.x used build/index.umd.js.
 * Primary CDN is jsDelivr; fallback is unpkg — both are intercepted here.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setupCDNRoutes(page) {
  const path = await import('path');
  const fs = await import('fs');
  const root = path.resolve(process.cwd());

  const routes = [
    // jsDelivr (primary)
    {
      url: 'https://cdn.jsdelivr.net/npm/docx@9.6.1/dist/index.iife.js',
      file: path.join(root, 'node_modules/docx/dist/index.iife.js')
    },
    {
      url: 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.8/build/pdfmake.min.js',
      file: path.join(root, 'node_modules/pdfmake/build/pdfmake.min.js')
    },
    {
      url: 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.8/build/vfs_fonts.js',
      file: path.join(root, 'node_modules/pdfmake/build/vfs_fonts.js')
    },
    {
      url: 'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js',
      file: path.join(root, 'node_modules/file-saver/dist/FileSaver.min.js')
    },
    // unpkg (fallback)
    {
      url: 'https://unpkg.com/docx@9.6.1/dist/index.iife.js',
      file: path.join(root, 'node_modules/docx/dist/index.iife.js')
    },
    {
      url: 'https://unpkg.com/pdfmake@0.3.8/build/pdfmake.min.js',
      file: path.join(root, 'node_modules/pdfmake/build/pdfmake.min.js')
    },
    {
      url: 'https://unpkg.com/pdfmake@0.3.8/build/vfs_fonts.js',
      file: path.join(root, 'node_modules/pdfmake/build/vfs_fonts.js')
    },
    {
      url: 'https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js',
      file: path.join(root, 'node_modules/file-saver/dist/FileSaver.min.js')
    }
  ];

  const missingRoutes = routes.filter((route) => !fs.existsSync(route.file));
  if (missingRoutes.length > 0) {
    throw new Error(
      'Missing local CDN test assets required for offline testing:\n' +
      missingRoutes
        .map((route) => `- ${route.url} -> ${route.file}`)
        .join('\n')
    );
  }

  for (const route of routes) {
    await page.route(route.url, async (r) => {
      await r.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: fs.readFileSync(route.file)
      });
    });
  }
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
    }, { timeout });
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
  const snapshot = await waitForScreenshotReady(page, options);
  await waitForMapTiles(page, Math.min(Math.max(1000, Number(options.timeout) || 15000), 30000));
  await waitForFonts(page);
  if (options.selector) {
    await page.locator(options.selector).screenshot({ path: options.path });
  } else {
    await page.screenshot({ path: options.path, fullPage: options.fullPage === true });
  }
  return snapshot;
}
