import { test, expect } from '@playwright/test';

test('the real core startup recovers a transient 503 before the next parser script runs', async ({ page, baseURL }) => {
  let mapScriptRequests = 0;
  await page.route('**/js/ua.map_v2.js*', async (route) => {
    mapScriptRequests += 1;
    if (mapScriptRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'text/html',
        body: '<!doctype html><title>temporary outage</title>',
      });
      return;
    }
    await route.continue();
  });

  const root = new URL('.', baseURL || 'http://localhost:8000/').href;
  await page.setContent(`<!doctype html>
<html><head>
  <script src="${root}js/ua.core.js?v=test"></script>
  <script src="${root}js/ua.map_v2.js?v=primary"></script>
  <script>
    window.__criticalRuntimeReadyBeforeNextParserScript =
      typeof window.UA?.initLeaflet === 'function';
  </script>
</head><body></body></html>`, { waitUntil: 'load' });

  expect(mapScriptRequests).toBe(2);
  expect(await page.evaluate(() => window.__criticalRuntimeReadyBeforeNextParserScript)).toBe(true);
  expect(await page.evaluate(() => window.UA.criticalRuntimeFailures)).toEqual([
    expect.objectContaining({ script: 'ua.map_v2.js', attempt: 1 }),
  ]);
});
