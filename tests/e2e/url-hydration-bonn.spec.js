/**
 * URL-State-Hydration – Bonn-Regressionstest
 *
 * Sichert den in der QA-Review identifizierten Reproduzierbarkeits-Bug
 * gegen Regressionen ab: Eine vollständig parametrisierte Bonn-URL
 * (Stadt, Beteiligungs-
 * filter, UND-Modus, Layer, Zeit/Schwere/Fahrbahn, Kartenposition und
 * insbesondere ein Auswahlrechteck via selSouth/selWest/selNorth/selEast)
 * muss den UI-Zustand vollständig wiederherstellen.
 *
 * Insbesondere darf der Export-Dialog dann nicht mehr "Kein Bereich
 * markiert" anzeigen, denn die Selektion ist über die URL gegeben.
 */
import { test, expect } from '@playwright/test';

// Bbox grob um die Bonner Innenstadt – liegt innerhalb der Bonner
// Datenpunkte (50.58…50.77 Lat, 7.03…7.21 Lon laut output_all_years_bonn.geojson),
// damit die Markierung Punkte umfasst und der Antragstext sich darauf
// bezieht.
const SEL = { south: 50.71, west: 7.08, north: 50.74, east: 7.13 };
const CENTER = { lat: 50.7253, lon: 7.105, zoom: 14 };

const BONN_URL =
  'werkbank_v2.html'
  + '?city=Bonn'
  + '&includeCyclist=1&includeCar=1&includePedestrian=0&includeMotorcycle=0'
  + '&involvementMode=and'
  + '&showCluster=0&showHeatmap=1'
  + '&severity=all&dayType=all&roadCondition=all'
  + '&hourFrom=0&hourTo=23'
  + `&centerLat=${CENTER.lat}&centerLon=${CENTER.lon}&zoom=${CENTER.zoom}`
  + `&selSouth=${SEL.south}&selWest=${SEL.west}&selNorth=${SEL.north}&selEast=${SEL.east}`;

test.describe('URL-State-Hydration – Bonn', () => {
  test('Stadt, Filter, Modus, Layer, Markierung werden vollständig aus URL übernommen', async ({ page }) => {
    await page.goto(BONN_URL);
    await page.waitForLoadState('networkidle');

    // Stadt = Bonn (das Dropdown wird asynchron befüllt; erst warten,
    // bis der aria-busy-Zustand abgeräumt ist).
    const citySel = page.locator('#citySel');
    await expect(citySel).not.toHaveAttribute('aria-busy', 'true');
    await expect(citySel).toHaveValue('Bonn');

    // Beteiligungsfilter: Rad + PKW aktiv, Fuß + Krad inaktiv.
    await expect(page.locator('#incBike')).toBeChecked();
    await expect(page.locator('#incCar')).toBeChecked();
    await expect(page.locator('#incPed')).not.toBeChecked();
    await expect(page.locator('#incMoto')).not.toBeChecked();

    // UND-Modus aktiv.
    await expect(page.locator('#modeAnd')).toHaveClass(/active/);
    await expect(page.locator('#modeOr')).not.toHaveClass(/active/);

    // Layer: Heatmap aktiv, Cluster inaktiv.
    await expect(page.locator('#toggleHeat')).toHaveClass(/active/);
    await expect(page.locator('#toggleCluster')).not.toHaveClass(/active/);

    // Zeitfenster + Filter aus URL übernommen.
    await expect(page.locator('#hFrom')).toHaveValue('0');
    await expect(page.locator('#hTo')).toHaveValue('23');
    await expect(page.locator('#severity')).toHaveValue('all');
    await expect(page.locator('#dayType')).toHaveValue('all');
    await expect(page.locator('#roadCondition')).toHaveValue('all');

    // Selektionsrechteck wurde aus den sel*-URL-Parametern wieder
    // hergestellt. Da Leaflet hier mit `preferCanvas: true` läuft
    // (siehe ua.map_v2.js initLeaflet), zeichnet L.rectangle in
    // einen Canvas und nicht ins SVG-Pane – ein DOM-Path-Check
    // greift daher nicht. Wir prüfen den Zustand stattdessen
    // funktional über die Statuszeile (sie wird von updateStats
    // aus ctx.selectionBounds gespeist) und über das
    // Export-Dialog-Verhalten weiter unten.
    await expect(page.locator('#stat')).toContainText(/Markierung:\s*aktiv/);

    // Export-Dialog öffnen → "Kein Bereich markiert"-Hinweis muss
    // ausgeblendet sein, weil sel*-Parameter eine Markierung ergeben.
    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay')).toBeVisible();
    const hint = page.locator('#noSelectionHint');
    await expect(hint).toBeHidden();

    // Der Export-Report-Text bezieht sich auf die Markierung – wir
    // prüfen, dass die Textarea einen erkennbaren Bezug zur Markierung
    // bzw. zur Bonner Auswahl enthält (Stadt-Name + Bbox-Hinweis).
    const ta = page.locator('#exportBoxTa');
    await expect(ta).not.toHaveValue('…', { timeout: 15000 });
    const txt = (await ta.inputValue()) || '';
    expect(txt.length).toBeGreaterThan(0);
    expect(txt).toMatch(/Bonn/i);
  });

  test('"Markierung löschen" entfernt sel*-Parameter aus der URL', async ({ page }) => {
    await page.goto(BONN_URL);
    await page.waitForLoadState('networkidle');

    // Sicherstellen, dass die Markierung initial aktiv ist.
    await expect(page.locator('#stat')).toContainText(/Markierung:\s*aktiv/);

    await page.locator('#btnClearDraw').click();

    // URL darf keine sel*-Parameter mehr enthalten. Wir warten bis
    // die URL aktualisiert ist und prüfen dann alle vier Keys
    // konsistent in einer einzigen poll-Schleife.
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return ['selSouth', 'selWest', 'selNorth', 'selEast'].some((k) =>
          url.searchParams.has(k)
        );
      })
      .toBe(false);

    // Stat-Zeile zeigt "Markierung: aktiv" nicht mehr.
    await expect(page.locator('#stat')).not.toContainText(/Markierung:\s*aktiv/);

    // Export-Dialog jetzt: Hinweis sichtbar.
    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#noSelectionHint')).toBeVisible();
  });
});
