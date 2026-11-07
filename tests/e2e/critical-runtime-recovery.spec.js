import { test, expect } from '@playwright/test';

test('the real core startup recovers a transient 503 before the next parser script runs', async ({ page, baseURL }) => {
  const mapScriptAttempts = [];
  await page.route('**/js/ua.map_v2.js*', async (route) => {
    const attempt = new URL(route.request().url()).searchParams.get('ua_runtime_retry');
    mapScriptAttempts.push(attempt);
    if (attempt === null) {
      await route.fulfill({
        status: 503,
        contentType: 'text/html',
        body: '<!doctype html><title>temporary outage</title>',
      });
      return;
    }
    await route.continue();
  });

  // Use a real same-origin navigation so the browser parses the scripts as it
  // does in the app. setContent writes into about:blank and may refetch a
  // failed speculative request without exercising the recovery guard.
  const fixtureUrl = new URL('critical-runtime-recovery-test.html', baseURL).href;
  await page.route(fixtureUrl, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
<html><head>
  <script src="js/ua.core.js?v=test"></script>
  <script src="js/ua.map_v2.js?v=primary"></script>
  <script>
    window.__criticalRuntimeReadyBeforeNextParserScript =
      typeof window.UA?.initLeaflet === 'function';
  </script>
</head><body></body></html>`,
  }));
  await page.goto(fixtureUrl);

  expect(mapScriptAttempts).toEqual([null, '1']);
  expect(await page.evaluate(() => window.__criticalRuntimeReadyBeforeNextParserScript)).toBe(true);
  expect(await page.evaluate(() => window.UA.criticalRuntimeFailures)).toEqual([
    expect.objectContaining({ script: 'ua.map_v2.js', attempt: 1 }),
  ]);
});
