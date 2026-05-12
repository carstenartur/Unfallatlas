import { test, expect } from '@playwright/test';

test('Berlin URL mit mapLayer=slope rendert Overlay und sichtbare Legenden-Swatches', async ({ page }) => {
  await page.goto('werkbank_v2.html?city=Berlin&mapLayer=slope&ctxOnlyMatched=0');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#ctxOverlay_slope')).toBeChecked();

  await expect
    .poll(async () => page.evaluate(() => {
      const layer = window.UA?.ctx?.contextOverlays?.layers?.slope;
      if (!layer || typeof layer.getLayers !== 'function') return 0;
      return layer.getLayers().length;
    }), { timeout: 90000 })
    .toBeGreaterThan(0);

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
  expect(metrics.length).toBeGreaterThanOrEqual(5);
  for (const m of metrics) {
    expect(m.width).toBeGreaterThan(0);
    expect(m.height).toBeGreaterThan(0);
    expect(m.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(m.backgroundColor).not.toBe('transparent');
  }
});
