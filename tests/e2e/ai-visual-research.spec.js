import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0&mapMode=standard&includeCyclist=1&includeCar=1&involvementMode=and';

test.describe('Semantische Karten- und Unfallhintergrundrecherche', () => {
  test('upgrades the user-owned AI handoff beyond map completeness checks', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
      window.UA?.getRuntimeContext?.()?.map
      && window.UA?.aiLinkHandoff
      && window.UA?.aiVisualResearch
      && document.querySelector('#btnOpenExport')
    ), null, { timeout: 45_000 });

    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay')).toBeVisible();
    await expect(page.locator('#btnAiResearchLinkCopy'))
      .toHaveAttribute('data-ua-visual-research', '1', { timeout: 15_000 });
    await expect(page.locator('#aiLinkHandoffNote'))
      .toContainText(/Schienen.*Kurven.*querende Bewegungen.*Unfallhintergrundrecherche/i);

    const runtime = await page.evaluate(() => {
      const ctx = window.UA.getRuntimeContext();
      const analysisUrl = window.UA.aiLinkHandoff._internal.currentAnalysisUrl(window.UA, ctx);
      const api = window.UA.aiVisualResearch;
      const views = api.buildInspectionViews(analysisUrl);
      const visual = api.buildVisualSceneAnalysisContract(views);
      const background = api.buildAccidentBackgroundResearchContract({
        city: 'Bonn',
        structured: {
          meta: {
            city: 'Bonn',
            areaName: 'Bonn Hauptbahnhof',
            filters: { involvement: 'Radverkehr UND Pkw' },
          },
        },
      });
      const enhanced = api.enhanceHandoff({
        schemaVersion: 'unfallwerkbank.aiResearchHandoff.v2',
        city: 'Bonn',
        analysisUrl,
        facts: {
          city: 'Bonn',
          structured: { meta: { city: 'Bonn', areaName: 'Bonn Hauptbahnhof' } },
        },
        promptAudit: { passed: true, missingMarkers: [] },
        prompt: '# Basisauftrag\nQA-Urteil und Evidenzmatrix',
      });
      return {
        scriptSources: [...document.querySelectorAll('script[data-ua-ai-visual-research]')]
          .map(script => script.getAttribute('src')),
        views,
        visual,
        background,
        enhancedSchema: enhanced.schemaVersion,
        enhancedAudit: enhanced.visualResearchPromptAudit,
        enhancedPrompt: enhanced.prompt,
      };
    });

    expect(runtime.scriptSources).toHaveLength(1);
    expect(runtime.scriptSources[0]).toMatch(/js\/ua\.ai_visual_research\.js\?v=2026-08-16$/);
    expect(runtime.views.map(view => view.mapMode)).toEqual([
      'standard', 'hybrid', 'orthophoto', 'analysis',
    ]);
    expect(runtime.views.every(view => !new URL(view.url).searchParams.has('export'))).toBe(true);
    expect(runtime.visual.requiredFeatureClasses.map(item => item.id)).toEqual(expect.arrayContaining([
      'rails-and-track-interface',
      'curvature-and-deflection',
      'walking-cycling-motor-crossings',
      'surface-and-drainage',
    ]));
    expect(runtime.background.sourcePriority[0].sourceType)
      .toBe('official-police-or-fire-service');
    expect(runtime.background.spatialMatchClasses.map(item => item.id)).toEqual([
      'inside-selection',
      'immediate-adjacency',
      'citywide-analogue',
      'unknown-or-unrelated',
    ]);
    expect(runtime.enhancedSchema).toBe('unfallwerkbank.aiResearchHandoff.v3');
    expect(runtime.enhancedAudit.passed).toBe(true);
    expect(runtime.enhancedPrompt).toContain('SEMANTISCHE KARTENINTERPRETATION');
    expect(runtime.enhancedPrompt).toContain('UNFALLHINTERGRUNDRECHERCHE');
    expect(runtime.enhancedPrompt).toContain('Kopfsteinpflaster');
  });
});
