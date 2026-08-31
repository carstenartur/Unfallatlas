import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0&mapMode=standard';

test('Bonn political research avoids the static-host 405 and exposes official server-safe links', async ({ page }) => {
  test.setTimeout(60_000);
  const apiMethods = [];
  const oparlRequests = [];

  await page.route('**/api/political-context/search', async route => {
    apiMethods.push(route.request().method());
    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    });
  });
  await page.route('https://www.bonn.sitzung-online.de/oparl/**', async route => {
    oparlRequests.push(route.request().url());
    await route.abort();
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(
    window.UA?.PoliticalContext?._runSearch
      && window.UA?.getRuntimeContext?.()
  ), null, { timeout: 45_000 });

  // Materialise the same public runtime that the Pages build injects. The
  // official Bonn OParl service currently sends no browser CORS permission, so
  // the public profile must neither POST to Pages nor pretend it can fetch the
  // cross-origin collection directly.
  await page.addScriptTag({ url: 'js/ua.public-preview.js' });
  await page.waitForFunction(() =>
    window.UA?.PoliticalContext?.search?.__publicPagesTransportGuard === true
  );

  await page.evaluate(() => {
    const ctx = window.UA.getRuntimeContext();
    ctx.locationHint = {
      street: 'Adenauerallee',
      district: 'Südstadt',
      label: 'Adenauerallee, Bonn-Südstadt',
    };
    window.UA.applyPublicDistributionProfile(ctx);
  });

  await expect(page.locator('#polCtxBtnSearch')).toBeDisabled();
  await expect(page.locator('#polCtxStatus'))
    .toContainText(/kein fehlerhafter API-Aufruf/i);
  await expect(page.locator('#polCtxResults'))
    .toContainText('Ratsinformationssystem öffnen');
  const links = page.locator('#polCtxResults a');
  await expect(links.first()).toHaveAttribute(
    'href',
    /^https:\/\/www\.bonn\.sitzung-online\.de\/public\//
  );

  const searchFailure = await page.evaluate(async () => {
    try {
      await window.UA.PoliticalContext.search({
        city: 'Bonn',
        searchTerms: ['Adenauerallee'],
      });
      return null;
    } catch (error) {
      return { code: error && error.code, message: String(error && error.message || error) };
    }
  });
  expect(searchFailure).toMatchObject({
    code: 'POLITICAL_CONTEXT_BACKEND_REQUIRED',
    message: expect.stringMatching(/Server-\/Docker-Version/i),
  });
  expect(apiMethods).toEqual([]);
  expect(oparlRequests).toEqual([]);
});