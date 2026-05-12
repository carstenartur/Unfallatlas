import { test, expect } from '@playwright/test';

test('Berlin URL with mapLayer=slope renders overlay and visible legend swatches', async ({ page }) => {
  await page.goto('werkbank_v2.html?city=Berlin&mapLayer=slope&ctxOnlyMatched=0&showCluster=0&showHeatmap=0');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#ctxOverlay_slope')).toBeChecked();

  await expect
    .poll(async () => page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('.leaflet-overlay-pane canvas'));
      let maxNonTransparent = 0;
      for (const canvas of canvases) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        if (!ctx || !w || !h) continue;
        const data = ctx.getImageData(0, 0, w, h).data;
        let nonTransparent = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 0 && ++nonTransparent > 20) break;
        }
        if (nonTransparent > maxNonTransparent) maxNonTransparent = nonTransparent;
      }
      return maxNonTransparent;
    }), { timeout: 90000 })
    .toBeGreaterThan(20);

  const legend = page.locator('.context-road-legend--slope');
  await expect(legend).toBeVisible();

  const swatches = legend.locator('.context-road-legend__swatch');
  await expect(swatches).toHaveCount(7);
  const metrics = await swatches.evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return {
        width: el.clientWidth,
        height: el.clientHeight,
        backgroundColor: cs.backgroundColor,
      };
    })
  );
  for (const m of metrics) {
    expect(m.width).toBeGreaterThan(0);
    expect(m.height).toBeGreaterThan(0);
    expect(m.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(m.backgroundColor).not.toBe('transparent');
  }
});
