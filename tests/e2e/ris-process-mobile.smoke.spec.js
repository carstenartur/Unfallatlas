import { test, expect } from '@playwright/test';
import { ID, TITLE, BASE_VIEW, fixture, ready, captureEvidence } from './helpers/ris-shared-view-fixture.js';

test.use({ hasTouch: true });

for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
  test(`the process view fits ${viewport.width}px and collapses to release the map`, async ({ page }, testInfo) => {
    test.setTimeout(70_000);
    await page.setViewportSize(viewport);
    const data = await fixture(testInfo); await data.install(page);
    await ready(page, `/werkbank_v2.html?${BASE_VIEW}&risRecord=${encodeURIComponent(ID)}`);
    const panel = page.locator('#risDetails');
    await expect(panel.locator('.ris-process-step')).toHaveCount(64);
    await expect(panel).toBeInViewport({ ratio: 1 });
    const layout = await panel.evaluate(element => {
      const box = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll('button')].filter(button => !button.closest('[hidden]'));
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
        minimumControlHeight: Math.min(...buttons.map(button => button.getBoundingClientRect().height)) };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.width); expect(layout.bottom).toBeLessThanOrEqual(layout.height);
    expect(layout.overflow).toBe(false); expect(layout.minimumControlHeight).toBeGreaterThanOrEqual(44);
    await captureEvidence(page, testInfo, `ris-process-${viewport.width}px`);
    await panel.getByRole('button', { name: 'Vorgangsansicht einklappen', exact: true }).tap();
    await expect(panel.locator('.ris-details__body')).toBeHidden();
    expect(new URL(page.url()).searchParams.get('risCollapsed')).toBe('1');
    await page.locator('.leaflet-control-zoom-in').tap();
    await expect.poll(() => page.evaluate(() => window.UA.getRuntimeContext().map.getZoom())).toBe(15);
    const link = page.url();
    await ready(page, link);
    await expect(panel.locator('.ris-details__body')).toBeHidden();
    await panel.getByRole('button', { name: 'Vorgangsansicht ausklappen', exact: true }).tap();
    await expect(panel.locator('.ris-process-step')).toHaveCount(64);
    await panel.getByRole('button', { name: 'Vorgangsansicht schließen', exact: true }).tap();
    await expect(panel).toBeHidden();
  });
}
