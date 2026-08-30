import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0&mapMode=standard';

test('Bonn political research avoids the static-host 405 and uses the browser OParl fallback', async ({ page }) => {
  test.setTimeout(60_000);
  const apiMethods = [];
  const oparlPages = [];

  await page.route('**/api/political-context/search', async route => {
    apiMethods.push(route.request().method());
    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    });
  });

  await page.route('https://www.bonn.sitzung-online.de/oparl/bodies/1/papers**', async route => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get('page') || 1);
    oparlPages.push(pageNumber);
    const commonHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };

    if (pageNumber === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: commonHeaders,
        body: JSON.stringify({
          data: [],
          pagination: { currentPage: 1, totalPages: 2 },
          links: {
            last: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2&limit=100&size=100',
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: commonHeaders,
      body: JSON.stringify({
        data: [{
          id: 'https://www.bonn.sitzung-online.de/oparl/papers/42',
          name: 'Radverkehr in der Adenauerallee verbessern',
          reference: 'DS 2026-42',
          date: '2026-06-01',
          paperType: 'Antrag',
          web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=42',
          keyword: ['Adenauerallee', 'Radverkehr'],
        }],
        pagination: { currentPage: 2, totalPages: 2 },
        links: {
          prev: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=1&limit=100&size=100',
          last: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2&limit=100&size=100',
        },
      }),
    });
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(
    window.UA?.PoliticalContext?._runSearch
      && window.UA?.getRuntimeContext?.()
  ), null, { timeout: 45_000 });

  // Materialise the same public runtime that the Pages build injects. It
  // installs the transport guard; the CSP bootstrap has already loaded the
  // local Bonn fallback module.
  await page.addScriptTag({ url: 'js/ua.public-preview.js' });
  await page.waitForFunction(() =>
    window.UA?.PoliticalContext?.search?._uaBonnBrowserFallbackWrapped === true
  );
  await expect(page.locator('#polCtxBtnSearch')).toBeEnabled();

  await page.evaluate(async () => {
    const ctx = window.UA.getRuntimeContext();
    ctx.locationHint = {
      street: 'Adenauerallee',
      district: 'Südstadt',
      label: 'Adenauerallee, Bonn-Südstadt',
    };
    document.getElementById('polCtxSearchInput').value = 'Adenauerallee';
    await window.UA.PoliticalContext._runSearch(ctx);
  });

  await expect(page.locator('#polCtxStatus'))
    .toContainText(/begrenzten.*OParl-Teilsuche/i);
  await expect(page.locator('#polCtxResults'))
    .toContainText('Radverkehr in der Adenauerallee verbessern');
  await expect(page.locator('#polCtxBrowserFallbackNotice'))
    .toContainText(/fehlende Treffer sind kein Nullbefund/i);
  await expect(page.locator('#polCtxStatus')).not.toContainText('HTTP 405');

  expect(apiMethods).toEqual([]);
  expect(oparlPages).toEqual(expect.arrayContaining([1, 2]));
});
