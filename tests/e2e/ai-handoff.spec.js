import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0&mapMode=standard';

test.describe('Nutzerseitige KI-Übergabe', () => {
  test('built application exposes an official-evidence QA contract as the primary path', async ({ page }) => {
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
    await expect(linkButton).toContainText(/1\.\s+KI-Untersuchungsauftrag.*kopieren/i);
    await expect(linkButton).toHaveAttribute(
      'title',
      /Kopiert ausschließlich Phase 1.*Noch kein Antrag/i
    );

    await expect(page.locator('#btnAiPromptCopy')).toHaveCount(0);
    await expect(page.locator('#btnAiPromptDownloadMd')).toContainText(/1\.\s+Untersuchungsauftrag\s+\.md/i);
    await expect(page.locator('#btnAiFactsDownloadJson')).toContainText(/Untersuchungsdaten \+ Verträge .json/i);
    await expect(page.locator('#aiLinkHandoffNote'))
      .toContainText(/Link zuerst.*Amtliche.*polizeibasierte.*Tatsachenkern.*unabhängig prüfen/i);
    await expect(page.locator('#externalAiPromptPanel > div:first-child'))
      .toContainText(/Analyse-Link.*amtlichen.*Tatsachenkern.*Docker-Links.*PDF-\/Word-Export/i);
    await expect(page.locator('#btnAiHandoffDownload')).toHaveCount(0);

    const runtime = await page.evaluate(() => {
      const handoff = window.UA?.aiLinkHandoff;
      const internal = handoff?._internal;
      const ctx = window.UA?.getRuntimeContext?.();
      const analysisUrl = internal?.currentAnalysisUrl?.(window.UA, ctx) || '';
      const resources = internal?.researchResources?.(window.UA, 'Bonn', analysisUrl) || [];
      const structured = {
        meta: { city: 'Bonn', areaName: 'Browservertrag' },
        severity: { total: 3, bySev: { '1': 0, '2': 1, '3': 2 } },
        yearTable: [{ year: 2024, total: 3 }],
        crossTable: { totals: { total: 3, sev1: 0, sev2: 1, sev3: 2 } },
        accidentDetails: { total: 3, rows: [{}, {}, {}], truncated: false },
      };
      const evidence = handoff?.buildEvidenceContract?.(structured, analysisUrl);
      const prompt = handoff?.buildResearchPrompt?.({
        city: 'Bonn',
        analysisUrl,
        resources,
        facts: {
          city: 'Bonn',
          createdAt: '2026-08-15T00:00:00.000Z',
          structured,
          evidenceContract: evidence,
          qaContract: handoff?.buildQaContract?.(),
        },
      }) || '';
      return {
        linkReady: typeof handoff?.generateResearchHandoff === 'function',
        schemaVersion: handoff?.LINK_SCHEMA,
        linkScripts: [...document.querySelectorAll('script[data-ua-ai-link-handoff]')]
          .map(script => script.getAttribute('src')),
        analysisUrl,
        resources,
        officialSourceUrl: handoff?.OFFICIAL_UNFALLATLAS_URL,
        officialScopeUrl: handoff?.OFFICIAL_DESTATIS_URL,
        evidence,
        promptAudit: handoff?.auditResearchPrompt?.(prompt),
      };
    });

    expect(runtime.linkReady).toBe(true);
    expect(runtime.schemaVersion).toBe('unfallwerkbank.aiResearchHandoff.v2');
    expect(runtime.linkScripts).toHaveLength(1);
    expect(runtime.linkScripts[0]).toMatch(/js\/ua\.ai_link_handoff\.js\?v=2026-08-15$/);
    expect(runtime.analysisUrl).toMatch(/^https:\/\/carstenartur\.github\.io\/Unfallatlas\/werkbank_v2\.html\?/);
    expect(runtime.analysisUrl).toContain('city=Bonn');
    expect(runtime.analysisUrl).toContain('mapMode=standard');
    expect(runtime.analysisUrl).toContain('export=1');
    expect(runtime.resources).toHaveLength(6);
    expect(runtime.resources.every(resource => resource.preferredUrl.startsWith('https://carstenartur.github.io/Unfallatlas/out/'))).toBe(true);
    expect(runtime.resources.every(resource => resource.preferredUrl.endsWith('.gz'))).toBe(true);
    expect(runtime.officialSourceUrl).toBe('https://www.statistikportal.de/de/karten/unfallatlas');
    expect(runtime.officialScopeUrl).toMatch(/destatis\.de/);
    expect(runtime.evidence.primaryDataset.provenance).toMatch(/Meldungen der Polizeidienststellen/);
    expect(runtime.evidence.primaryDataset.scope).toMatch(/Unfälle mit Personenschaden.*Sachschadensunfälle/);
    expect(runtime.promptAudit.passed).toBe(true);
  });
});
