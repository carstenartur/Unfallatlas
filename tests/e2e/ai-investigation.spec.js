import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0&mapMode=standard';

test('AI application drafting is gated by a locally validated investigation result', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(
    window.UA?.getRuntimeContext?.()?.map
      && window.UA?.aiInvestigation
      && document.querySelector('#btnOpenExport')
  ), null, { timeout: 45_000 });

  await page.locator('#btnOpenExport').click();
  await expect(page.locator('#modalOverlay')).toBeVisible();

  await expect(page.locator('#btnAiResearchLinkCopy'))
    .toContainText(/1\. KI-Untersuchungsauftrag/i);
  await expect(page.locator('#aiInvestigationWorkflow')).toBeVisible();
  await expect(page.locator('#aiInvestigationResultInput')).toBeVisible();
  await expect(page.locator('#btnAiValidateInvestigation')).toBeEnabled();
  await expect(page.locator('#btnAiApplicationPromptCopy')).toBeDisabled();

  const contract = await page.evaluate(() => {
    const api = window.UA.aiInvestigation;
    const prompt = api.buildInvestigationPrompt({
      city: 'Bonn',
      analysisUrl: window.location.href,
      facts: {
        city: 'Bonn',
        deterministicAnalysisDigest: {
          officialAccidentFacts: { total: 3, fatal: 0, serious: 1, slight: 2, other: 0 },
        },
        structured: {
          severity: { total: 3, bySev: { '1': 0, '2': 1, '3': 2, other: 0 } },
          patternDetection: { findings: [] },
        },
      },
      visualInspectionViews: ['standard', 'hybrid', 'orthophoto', 'analysis'].map(mapMode => ({
        id: mapMode, label: mapMode, mapMode,
        url: `${window.location.origin}${window.location.pathname}?mapMode=${mapMode}`,
      })),
    });
    return {
      resultSchema: api.INVESTIGATION_RESULT_SCHEMA,
      applicationSchema: api.APPLICATION_REQUEST_SCHEMA,
      requiredModes: api.REQUIRED_MAP_MODES,
      forbidsPrematureApplication: prompt.includes('Erstelle in dieser Phase keinen Antrag'),
      asksForJsonOnly: prompt.includes('Antworte ausschließlich mit einem JSON-Objekt'),
    };
  });

  expect(contract.resultSchema).toBe('unfallwerkbank.aiInvestigationResult.v1');
  expect(contract.applicationSchema).toBe('unfallwerkbank.aiApplicationRequest.v1');
  expect(contract.requiredModes).toEqual(['standard', 'hybrid', 'orthophoto', 'analysis']);
  expect(contract.forbidsPrematureApplication).toBe(true);
  expect(contract.asksForJsonOnly).toBe(true);
});
