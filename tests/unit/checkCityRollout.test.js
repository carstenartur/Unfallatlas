'use strict';

/**
 * Smoke-Test für scripts/check-city-rollout.js
 *
 * Verifiziert nur das Diagnose-Verhalten der Klassifikation – der
 * Inhalt der Sektionen wird über die Katalog-Konsistenz-Tests
 * abgedeckt (siehe tests/unit/cityRegistry.test.js).
 */

const fs   = require('fs');
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
    const r = classify();
    expect(r.inconsistentSupported).toEqual([]);
    expect(r.txtWithoutCatalog).toEqual([]);
    // Upgrade-Kandidaten sind erlaubt, aber im aktuell gepushten
    // Stand ebenfalls leer – der Test deckt also den vollen Reset ab.
    expect(r.upgradeCandidates).toEqual([]);
  });

  describe('--fix-Modus (applyFix)', () => {
    const catalogPath = cityRegistry.CATALOG_PATH;
    let originalContent;

    beforeEach(() => {
      originalContent = fs.readFileSync(catalogPath, 'utf8');
    });

    afterEach(() => {
      fs.writeFileSync(catalogPath, originalContent, 'utf8');
      cityRegistry.reload();
    });

    test('applyFix ist idempotent wenn keine Drift vorliegt', () => {
      const exitCode = applyFix();
      expect(exitCode).toBe(0);
      // Katalog unverändert
      expect(fs.readFileSync(catalogPath, 'utf8')).toBe(originalContent);
    });

    test('applyFix hebt Upgrade-Kandidaten auf supported hoch', () => {
      // Drift einbauen: einen supported Eintrag auf partially_supported zurücksetzen
      const catalog = JSON.parse(originalContent);
      const entry = catalog.cities.find(c => c.accidentDataSupport === 'supported' &&
        (c.qualityFlags || []).includes('accident-data-generated'));
      if (!entry) {
        // Kein geeigneter Eintrag – Test überspringen
        return;
      }
      const originalStatus = entry.accidentDataSupport;
      const originalFlags  = [...(entry.qualityFlags || [])];

      entry.accidentDataSupport = 'partially_supported';
      entry.qualityFlags = (entry.qualityFlags || [])
        .filter(f => f !== 'accident-data-generated' && f !== 'poi-generated');
      entry.qualityFlags.push('rollout-queued');

      fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
      cityRegistry.reload();

      // Vor dem Fix muss der Eintrag als Upgrade-Kandidat auftauchen
      const before = classify();
      expect(before.upgradeCandidates.some(u => u.id === entry.id)).toBe(true);

      // Fix anwenden
      const exitCode = applyFix();
      expect(exitCode).toBe(0);

      // Nach dem Fix kein Upgrade-Kandidat mehr
      const after = classify();
      expect(after.upgradeCandidates.some(u => u.id === entry.id)).toBe(false);

      // Status korrekt gesetzt
      const fixed = cityRegistry.getCityById(entry.id);
      expect(fixed.accidentDataSupport).toBe('supported');
      expect((fixed.qualityFlags || []).includes('accident-data-generated')).toBe(true);
      expect((fixed.qualityFlags || []).includes('rollout-queued')).toBe(false);
    });
  });
});
