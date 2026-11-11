import { test, expect } from '@playwright/test';

test('a single-year site selection opens its area draft and returns keyboard focus on a phone-sized map', async ({ page, baseURL }) => {
  test.setTimeout(150000);
  await page.setViewportSize({ width: 390, height: 844 });
  const origin = new URL(baseURL).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
  await page.goto('/werkbank_v2.html?city=Hannover', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.UA?.getRuntimeContext?.()?.accidentDataCoverage?.complete
    && !window.UA.isHydrating(), null, { timeout: 90000 });

  const panelToggle = page.locator('#collapseBtn');
  if (await panelToggle.getAttribute('aria-expanded') === 'false') await panelToggle.click();
  await page.getByRole('button', { name: 'Stellen finden' }).click();
  await expect(page.locator('#siteDiscoveryMode')).toHaveValue('network', { timeout: 30000 });
  await page.locator('#siteDiscoveryFromYear').selectOption('2025');
  await page.locator('#siteDiscoveryToYear').selectOption('2025');
  const candidate = page.getByRole('list', { name: 'Gefundene Netzstellen' }).getByRole('button').first();
  await candidate.click();

  const detail = page.locator('.site-discovery-detail');
  const name = await detail.getByRole('heading').innerText();
  await expect(candidate).toContainText(name);
  await expect(detail).toContainText('kein wiederkehrendes Muster');
  const draft = detail.getByRole('button', { name: 'Antragsentwurf für den markierten Bereich öffnen' });
  await expect(draft).toBeVisible();
  await draft.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: /./ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#noSelectionHint')).toBeHidden();
  await expect(dialog.locator('#exportProgress')).toHaveText('Fertig.', { timeout: 30000 });
  await expect(dialog.locator('#exportHtml')).toContainText(name);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(draft).toBeFocused();
});
