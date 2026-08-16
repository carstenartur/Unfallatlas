import { test, expect } from '@playwright/test';

const APP = '/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1'
  + '&includeMotorcycle=0&includeGkfz=0&includeSonstig=0&involvementMode=and'
  + '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23'
  + '&centerLat=50.7330&centerLon=7.0950&zoom=15'
  + '&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000';

test('discovery filters stay a subset of a complete numbered application-evidence cohort', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(
    window.UA?.getRuntimeContext?.()?.allPts?.length
      && window.UA?.EvidenceCohort
      && window.UA?.computeExportReport
      && document.querySelector('#btnOpenExport')
  ), null, { timeout: 60_000 });

  await page.locator('#btnOpenExport').click();
  await expect(page.locator('#modalOverlay')).toBeVisible();
  await expect(page.locator('#evidenceCohortPanel')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#btnEvidenceNumberedMap')).toBeVisible();
  await expect(page.locator('#btnEvidencePdf')).toBeVisible();
  await expect(page.locator('#btnEvidenceCsv')).toBeVisible();
  await expect(page.locator('#btnEvidenceGeoJson')).toBeVisible();

  const evidence = await page.evaluate(async () => {
    const ctx = window.UA.getRuntimeContext();
    const report = await window.UA.computeExportReport(ctx);
    const cohorts = report.structured.evidenceCohorts;
    const appendix = report.structured.accidentEvidenceAppendix;
    const contract = report.structured.evidenceCohortContract;
    return {
      schemaVersion: cohorts?.schemaVersion,
      status: cohorts?.status,
      discoveryCount: cohorts?.discoveryCohort?.count,
      completeCount: cohorts?.completeEvidenceCohort?.count,
      discoveryIds: cohorts?.discoveryCohort?.accidentIds,
      completeIds: cohorts?.completeEvidenceCohort?.accidentIds,
      discoveryIsSubset: cohorts?.relationship?.discoveryIsSubset,
      additional: cohorts?.relationship?.additionallyConsideredCount,
      ids: appendix?.rows?.map(row => row.displayId),
      truncated: appendix?.truncated,
      numberedMapUrl: cohorts?.numberedMapUrl,
      filingRule: contract?.filingEvidenceRule,
      methodLines: report.structured.methodikScope?.lines || [],
      htmlHasAppendix: /data-ua-evidence-appendix/.test(report.html || ''),
    };
  });

  expect(evidence.schemaVersion).toBe('unfallwerkbank.evidenceCohorts.v1');
  expect(evidence.status).toBe('complete');
  expect(evidence.completeCount).toBeGreaterThan(0);
  expect(evidence.completeCount).toBeGreaterThanOrEqual(evidence.discoveryCount);
  expect(evidence.discoveryIsSubset).toBe(true);
  expect(evidence.additional).toBe(evidence.completeCount - evidence.discoveryCount);
  expect(evidence.completeIds).toHaveLength(evidence.completeCount);
  expect(evidence.ids).toEqual(evidence.completeIds);
  expect(evidence.ids.every(id => /^A\d{3,}$/.test(id))).toBe(true);
  expect(evidence.truncated).toBe(false);
  expect(evidence.numberedMapUrl).toContain('evidenceLabels=1');
  expect(evidence.filingRule).toMatch(/alle Unfälle.*completeEvidenceCohort/i);
  expect(evidence.methodLines.join(' ')).toMatch(/Suchfilter begrenzen diese Menge nicht/i);
  expect(evidence.htmlHasAppendix).toBe(true);
});
