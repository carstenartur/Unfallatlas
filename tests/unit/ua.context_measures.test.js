/**
 * Regression test for orts- und musterbezogene Maßnahmenempfehlungen.
 *
 * Spec-Item 9 (User-Goldstandard): Bei einem Bereich
 *   Hauptbahnhof + Busbahnhof + Schienen
 *   + viele schwere Rad-Alleinunfälle
 * MUSS der Antrag konkrete Prüfaufträge enthalten:
 *   - Schienenquerung
 *   - Oberflächenprüfung
 *   - Stoßzeiten / Vor-Ort-Audit
 *   - Fuß-/Rad-/Bus-Konflikte
 * Und DARF NICHT „Bewuchs zurückschneiden" als Hauptmaßnahme ausgeben.
 */

const fs = require('fs');
const path = require('path');

describe('UA.contextMeasures – orts- und musterbezogene Empfehlungen', () => {
  let UA;

  beforeEach(() => {
    const win = { UA: {} };
    const filePath = path.resolve(__dirname, '../../js/ua.context_measures.js');
    (function (window) { eval(fs.readFileSync(filePath, 'utf8')); })(win);
    UA = win.UA;
  });

  test('exposes the public API', () => {
    expect(typeof UA.contextMeasures.classifyPatterns).toBe('function');
    expect(typeof UA.contextMeasures.detectContexts).toBe('function');
    expect(typeof UA.contextMeasures.deriveContextualMeasures).toBe('function');
    expect(Array.isArray(UA.contextMeasures.RULES)).toBe(true);
  });

  describe('classifyPatterns', () => {
    test('mask 1 (rad solo) without KSI yields rad_alleinunfall only', () => {
      const out = UA.contextMeasures.classifyPatterns({
        deviations: { focus: [{ mask: 1 }] },
        severity: { bySev: { sev1: 0, sev2: 0, sev3: 5 } }
      });
      expect(out.has('rad_alleinunfall')).toBe(true);
      expect(out.has('rad_alleinunfall_schwer')).toBe(false);
    });

    test('mask 1 + KSI ≥ 1 escalates to rad_alleinunfall_schwer', () => {
      const out = UA.contextMeasures.classifyPatterns({
        deviations: { focus: [{ mask: 1 }] },
        severity: { bySev: { sev1: 0, sev2: 4, sev3: 10 } }
      });
      expect(out.has('rad_alleinunfall')).toBe(true);
      expect(out.has('rad_alleinunfall_schwer')).toBe(true);
    });

    test('mask 1 + KSI ≥ 1 also escalates with computeExportReport-style "1"/"2"/"3" bySev keys', () => {
      // computeExportReport / severityStats produce bySev with String-Keys
      // ("1"/"2"/"3"), not the sev1/sev2 alias used in some tests.
      // Both shapes must escalate to rad_alleinunfall_schwer.
      const out = UA.contextMeasures.classifyPatterns({
        deviations: { focus: [{ mask: 1 }] },
        severity: { bySev: { "1": 0, "2": 2, "3": 8 } }
      });
      expect(out.has('rad_alleinunfall_schwer')).toBe(true);
    });

    test('multiple masks map to multiple pattern keys', () => {
      const out = UA.contextMeasures.classifyPatterns({
        deviations: { focus: [{ mask: 5 }, { mask: 17 }, { mask: 33 }] },
        severity: { bySev: {} }
      });
      expect(out.has('rad_pkw_kollision')).toBe(true);
      expect(out.has('lkw_rad_abbiegen')).toBe(true);
      expect(out.has('rad_bus_konflikt')).toBe(true);
    });

    test('weather + heatmap escalations', () => {
      const out = UA.contextMeasures.classifyPatterns({
        deviations: { focus: [{ mask: 1 }] },
        severity: { bySev: { sev2: 3 } },
        weather: { wetShare: 0.40, darkShare: 0.50 },
        heatmap: { peakHourShare: 0.30 }
      });
      expect(out.has('haeufung_bei_naesse')).toBe(true);
      expect(out.has('haeufung_bei_dunkelheit')).toBe(true);
      expect(out.has('haeufung_stosszeiten')).toBe(true);
    });

    test('null/empty input yields empty Set', () => {
      expect(UA.contextMeasures.classifyPatterns(null).size).toBe(0);
      expect(UA.contextMeasures.classifyPatterns({}).size).toBe(0);
    });
  });

  describe('detectContexts', () => {
    test('explicit override takes precedence and accepts arrays', () => {
      const out = UA.contextMeasures.detectContexts(null, ['bahnhof', 'busbahnhof', 'straßenbahn_schienen']);
      expect(out.has('bahnhof')).toBe(true);
      expect(out.has('busbahnhof')).toBe(true);
      expect(out.has('straßenbahn_schienen')).toBe(true);
    });

    test('override silently drops unknown keys', () => {
      const out = UA.contextMeasures.detectContexts(null, ['bahnhof', 'i_am_not_a_known_context']);
      expect(out.has('bahnhof')).toBe(true);
      expect(out.has('i_am_not_a_known_context')).toBe(false);
    });

    test('OSM-only path detects bahnhof / tram from contexts subobject', () => {
      const osm = {
        summary: { wayCount: 100 },
        contexts: { trainStations: 1, busStations: 1, tramTrackWays: 4, cobblestoneWays: 0 }
      };
      const out = UA.contextMeasures.detectContexts(osm, null);
      expect(out.has('bahnhof')).toBe(true);
      expect(out.has('busbahnhof')).toBe(true);
      expect(out.has('straßenbahn_schienen')).toBe(true);
      expect(out.has('gleisquerung')).toBe(true);
    });

    test('no override + no OSM context → empty Set (no false positives)', () => {
      expect(UA.contextMeasures.detectContexts(null, null).size).toBe(0);
    });
  });

  describe('deriveContextualMeasures (Spec-Item 9 — Goldstandard)', () => {
    test('Hauptbahnhof + Busbahnhof + Schienen + schwere Rad-Alleinunfälle → enthält geforderte Prüfaufträge', () => {
      const patterns = new Set(['rad_alleinunfall', 'rad_alleinunfall_schwer']);
      const contexts = new Set(['bahnhof', 'busbahnhof', 'straßenbahn_schienen', 'gleisquerung']);
      const out = UA.contextMeasures.deriveContextualMeasures(patterns, contexts);

      const all = [
        ...out.kurzfristig,
        ...out.mittelfristig,
        ...out.pruefauftraege
      ].join(' \n ');

      expect(all).toMatch(/Schienen/i);
      expect(all).toMatch(/Oberfläche/i);
      expect(all).toMatch(/Stoßzeit/i);
      expect(all).toMatch(/Audit/i);
      expect(all).toMatch(/Fuß.*Rad|Rad.*Fuß/);
      // KEINE „Bewuchs zurückschneiden" als Hauptmaßnahme:
      expect(all).not.toMatch(/Bewuchs zurückschneiden/i);

      // matchedRules trägt mindestens je eine Regel aus 4A und 4B (Spec).
      const ruleIds = out.matchedRules.map(r => r.id);
      expect(ruleIds).toEqual(expect.arrayContaining(['rad_solo_schwer__schienen', 'rad_solo_schwer__bahnhof']));

      // Unsicherheits-Disclaimer (Spec-Item 6) ist gesetzt.
      expect(out.rationale).toMatch(/Häufung/);
      expect(out.rationale).toMatch(/Ursache/);
      expect(out.rationale).not.toMatch(/^Die Ursache ist/);
    });

    test('Bus + Busbahnhof: liefert Busspur-/Haltestellen-Prüfung', () => {
      const out = UA.contextMeasures.deriveContextualMeasures(
        new Set(['rad_bus_konflikt']),
        new Set(['busbahnhof'])
      );
      const all = [...out.pruefauftraege, ...out.mittelfristig].join('\n');
      expect(all).toMatch(/Busspur|Haltestellen/);
    });

    test('Nässe-Häufung + Rad-Alleinunfall: Oberflächen-/Belags-Prüfung (auch ohne räumlichen Kontext)', () => {
      const out = UA.contextMeasures.deriveContextualMeasures(
        new Set(['rad_alleinunfall', 'haeufung_bei_naesse']),
        new Set() // kein OSM-Kontext
      );
      const all = [...out.pruefauftraege, ...out.kurzfristig, ...out.mittelfristig].join('\n');
      expect(all).toMatch(/rutschig|Beläge|griffige/i);
    });

    test('keine Treffer wenn Pattern×Kontext nicht passt', () => {
      const out = UA.contextMeasures.deriveContextualMeasures(
        new Set(['rad_pkw_kollision']),
        new Set(['kopfsteinpflaster'])
      );
      expect(out.matchedRules.length).toBe(0);
      expect(out.kurzfristig.length).toBe(0);
      expect(out.mittelfristig.length).toBe(0);
      expect(out.pruefauftraege.length).toBe(0);
      expect(out.rationale).toBe('');
    });

    test('Deduplikation: gleicher Wortlaut taucht nur einmal pro Bucket auf', () => {
      // Patterns rad_alleinunfall + rad_alleinunfall_schwer triggern dieselbe
      // Schienen-Regel mehrfach — der Bucket darf jeden Eintrag nur einmal halten.
      const out = UA.contextMeasures.deriveContextualMeasures(
        new Set(['rad_alleinunfall', 'rad_alleinunfall_schwer']),
        new Set(['straßenbahn_schienen', 'gleisquerung', 'haeufung_bei_naesse'])
      );
      for (const bucket of ['kurzfristig', 'mittelfristig', 'pruefauftraege']) {
        const set = new Set(out[bucket]);
        expect(set.size).toBe(out[bucket].length);
      }
    });
  });
});
