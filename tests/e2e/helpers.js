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
