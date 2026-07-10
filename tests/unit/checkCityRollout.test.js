'use strict';

/**
 * Smoke-Test für scripts/check-city-rollout.js
 *
 * Verifiziert nur das Diagnose-Verhalten der Klassifikation – der
 * Inhalt der Sektionen wird über die Katalog-Konsistenz-Tests
 * abgedeckt (siehe tests/unit/cityRegistry.test.js).
 */

const fs = require('fs');
const path = require('path');

const { classify, applyFix } = require('../../scripts/check-city-rollout.js');
const cityRegistry = require('../../server/cities/cityRegistry.js');

describe('scripts/check-city-rollout', () => {
  test('classify liefert die drei erwarteten Sektionen als Arrays', () => {
    const r = classify();
    expect(Array.isArray(r.upgradeCandidates)).toBe(true);
    expect(Array.isArray(r.inconsistentSupported)).toBe(true);
    expect(Array.isArray(r.txtWithoutCatalog)).toBe(true);
  });

  test('aktueller Repo-Stand: keine Drift (entspricht Materialisierungs-Honesty + Upgrade-Pfad-Test)', () => {
    // In einem frischen CI-Checkout ohne generierte Datendateien (out/output_all_years_*)
    // sind alle als „supported" geführten Städte als „inconsistentSupported" klassifiziert.
    // Der Test wird in diesem Fall übersprungen, damit er nicht auf Branches/PRs
    // fehlschlägt, auf denen der generate-Workflow noch nicht gelaufen ist.
    const hasAnyData = cityRegistry.listCities().some(c => {
      return cityRegistry.getDataAssets(c.id).accidents;
    });
    if (!hasAnyData) {
      // Keine Unfalldaten im Checkout – der Konsistenz-Check ist nicht aussagekräftig.
      return;
    }

    const r = classify();
    expect(r.inconsistentSupported).toEqual([]);
    expect(r.txtWithoutCatalog).toEqual([]);
    // Upgrade-Kandidaten sind erlaubt, aber im aktuell gepushten
    // Stand ebenfalls leer – der Test deckt also den vollen Reset ab.
    expect(r.upgradeCandidates).toEqual([]);
  });

  describe('--fix-Modus (applyFix)', () => {
    const catalogPath = cityRegistry.CATALOG_PATH;
    const originalContent = fs.readFileSync(catalogPath, 'utf8');
    const origExistsSync = fs.existsSync.bind(fs);

    // Kein direktes Schreiben auf das Dateisystem (Race-Condition-Gefahr bei
    // parallelen Jest-Workern). Stattdessen: fs.readFileSync / writeFileSync
    // per Spy in-memory stubben, analog zu cityRegistry.test.js.
    let readSpy;
    let writeSpy;
    // existsSpy simuliert vorhandene Datendateien für alle Städte, damit die
    // applyFix-Logik unabhängig vom tatsächlichen Checkout-Zustand testbar ist.
    let existsSpy;
    let inMemoryCatalog;

    beforeEach(() => {
      inMemoryCatalog = originalContent;

      const origRead  = fs.readFileSync.bind(fs);
      const origWrite = fs.writeFileSync.bind(fs);

      readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
        if (filePath === catalogPath) return inMemoryCatalog;
        return origRead(filePath, ...args);
      });

      writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((filePath, data, ...args) => {
        if (filePath === catalogPath) { inMemoryCatalog = data; return; }
        return origWrite(filePath, data, ...args);
      });

      // Datendateien für alle Städte simulieren, damit getDataAssets() „true" zurückgibt
      // und die Klassifikation (upgradeCandidates / inconsistentSupported) korrekt testet.
      existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const pStr = String(p);
        if (/[/\\]out[/\\](?:output_all_years_|poi_)[^/\\]+\.geojson(?:\.gz)?$/.test(pStr)) {
          return true;
        }
        return origExistsSync(p);
      });
    });

    afterEach(() => {
      readSpy.mockRestore();
      writeSpy.mockRestore();
      existsSpy.mockRestore();
      cityRegistry.reload();
    });

    test('applyFix ist idempotent wenn keine Drift vorliegt', () => {
      const exitCode = applyFix();
      expect(exitCode).toBe(0);
      // Kein Schreibvorgang auf den Katalog, da keine Kandidaten
      expect(writeSpy).not.toHaveBeenCalled();
    });

    test('applyFix hebt Upgrade-Kandidaten auf supported hoch', () => {
      // Drift einbauen: Berlin gezielt auf partially_supported zurücksetzen
      const catalog = JSON.parse(originalContent);
      const entry = catalog.cities.find(c => c.id === 'berlin');
      expect(entry).toBeTruthy();

      entry.accidentDataSupport = 'partially_supported';
      entry.qualityFlags = (entry.qualityFlags || [])
        .filter(f => f !== 'accident-data-generated' && f !== 'poi-generated');
      entry.qualityFlags.push('rollout-queued');

      inMemoryCatalog = JSON.stringify(catalog, null, 2) + '\n';
      cityRegistry.reload();

      // Vor dem Fix muss Berlin als Upgrade-Kandidat auftauchen
      const before = classify();
      expect(before.upgradeCandidates.some(u => u.id === 'berlin')).toBe(true);

      // Fix anwenden
      const exitCode = applyFix();
      expect(exitCode).toBe(0);

      // Nach dem Fix kein Upgrade-Kandidat mehr
      const after = classify();
      expect(after.upgradeCandidates.some(u => u.id === 'berlin')).toBe(false);

      // Status und Flags korrekt gesetzt
      const fixed = cityRegistry.getCityById('berlin');
      expect(fixed.accidentDataSupport).toBe('supported');
      expect((fixed.qualityFlags || []).includes('accident-data-generated')).toBe(true);
      expect((fixed.qualityFlags || []).includes('rollout-queued')).toBe(false);

      // Kanonische Flag-Reihenfolge eingehalten
      const flags = fixed.qualityFlags || [];
      const adIdx = flags.indexOf('accident-data-generated');
      const psIdx = flags.indexOf('portal-from-seed');
      expect(adIdx).toBeGreaterThanOrEqual(0);
      expect(psIdx).toBeGreaterThanOrEqual(0);
      expect(adIdx).toBeLessThan(psIdx);
    });
  });
});
