/**
 * QA-Härtungs-E2E-Tests für die Unfallwerkbank-Webseite.
 *
 * Diese Suite ergänzt die bestehenden Smoke-Tests um die in der QA-Review
 * geforderten Punkte: Ladezustand, Nutzerführung, Export-Gruppierung,
 * politische Recherche, Tour, Mobile-Smoke. Die Tests prüfen sichtbares
 * Verhalten auf der ausgelieferten `werkbank_v2.html`, ohne die JS-Logik
 * der App zu mocken — das deckt sowohl die HTML-Struktur als auch das
 * korrekte Wiring der UI-Module mit ab.
 *
 * URLs werden ohne führenden Slash angegeben, damit ein `baseURL` mit
 * Pfad-Präfix (z. B. GitHub Pages) erhalten bleibt — wie in den anderen
 * Suites.
 */

import { test, expect } from '@playwright/test';

const APP = 'werkbank_v2.html';

test.describe('QA-Härtung – Ladezustand', () => {
  test('keine Dauer-Platzhalter („Quelle: -", „Build: -", „Stadt Lade…") nach Load sichtbar', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    // Die Meta-Info-Box ist hidden, solange kein echter Build/Quelle
    // gesetzt ist. Im statischen Test-Mode ohne UA.BUILD bleibt sie
    // hidden, statt einen „-"-Platzhalter zu zeigen.
    const metaBox = page.locator('#metaInfoBox');
    if (await metaBox.count()) {
      const visible = await metaBox.isVisible();
      if (visible) {
        // Wenn sichtbar, dann müssen *beide* Werte echt sein.
        const src = (await page.locator('#dataSourceCode').textContent() || '').trim();
        const build = (await page.locator('#buildInfo').textContent() || '').trim();
        expect(src).not.toBe('');
        expect(src).not.toBe('-');
        expect(build).not.toBe('');
        expect(build).not.toBe('-');
      }
    }

    // Stadt-Dropdown darf nicht dauerhaft den Lade-Zustand zeigen.
    const cityBusy = await page.locator('#citySel').getAttribute('aria-busy');
    expect(cityBusy).not.toBe('true');
  });

  test('Stadt-Dropdown wird befüllt ODER zeigt erkennbaren Fehlerzustand', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    const citySelect = page.locator('#citySel');
    await expect(citySelect).toBeVisible();

    const optionCount = await citySelect.locator('option').count();
    if (optionCount > 1) {
      // Erfolgsfall — mindestens 1 echte Stadt + ggf. Lade-Option entfernt.
      expect(optionCount).toBeGreaterThan(1);
    } else {
      // Fehlerzustand muss sichtbar kommuniziert sein.
      const stat = (await page.locator('#stat').textContent() || '').trim();
      expect(stat.length).toBeGreaterThan(0);
      expect(stat.toLowerCase()).toMatch(/laden|nicht|fehler|quelle/);
    }
  });
});

test.describe('QA-Härtung – Nutzerführung', () => {
  test('3-Schritte-Einstieg ist prominent sichtbar', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    const hint = page.locator('#quickStartHint');
    await expect(hint).toBeVisible();
    const txt = await hint.textContent();
    expect(txt).toMatch(/Stadt wählen/);
    expect(txt).toMatch(/Bereich markieren/);
    expect(txt).toMatch(/Antrag exportieren/);
  });

  test('Erweiterte Einstellungen (Viewport-Puffer, Heat-Radius) sind einklappbar', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    const adv = page.locator('#advancedSettings');
    await expect(adv).toBeVisible();
    // <details> ist standardmäßig zu — Inputs sind im DOM, aber nicht
    // in der ungefalteten Sicht.
    const isOpen = await adv.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open);
    expect(isOpen).toBe(false);

    // Auf die Summary klicken öffnet das Panel und macht die Inputs
    // sichtbar.
    await adv.locator('summary').click();
    await expect(page.locator('#viewportPaddingPct')).toBeVisible();
    await expect(page.locator('#heatRadius')).toBeVisible();
    await expect(page.locator('#maxPoints')).toBeVisible();
  });
});

test.describe('QA-Härtung – Filter sind bedienbar', () => {
  test('Schweregrad, Beteiligung, Zeit und Fahrbahnzustand reagieren auf Eingaben', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    // Schweregrad
    await page.locator('#severity').selectOption('1');
    await expect(page.locator('#severity')).toHaveValue('1');

    // Beteiligung (Chip-Toggle)
    const motoChip = page.locator('#incMoto');
    const before = await motoChip.isChecked();
    await motoChip.click({ force: true });
    await expect(motoChip).toBeChecked({ checked: !before });

    // Uhrzeit-Slider („von" hochziehen ändert Label)
    await page.locator('#hFrom').fill('8');
    await expect(page.locator('#hFromLbl')).toHaveText('8');

    // Fahrbahnzustand
    await page.locator('#roadCondition').selectOption('1');
    await expect(page.locator('#roadCondition')).toHaveValue('1');
  });
});

test.describe('QA-Härtung – Export-Dialog', () => {
  test('Export-Dialog öffnet, Optionen sind gruppiert, primäre Word/PDF-Aktion ist sichtbar', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay')).toBeVisible();

    // Primärgruppe „Antrag" ist sichtbar — mit beiden Knöpfen.
    const groupAntrag = page.locator('#exportGroupAntrag');
    await expect(groupAntrag).toBeVisible();
    await expect(groupAntrag.locator('#btnExportWord')).toBeVisible();
    await expect(groupAntrag.locator('#btnExportPDF')).toBeVisible();
    // Beschriftung muss den Antrag-Charakter klar machen.
    await expect(groupAntrag.locator('#btnExportWord')).toContainText(/Antrag/);
    await expect(groupAntrag.locator('#btnExportPDF')).toContainText(/Antrag/);

    // Sekundärgruppe „Datenexport" sichtbar.
    const groupData = page.locator('#exportGroupData');
    await expect(groupData).toBeVisible();
    await expect(groupData.locator('#btnExportCSV')).toBeVisible();
    await expect(groupData.locator('#btnExportGeoJSON')).toBeVisible();
    await expect(groupData.locator('#btnExportKML')).toBeVisible();

    // Zusatzanalysen-Gruppe (Antragsentwurf) sichtbar — KI-Hinweis vorhanden.
    const groupExtras = page.locator('#aiProposalSection');
    await expect(groupExtras).toBeVisible();
    await expect(groupExtras.locator('#btnAiProposal')).toContainText(/Antragsentwurf/);
  });

  test('Hinweisbanner „kein Bereich markiert" erscheint bei Default-Zustand', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    await page.locator('#btnOpenExport').click();
    const hint = page.locator('#noSelectionHint');
    // Im Default ist keine selectionBounds gesetzt → Hinweis sichtbar.
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/aktuelle.*Kartenausschnitt/i);
    await expect(hint).toContainText(/Bereich markieren/);
  });
});

test.describe('QA-Härtung – Politische Recherche', () => {
  test('Dialog öffnet und zeigt klaren Mehrwert + Lade/Leer/Fehler-Slot', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    await page.locator('#btnPolCtxOpen').click();
    const panel = page.locator('#polCtxPanel');
    await expect(panel).toBeVisible();
    // Mehrwert-Erklärung im Panel-Text.
    await expect(panel).toContainText(/Anträg|Beschlüsse|Verwaltungsantworten/);
    // Status-Container für Lade/Leer/Fehler ist im DOM.
    await expect(panel.locator('#polCtxStatus')).toHaveCount(1);
    await expect(panel.locator('#polCtxResults')).toHaveCount(1);
    // Dialog wieder schließen, damit nachfolgende Tests sauber starten.
    await page.locator('#polCtxBtnClose').click();
    await expect(panel).toBeHidden();
  });
});

test.describe('QA-Härtung – Geführte Tour', () => {
  test('„Tour starten" öffnet das Tour-Banner mit verständlichen Bedienelementen', async ({ page }) => {
    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    const startBtn = page.locator('#tourBtnStart');
    if (!(await startBtn.isVisible())) {
      test.skip(true, 'Tour-Button nicht im DOM (Modul nicht geladen)');
    }

    await startBtn.click();
    const overlay = page.locator('#tourOverlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });
    // Bedienelemente: Vor/Zurück/Stop sind erreichbar.
    await expect(overlay.locator('#tourBtnPrev')).toBeVisible();
    await expect(overlay.locator('#tourBtnNext')).toBeVisible();
    await expect(overlay.locator('#tourBtnStop')).toBeVisible();

    // Aufräumen
    await overlay.locator('#tourBtnStop').click();
  });
});

test.describe('QA-Härtung – Mobile Smoke', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Werkbank rendert auf 390 px Viewport ohne JS-Fehler und Filter sind erreichbar', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(APP);
    await page.waitForLoadState('networkidle');

    // Panel-Header sichtbar.
    await expect(page.locator('.panelTitle')).toBeVisible();
    // Schweregrad-Filter erreichbar (auch wenn Panel kleiner ist).
    await expect(page.locator('#severity')).toBeVisible();
    // Quick-Start-Hinweis ist auch auf Mobile sinnvoll sichtbar.
    await expect(page.locator('#quickStartHint')).toBeVisible();

    expect(errors, `pageerror events:\n${errors.join('\n')}`).toHaveLength(0);
  });
});
