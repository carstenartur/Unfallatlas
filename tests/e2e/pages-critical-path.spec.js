import { test, expect } from '@playwright/test';

const CONTRADICTORY_BONN_URL = [
  'werkbank_v2.html?city=Bonn',
  'includeCyclist=1',
  'includePedestrian=1',
  'includeCar=1',
  'includeMotorcycle=0',
  'involvementMode=or',
  'showCluster=1',
  'showHeatmap=0',
  'showOnlyAboveAverage=0',
  'showSchools=0',
  'showKindergartens=0',
  'showArgumentation=0',
  'severity=all',
  'dayType=all',
  'roadCondition=all',
  'hourFrom=0',
  'hourTo=23',
  'centerLat=52.375900',
  'centerLon=9.732000',
  'zoom=12',
  'selSouth=50.7300',
  'selWest=7.0910',
  'selNorth=50.7355',
  'selEast=7.1010',
  'maxPoints=100000',
  'viewportPaddingPct=20',
  'heatRadius=25',
  'includeGkfz=0',
  'includeSonstig=0',
  'mapMode=standard',
  'orthophotoOpacity=92',
  'ctxOnlyMatched=0',
].join('&');

async function requirePublicProfile(page) {
  const profile = await page.locator('meta[name="unfallwerkbank:distribution-profile"]')
    .getAttribute('content');
  test.skip(profile !== 'public-preview-core-v1', 'Test applies to the published Pages profile');
}

function isExpectedRouteTeardown(error) {
  return /Route is already handled|Target page, context or browser has been closed/.test(String(error));
}

test.describe('Public Pages critical path', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('active city and accident data do not wait for a stalled cities.txt request', async ({ page }) => {
    test.setTimeout(45000);
    let releaseCities;
    const cityRequestReleased = new Promise((resolve) => {
      releaseCities = resolve;
    });

    await page.route('**/cities.txt', async (route) => {
      await cityRequestReleased;
      try {
        await route.continue();
      } catch (error) {
        // Releasing the deliberately stalled request races with page teardown.
        // The user-visible assertions have already completed at this point.
        if (!isExpectedRouteTeardown(error)) throw error;
      }
    });

    try {
      await page.goto(CONTRADICTORY_BONN_URL, { waitUntil: 'domcontentloaded' });
      await requirePublicProfile(page);

      const citySelect = page.locator('#citySel');
      await expect(citySelect).toHaveValue('Bonn', { timeout: 3000 });
      await expect(citySelect).not.toHaveAttribute('aria-busy', 'true', { timeout: 3000 });
      await expect(citySelect).not.toContainText('Städte werden geladen', { timeout: 3000 });

      await page.waitForFunction(() => {
        const ctx = window.UA?.getRuntimeContext?.();
        return ctx?.CITY_RAW === 'Bonn' && Array.isArray(ctx.allPts) && ctx.allPts.length > 0;
      }, null, { timeout: 30000 });
    } finally {
      releaseCities();
      await page.unroute('**/cities.txt');
    }
  });

  test('a Bonn selection overrides a contradictory Hannover center', async ({ page }) => {
    test.setTimeout(45000);
    await page.goto(CONTRADICTORY_BONN_URL, { waitUntil: 'domcontentloaded' });
    await requirePublicProfile(page);

    await page.waitForFunction(() => {
      const ctx = window.UA?.getRuntimeContext?.();
      return ctx?.CITY_RAW === 'Bonn' && ctx.selectionBounds && ctx.map;
    }, null, { timeout: 30000 });

    const state = await page.evaluate(() => {
      const ctx = window.UA.getRuntimeContext();
      const center = ctx.map.getCenter();
      const bounds = ctx.selectionBounds;
      return {
        city: ctx.CITY_RAW,
        dropdownCity: document.getElementById('citySel')?.value,
        center: { lat: center.lat, lon: center.lng },
        selection: {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        },
        repair: ctx.urlConsistencyRepair || null,
      };
    });

    expect(state.city).toBe('Bonn');
    expect(state.dropdownCity).toBe('Bonn');
    expect(state.center.lat).toBeGreaterThanOrEqual(state.selection.south);
    expect(state.center.lat).toBeLessThanOrEqual(state.selection.north);
    expect(state.center.lon).toBeGreaterThanOrEqual(state.selection.west);
    expect(state.center.lon).toBeLessThanOrEqual(state.selection.east);
    expect(state.repair).toBe('selection-preferred-over-conflicting-center');
  });

  test('the public-version notice is collapsed and does not occupy the mobile workspace', async ({ page }) => {
    await page.goto('werkbank_v2.html?city=Bonn', { waitUntil: 'domcontentloaded' });
    await requirePublicProfile(page);

    const notice = page.locator('#publicPreviewNotice');
    await expect(notice).toBeVisible();
    await expect(notice).not.toHaveAttribute('open', '');
    await expect(notice.locator('summary')).toContainText('nur Videoexport nicht verfügbar');

    const box = await notice.boundingBox();
    expect(box).toBeTruthy();
    expect(box.height).toBeLessThan(55);
  });
});
