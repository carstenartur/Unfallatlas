'use strict';

/**
 * Smoke-Test für scripts/check-city-rollout.js
 *
 * Verifiziert nur das Diagnose-Verhalten der Klassifikation – der
 * Inhalt der Sektionen wird über die Katalog-Konsistenz-Tests
 * abgedeckt (siehe tests/unit/cityRegistry.test.js).
 */

const { classify } = require('../../scripts/check-city-rollout.js');

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
});
