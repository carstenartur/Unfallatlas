import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0';

test.describe('Nutzerseitige KI-Übergabe', () => {
  test('built application labels text-only export honestly and loads the graphics package action', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
      window.UA?.getRuntimeContext?.()?.map &&
      window.UA?.aiProposal &&
      document.querySelector('#btnOpenExport')
    ), null, { timeout: 45_000 });

    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay')).toBeVisible();

    const packageButton = page.locator('#btnAiHandoffDownload');
    await expect(packageButton).toBeVisible({ timeout: 15_000 });
    await expect(packageButton).toContainText(/KI-Medienpaket mit Grafiken/i);
    await expect(packageButton).toHaveAttribute('title', /Karten.*Grafiken.*SHA-256/i);

    await expect(page.locator('#btnAiPromptCopy')).toContainText(/ohne Grafiken/i);
    await expect(page.locator('#btnAiPromptDownloadMd')).toContainText(/Text-Prompt/i);
    await expect(page.locator('#aiHandoffCompletenessNote')).toContainText(/keine Bilddateien/i);

    const runtime = await page.evaluate(() => ({
      moduleReady: typeof window.UA?.aiHandoff?.generatePackage === 'function',
      injectedScripts: [...document.querySelectorAll('script[data-ua-ai-handoff]')]
        .map(script => script.getAttribute('src')),
    }));
    expect(runtime.moduleReady).toBe(true);
    expect(runtime.injectedScripts).toHaveLength(1);
    expect(runtime.injectedScripts[0]).toMatch(/js\/ua\.ai_handoff\.js\?v=2026-08-15$/);
  });
});
