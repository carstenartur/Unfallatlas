import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0&mapMode=standard';

test.describe('Nutzerseitige KI-Übergabe', () => {
  test('built application makes the analysis URL primary and keeps the graphics package optional', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
      window.UA?.getRuntimeContext?.()?.map &&
      window.UA?.aiProposal &&
      document.querySelector('#btnOpenExport')
    ), null, { timeout: 45_000 });

    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay')).toBeVisible();

    const linkButton = page.locator('#btnAiResearchLinkCopy');
    await expect(linkButton).toBeVisible({ timeout: 15_000 });
    await expect(linkButton).toContainText(/Analyse-Link/i);
    await expect(linkButton).toHaveAttribute('title', /reproduzierbarem Analyse-Link.*Daten-URLs/i);

    const packageButton = page.locator('#btnAiHandoffDownload');
    await expect(packageButton).toBeVisible();
    await expect(packageButton).toContainText(/Beleg-\/Offline-Paket/i);
    await expect(packageButton).toHaveAttribute('title', /optional.*Snapshot.*Karten.*SHA-256/i);

    await expect(page.locator('#btnAiPromptCopy')).toContainText(/Text-Snapshot/i);
    await expect(page.locator('#btnAiPromptDownloadMd')).toContainText(/Text-Snapshot/i);
    await expect(page.locator('#aiLinkHandoffNote')).toContainText(/Link zuerst/i);
    await expect(page.locator('#externalAiPromptPanel > div:first-child')).toContainText(/primär.*Analyse-Link/i);

    const runtime = await page.evaluate(() => ({
      packageReady: typeof window.UA?.aiHandoff?.generatePackage === 'function',
      linkReady: typeof window.UA?.aiLinkHandoff?.generateResearchHandoff === 'function',
      packageScripts: [...document.querySelectorAll('script[data-ua-ai-handoff]')]
        .map(script => script.getAttribute('src')),
      linkScripts: [...document.querySelectorAll('script[data-ua-ai-link-handoff]')]
        .map(script => script.getAttribute('src')),
    }));
    expect(runtime.packageReady).toBe(true);
    expect(runtime.linkReady).toBe(true);
    expect(runtime.packageScripts).toHaveLength(1);
    expect(runtime.linkScripts).toHaveLength(1);
    expect(runtime.packageScripts[0]).toMatch(/js\/ua\.ai_handoff\.js\?v=2026-08-15$/);
    expect(runtime.linkScripts[0]).toMatch(/js\/ua\.ai_link_handoff\.js\?v=2026-08-15$/);
  });
});
