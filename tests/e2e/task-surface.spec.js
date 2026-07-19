import { test, expect } from '@playwright/test';
import { waitForScreenshotReady } from './helpers.js';

async function waitForTaskSurface(page) {
  const ready = await waitForScreenshotReady(page, {
    city: 'Hannover',
    layers: ['cluster', 'heatmap'],
  });
  await expect(page.locator('#btnOpenExport')).toBeVisible();
  return ready;
}

test.describe('responsive task surface', () => {
  test('keyboard user can change the analysis and complete the export-dialog task', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    let ready = await waitForTaskSurface(page);

    const initialPrimaryAction = await page.evaluate(() => {
      const panel = document.getElementById('panel');
      const button = document.getElementById('btnOpenExport');
      const panelRect = panel.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        scrollTop: panel.scrollTop,
        fullyVisible: buttonRect.top >= panelRect.top && buttonRect.bottom <= panelRect.bottom,
      };
    });
    expect(initialPrimaryAction).toEqual({ scrollTop: 0, fullyVisible: true });

    const severity = page.locator('#severity');
    await severity.focus();
    await page.keyboard.press('ArrowDown');
    await expect(severity).not.toHaveValue('all');
    ready = await waitForScreenshotReady(page, { city: 'Hannover', afterRevision: ready.render.revision });

    const cluster = page.locator('#toggleCluster');
    const initialPressed = await cluster.getAttribute('aria-pressed');
    await cluster.focus();
    await page.keyboard.press('Enter');
    await expect(cluster).toHaveAttribute('aria-pressed', initialPressed === 'true' ? 'false' : 'true');
    ready = await waitForScreenshotReady(page, { city: 'Hannover', afterRevision: ready.render.revision });

    const open = page.locator('#btnOpenExport');
    const dialog = page.locator('#modalOverlay');
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#btnCloseModal')).toBeFocused();
    await expect(page.locator('#exportProgress')).toContainText('Fertig', { timeout: 30_000 });

    expect(await page.locator('#panel').evaluate(element => ({
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }))).toEqual({ inert: true, ariaHidden: 'true' });

    // Walk farther than the dialog's focusable count. Focus must never reach
    // the inert map/task surface while the modal is active.
    for (let i = 0; i < 30; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => {
      const dialogElement = document.getElementById('modalOverlay');
      return dialogElement.contains(document.activeElement);
    })).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    expect(pageErrors).toEqual([]);
  });
});

test.describe('touch task surface', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('touch user can alter the map and open/close the export bottom sheet', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    let ready = await waitForTaskSurface(page);

    const heat = page.locator('#toggleHeat');
    await heat.scrollIntoViewIfNeeded();
    const initialPressed = await heat.getAttribute('aria-pressed');
    await heat.tap();
    await expect(heat).toHaveAttribute('aria-pressed', initialPressed === 'true' ? 'false' : 'true');
    ready = await waitForScreenshotReady(page, { city: 'Hannover', afterRevision: ready.render.revision });

    const open = page.locator('#btnOpenExport');
    await open.scrollIntoViewIfNeeded();
    await open.tap();

    const dialog = page.locator('#modalOverlay');
    const modal = dialog.locator('.modal');
    await expect(dialog).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(page.locator('#exportProgress')).toContainText('Fertig', { timeout: 30_000 });

    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const panel = document.getElementById('panel');
      const modalElement = document.querySelector('#modalOverlay .modal');
      const openButton = document.getElementById('btnOpenExport').getBoundingClientRect();
      const closeButton = document.getElementById('btnCloseModal').getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: root.scrollWidth,
        panelFits: panel.scrollWidth <= panel.clientWidth + 1,
        modalFits: modalElement.scrollWidth <= modalElement.clientWidth + 1,
        openTarget: { width: openButton.width, height: openButton.height },
        closeTarget: { width: closeButton.width, height: closeButton.height },
      };
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.panelFits).toBe(true);
    expect(geometry.modalFits).toBe(true);
    expect(geometry.openTarget.height).toBeGreaterThanOrEqual(44);
    expect(geometry.closeTarget.height).toBeGreaterThanOrEqual(44);

    await page.locator('#btnCloseModal').tap();
    await expect(dialog).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('320px portrait layout and export sheet fit with touch-sized ranges', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForTaskSurface(page);

    const layout = await page.evaluate(() => {
      const panel = document.getElementById('panel');
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        panelLeft: panel.getBoundingClientRect().left,
        panelRight: panel.getBoundingClientRect().right,
        panelScrollWidth: panel.scrollWidth,
        panelClientWidth: panel.clientWidth,
        panelScrollTop: panel.scrollTop,
        primaryActionVisible: (() => {
          const button = document.getElementById('btnOpenExport').getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          return button.top >= panelRect.top && button.bottom <= panelRect.bottom;
        })(),
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.panelLeft).toBeGreaterThanOrEqual(0);
    expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.panelScrollWidth).toBeLessThanOrEqual(layout.panelClientWidth + 1);
    expect(layout.panelScrollTop).toBe(0);
    expect(layout.primaryActionVisible).toBe(true);

    const open = page.locator('#btnOpenExport');
    await open.tap();
    await expect(page.locator('#modalOverlay')).toBeVisible();

    const exportLayout = await page.evaluate(() => {
      const modal = document.querySelector('#modalOverlay .modal');
      const visibleRanges = [...document.querySelectorAll('input[type="range"]')]
        .map(input => ({ input, rect: input.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        modalScrollWidth: modal.scrollWidth,
        modalClientWidth: modal.clientWidth,
        rangeHeights: visibleRanges.map(({ rect }) => rect.height),
      };
    });
    expect(exportLayout.documentWidth).toBeLessThanOrEqual(exportLayout.viewportWidth);
    expect(exportLayout.modalScrollWidth).toBeLessThanOrEqual(exportLayout.modalClientWidth + 1);
    expect(exportLayout.rangeHeights.length).toBeGreaterThan(0);
    expect(Math.min(...exportLayout.rangeHeights)).toBeGreaterThanOrEqual(44);
  });
});
