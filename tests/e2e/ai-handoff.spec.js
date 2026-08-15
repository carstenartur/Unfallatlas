import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0&mapMode=standard';

test.describe('Nutzerseitige KI-Übergabe', () => {
  test('built application exposes a public reproducible analysis URL as the primary path', async ({ page }) => {
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
    await expect(linkButton).toHaveAttribute('title', /öffentlich erreichbarem.*reproduzierbarem Analyse-Link.*Daten-URLs/i);

    await expect(page.locator('#btnAiPromptCopy')).toContainText(/Text-Snapshot/i);
    await expect(page.locator('#btnAiPromptDownloadMd')).toContainText(/Text-Snapshot/i);
    await expect(page.locator('#aiLinkHandoffNote')).toContainText(/Link zuerst.*öffentlich erreichbare/i);
    await expect(page.locator('#externalAiPromptPanel > div:first-child')).toContainText(/Analyse-Link.*Docker-Links.*PDF-\/Word-Export/i);
    await expect(page.locator('#btnAiHandoffDownload')).toHaveCount(0);

    const runtime = await page.evaluate(() => {
      const internal = window.UA?.aiLinkHandoff?._internal;
      const ctx = window.UA?.getRuntimeContext?.();
      const analysisUrl = internal?.currentAnalysisUrl?.(window.UA, ctx) || '';
      const resources = internal?.researchResources?.(window.UA, 'Bonn', analysisUrl) || [];
      return {
        linkReady: typeof window.UA?.aiLinkHandoff?.generateResearchHandoff === 'function',
        linkScripts: [...document.querySelectorAll('script[data-ua-ai-link-handoff]')]
          .map(script => script.getAttribute('src')),
        analysisUrl,
        resources,
      };
    });

    expect(runtime.linkReady).toBe(true);
    expect(runtime.linkScripts).toHaveLength(1);
    expect(runtime.linkScripts[0]).toMatch(/js\/ua\.ai_link_handoff\.js\?v=2026-08-15$/);
    expect(runtime.analysisUrl).toMatch(/^https:\/\/carstenartur\.github\.io\/Unfallatlas\/werkbank_v2\.html\?/);
    expect(runtime.analysisUrl).toContain('city=Bonn');
    expect(runtime.analysisUrl).toContain('mapMode=standard');
    expect(runtime.analysisUrl).toContain('export=1');
    expect(runtime.resources).toHaveLength(6);
    expect(runtime.resources.every(resource => resource.preferredUrl.startsWith('https://carstenartur.github.io/Unfallatlas/out/'))).toBe(true);
    expect(runtime.resources.every(resource => resource.preferredUrl.endsWith('.gz'))).toBe(true);
  });
});
