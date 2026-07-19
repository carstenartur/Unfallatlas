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

    // Runtime integrations (video client/headless verifier) consume the same
    // closure-owned context through a single immutable port. Prove this in a
    // real browser instead of relying only on server mocks.
    const runtime = await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(window.UA || {}, 'getRuntimeContext');
      const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
        ? window.UA.getRuntimeContext()
        : null;
      return {
        contextAvailable: Boolean(ctx),
        mapIdentity: Boolean(ctx && ctx.map === window._uaMap),
        selectionAvailable: Boolean(ctx && ctx.selectionBounds),
        writable: descriptor && descriptor.writable,
        configurable: descriptor && descriptor.configurable,
      };
    });
    expect(runtime).toEqual({
      contextAvailable: true,
      mapIdentity: true,
      selectionAvailable: true,
      writable: false,
      configurable: false,
    });

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

/**
 * QA-Härtung „Deterministische URL-State-Initialisierung":
 * - Reihenfolge: Daten zuerst → URL anwenden
 * - Idempotenz: gleiche URL → identischer Zustand und identische URL
 *               (auch nach mehrfachem Reload)
 * - Bidirektionale Synchronisation: UI-Änderungen schreiben zurück in
 *               die URL (URL = Source of Truth)
 */
test.describe('URL-State-Hydration – Determinismus', () => {
  // Helfer: liest die kanonisch sortierten URL-Parameter als Map. Da
  // die App in `cleanUrlIfNeeded`/`buildSearch` die Reihenfolge der
  // Parameter normalisiert, vergleichen wir Map-Inhalte statt
  // String-Identität – das ist robuster gegen kosmetische Diffs.
  async function paramsOf(page) {
    const u = new URL(page.url());
    const out = {};
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
    return out;
  }

  test('mapLayer + ctxSlope bleiben beim ersten Load und nach Reload stabil (idempotent)', async ({ page }) => {
    const url = 'werkbank_v2.html?city=Bonn&mapLayer=slope,traffic&ctxSlope=steep,very_steep';
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');

    // Gate: only test overlay features when Bonn data has slope/traffic fields
    const baseUrl = new URL(page.url());
    const dataUrl = new URL('out/output_all_years_bonn.geojson.gz', baseUrl).toString();
    const geojson = await page.evaluate(async (url) => {
      if (!window.UA || typeof window.UA.fetchJsonCompressed !== 'function') {
        throw new Error('UA.fetchJsonCompressed not available');
      }
      return window.UA.fetchJsonCompressed(url, { gzipOnly: true });
    }, dataUrl);
    expect(Array.isArray(geojson?.features)).toBe(true);
    expect(geojson.features.length, 'Bonn GeoJSON unexpectedly contains no accident data').toBeGreaterThan(0);
    const props = geojson.features[0]?.properties || {};
    const hasOverlay = 'slope_percent' in props || 'slope_abs_percent' in props || 'slope_class' in props ||
                       'slope_source' in props || 'slope_confidence' in props || 'traffic_proxy_class' in props;
    test.skip(!hasOverlay, 'Bonn GeoJSON not enriched with slope/traffic fields — overlay features not expected');

    await expect.poll(() => new URL(page.url()).searchParams.get('centerLat')).not.toBeNull();

    await expect(page.locator('#ctxOverlay_slope')).toBeChecked();
    await expect(page.locator('#ctxOverlay_traffic')).toBeChecked();
    await expect(page.locator('[data-ctx-slope="steep"]')).toBeChecked();
    await expect(page.locator('[data-ctx-slope="very_steep"]')).toBeChecked();

    const urlA = await paramsOf(page);
    const overlaysA = await page.evaluate(() => ({
      slope: document.getElementById('ctxOverlay_slope')?.checked || false,
      traffic: document.getElementById('ctxOverlay_traffic')?.checked || false,
    }));

    expect(urlA.city).toBe('Bonn');
    expect(urlA.mapLayer).toBe('slope,traffic');
    expect(urlA.ctxSlope).toBe('steep,very_steep');
    const stableA = page.url();
    await page.waitForTimeout(300);
    expect(page.url()).toBe(stableA);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');

    await expect(page.locator('#ctxOverlay_slope')).toBeChecked();
    await expect(page.locator('#ctxOverlay_traffic')).toBeChecked();
    await expect(page.locator('[data-ctx-slope="steep"]')).toBeChecked();
    await expect(page.locator('[data-ctx-slope="very_steep"]')).toBeChecked();

    const urlB = await paramsOf(page);
    const overlaysB = await page.evaluate(() => ({
      slope: document.getElementById('ctxOverlay_slope')?.checked || false,
      traffic: document.getElementById('ctxOverlay_traffic')?.checked || false,
    }));
    expect(urlB).toEqual(urlA);
    expect(overlaysB).toEqual(overlaysA);
  });

  test('zwei aufeinanderfolgende Reloads ergeben denselben URL- und UI-Zustand', async ({ page }) => {
    await page.goto(BONN_URL);
    await page.waitForLoadState('networkidle');
    // Stabilisieren: warten, bis das Stadt-Dropdown hydratisiert ist.
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');

    const urlA = await paramsOf(page);
    // Beobachtbare UI-Anker, an denen wir Zustands-Identität messen:
    const checkedA = await page.evaluate(() => ({
      bike: document.getElementById('incBike').checked,
      car:  document.getElementById('incCar').checked,
      ped:  document.getElementById('incPed').checked,
      moto: document.getElementById('incMoto').checked,
      modeAnd: document.getElementById('modeAnd').classList.contains('active'),
      heat: document.getElementById('toggleHeat').classList.contains('active'),
      cluster: document.getElementById('toggleCluster').classList.contains('active'),
      severity: document.getElementById('severity').value,
      hFrom: document.getElementById('hFrom').value,
      hTo:   document.getElementById('hTo').value,
      city:  document.getElementById('citySel').value
    }));

    // 1. Reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');
    const urlB = await paramsOf(page);
    const checkedB = await page.evaluate(() => ({
      bike: document.getElementById('incBike').checked,
      car:  document.getElementById('incCar').checked,
      ped:  document.getElementById('incPed').checked,
      moto: document.getElementById('incMoto').checked,
      modeAnd: document.getElementById('modeAnd').classList.contains('active'),
      heat: document.getElementById('toggleHeat').classList.contains('active'),
      cluster: document.getElementById('toggleCluster').classList.contains('active'),
      severity: document.getElementById('severity').value,
      hFrom: document.getElementById('hFrom').value,
      hTo:   document.getElementById('hTo').value,
      city:  document.getElementById('citySel').value
    }));

    // 2. Reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');
    const urlC = await paramsOf(page);
    const checkedC = await page.evaluate(() => ({
      bike: document.getElementById('incBike').checked,
      car:  document.getElementById('incCar').checked,
      ped:  document.getElementById('incPed').checked,
      moto: document.getElementById('incMoto').checked,
      modeAnd: document.getElementById('modeAnd').classList.contains('active'),
      heat: document.getElementById('toggleHeat').classList.contains('active'),
      cluster: document.getElementById('toggleCluster').classList.contains('active'),
      severity: document.getElementById('severity').value,
      hFrom: document.getElementById('hFrom').value,
      hTo:   document.getElementById('hTo').value,
      city:  document.getElementById('citySel').value
    }));

    // Idempotenz auf URL-Ebene: alle Werte aus der Original-URL sind
    // nach jedem Reload weiterhin gesetzt und mit demselben Wert.
    for (const [k, v] of Object.entries(urlA)) {
      expect(urlB[k], `Param ${k} verloren nach 1. Reload`).toBe(v);
      expect(urlC[k], `Param ${k} verloren nach 2. Reload`).toBe(v);
    }
    // Idempotenz auf URL-Ebene: zwischen den Reloads kommen keine
    // unerwarteten Parameter dazu, die nicht schon nach Reload 1 da
    // waren (Reload 1 vs. Reload 2 sind exakt deckungsgleich).
    expect(Object.keys(urlC).sort()).toEqual(Object.keys(urlB).sort());
    for (const k of Object.keys(urlB)) {
      expect(urlC[k], `Param ${k} hat sich zwischen Reloads geändert`).toBe(urlB[k]);
    }
    // Idempotenz auf UI-Ebene.
    expect(checkedB).toEqual(checkedA);
    expect(checkedC).toEqual(checkedA);
  });

  test('UI-Änderung wird zurück in die URL geschrieben (bidirektionale Synchronisation)', async ({ page }) => {
    await page.goto(BONN_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');

    // Ausgangszustand: severity=all (laut URL), Cluster off, Heat on.
    const before = new URL(page.url()).searchParams;
    expect(before.get('severity')).toBe('all');
    expect(before.get('showCluster')).toBe('0');

    // a) Schweregrad ändern → URL muss `severity=2` führen.
    await page.locator('#severity').selectOption('2');
    await expect.poll(() =>
      new URL(page.url()).searchParams.get('severity')
    ).toBe('2');

    // b) Cluster-Toggle einschalten → URL muss `showCluster=1` führen.
    await page.locator('#toggleCluster').click();
    await expect.poll(() =>
      new URL(page.url()).searchParams.get('showCluster')
    ).toBe('1');

    // c) Beteiligungs-Chip „Krad" einschalten → URL muss
    //    `includeMotorcycle=1` führen.
    await page.locator('#incMoto').click({ force: true });
    await expect.poll(() =>
      new URL(page.url()).searchParams.get('includeMotorcycle')
    ).toBe('1');

    // Reload → die zurückgeschriebenen Werte werden korrekt
    // re-hydratisiert (URL = Source of Truth).
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#severity')).toHaveValue('2');
    await expect(page.locator('#toggleCluster')).toHaveClass(/active/);
    await expect(page.locator('#incMoto')).toBeChecked();
  });

  test('Ungültige sel*-Parameter (verkehrte Reihenfolge) werden ignoriert, kein Crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // Verkehrte Reihenfolge (south > north) – Hydration darf KEINEN
    // Selektionsbereich anlegen, sondern den Fall sauber ignorieren.
    const INVERTED_BOUNDS_URL =
      'werkbank_v2.html?city=Bonn&selSouth=50.74&selWest=7.13&selNorth=50.71&selEast=7.08';
    await page.goto(INVERTED_BOUNDS_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#citySel')).not.toHaveAttribute('aria-busy', 'true');

    // Stat-Zeile darf NICHT „Markierung: aktiv" zeigen.
    await expect(page.locator('#stat')).not.toContainText(/Markierung:\s*aktiv/);

    // Export-Dialog zeigt erwartet den Hinweis „Kein Bereich markiert".
    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#noSelectionHint')).toBeVisible();

    // Keine ungefangenen JS-Exceptions.
    expect(errors, `pageerror events:\n${errors.join('\n')}`).toHaveLength(0);
  });
});
