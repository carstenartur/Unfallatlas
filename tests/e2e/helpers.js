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
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setupCDNRoutes(page) {
  const path = await import('path');
  const fs = await import('fs');
  const root = path.resolve(process.cwd());

  const routes = [
    {
      url: 'https://unpkg.com/docx@9.6.1/dist/index.iife.js',
      file: path.join(root, 'node_modules/docx/dist/index.iife.js')
    },
    {
      url: 'https://unpkg.com/pdfmake@0.3.7/build/pdfmake.min.js',
      file: path.join(root, 'node_modules/pdfmake/build/pdfmake.min.js')
    },
    {
      url: 'https://unpkg.com/pdfmake@0.3.7/build/vfs_fonts.js',
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
