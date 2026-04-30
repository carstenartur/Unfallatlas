/**
 * QA-PR „Export-Semantik vor Layout" — zentrale Prosa-Label-Helper für
 * Beteiligten-Klassen im PDF-/DOCX-Export.
 *
 * Das Mapping (Spec):
 *   Rad   -> "Radverkehr"
 *   Fuss  -> "Fußverkehr"
 *   PKW   -> "PKW"
 *   Krad  -> "Motorrad"
 *   Lkw   -> "LKW/Güterverkehr"
 *   Sonst -> "Sonstige Beteiligte"
 *
 * Die Tests fixieren das Eingabe-/Ausgabeverhalten der Helper, damit die
 * QA-Anforderung „im Export keine Icons/Emojis/Bracket-Tokens" über
 * Refactorings hinweg stabil bleibt.
 */

describe('UA.formatParticipantForExport / formatParticipantCombinationForExport', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const win = { UA: {}, location: { href: 'http://localhost/' } };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    load('ua.trend.js');
    load('ua.heatmap.js');
    load('ua.osm_context.js');
    load('ua.costs.js');
    load('ua.measures.js');
    win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    global.fetch = win.fetch;
    win.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = win.UA;
  });

  describe('formatParticipantForExport', () => {
    test('is exposed on UA', () => {
      expect(typeof UA.formatParticipantForExport).toBe('function');
    });

    test('maps canonical codes to verwaltungstaugliche Prosa', () => {
      expect(UA.formatParticipantForExport('Rad')).toBe('Radverkehr');
      expect(UA.formatParticipantForExport('Fuss')).toBe('Fußverkehr');
      expect(UA.formatParticipantForExport('PKW')).toBe('PKW');
      expect(UA.formatParticipantForExport('Krad')).toBe('Motorrad');
      expect(UA.formatParticipantForExport('Lkw')).toBe('LKW/Güterverkehr');
      expect(UA.formatParticipantForExport('Sonst')).toBe('Sonstige Beteiligte');
    });

    test('maps bit values (1/2/4/8/16/32) to prose', () => {
      expect(UA.formatParticipantForExport(1)).toBe('Radverkehr');
      expect(UA.formatParticipantForExport(2)).toBe('Fußverkehr');
      expect(UA.formatParticipantForExport(4)).toBe('PKW');
      expect(UA.formatParticipantForExport(8)).toBe('Motorrad');
      expect(UA.formatParticipantForExport(16)).toBe('LKW/Güterverkehr');
      expect(UA.formatParticipantForExport(32)).toBe('Sonstige Beteiligte');
    });

    test('accepts bracket tokens (legacy intermediate form) and emoji input', () => {
      expect(UA.formatParticipantForExport('[Rad]')).toBe('Radverkehr');
      expect(UA.formatParticipantForExport('[Lkw]')).toBe('LKW/Güterverkehr');
      expect(UA.formatParticipantForExport('🚲')).toBe('Radverkehr');
      expect(UA.formatParticipantForExport('🏍\uFE0F')).toBe('Motorrad');
    });

    test('accepts case-insensitive aliases', () => {
      expect(UA.formatParticipantForExport('rad')).toBe('Radverkehr');
      expect(UA.formatParticipantForExport('Fuß')).toBe('Fußverkehr');
      expect(UA.formatParticipantForExport('Auto')).toBe('PKW');
      expect(UA.formatParticipantForExport('Gkfz')).toBe('LKW/Güterverkehr');
    });

    test('returns "Keine Angabe" for unknown / empty / nullish input', () => {
      expect(UA.formatParticipantForExport(null)).toBe('Keine Angabe');
      expect(UA.formatParticipantForExport(undefined)).toBe('Keine Angabe');
      expect(UA.formatParticipantForExport('')).toBe('Keine Angabe');
      expect(UA.formatParticipantForExport(0)).toBe('Keine Angabe');
      expect(UA.formatParticipantForExport('???')).toBe('Keine Angabe');
    });

    test('honors custom fallback', () => {
      expect(UA.formatParticipantForExport(null, { fallback: 'unbekannt' })).toBe('unbekannt');
      expect(UA.formatParticipantForExport('???', { fallback: '—' })).toBe('—');
    });
  });

  describe('formatParticipantCombinationForExport', () => {
    test('is exposed on UA', () => {
      expect(typeof UA.formatParticipantCombinationForExport).toBe('function');
    });

    test('renders bit masks as "Prosa + Prosa"', () => {
      expect(UA.formatParticipantCombinationForExport(5)).toBe('Radverkehr + PKW');
      expect(UA.formatParticipantCombinationForExport(3)).toBe('Radverkehr + Fußverkehr');
      expect(UA.formatParticipantCombinationForExport(17)).toBe('Radverkehr + LKW/Güterverkehr');
      expect(UA.formatParticipantCombinationForExport(7)).toBe('Radverkehr + Fußverkehr + PKW');
      expect(UA.formatParticipantCombinationForExport(32)).toBe('Sonstige Beteiligte');
    });

    test('renders code arrays in deterministic order (Rad, Fuss, PKW, Krad, Lkw, Sonst)', () => {
      expect(UA.formatParticipantCombinationForExport(['PKW', 'Rad'])).toBe('Radverkehr + PKW');
      expect(UA.formatParticipantCombinationForExport(['Fuss', 'Sonst'])).toBe('Fußverkehr + Sonstige Beteiligte');
      // Duplikate werden entfernt.
      expect(UA.formatParticipantCombinationForExport(['Rad', 'Rad', 'PKW'])).toBe('Radverkehr + PKW');
    });

    test('parses string inputs with "+" / "," / "/" separators', () => {
      expect(UA.formatParticipantCombinationForExport('[Rad]+[PKW]')).toBe('Radverkehr + PKW');
      expect(UA.formatParticipantCombinationForExport('Rad, PKW')).toBe('Radverkehr + PKW');
      expect(UA.formatParticipantCombinationForExport('🚲+🚗')).toBe('Radverkehr + PKW');
      expect(UA.formatParticipantCombinationForExport('🚲🚗')).toBe('Radverkehr + PKW');
    });

    test('returns "Keine Angabe" on empty/unknown input', () => {
      expect(UA.formatParticipantCombinationForExport(null)).toBe('Keine Angabe');
      expect(UA.formatParticipantCombinationForExport(undefined)).toBe('Keine Angabe');
      expect(UA.formatParticipantCombinationForExport('')).toBe('Keine Angabe');
      expect(UA.formatParticipantCombinationForExport(0)).toBe('Keine Angabe');
      expect(UA.formatParticipantCombinationForExport([])).toBe('Keine Angabe');
      expect(UA.formatParticipantCombinationForExport('???')).toBe('Keine Angabe');
    });

    test('honors custom separator and fallback', () => {
      expect(UA.formatParticipantCombinationForExport(5, { separator: ' & ' })).toBe('Radverkehr & PKW');
      expect(UA.formatParticipantCombinationForExport(0, { fallback: 'leer' })).toBe('leer');
    });

    test('does NOT emit any emoji or bracket token (QA-Akzeptanz)', () => {
      const out = UA.formatParticipantCombinationForExport('🚲+🚗+🚛');
      expect(out).toMatch(/Radverkehr/);
      expect(out).toMatch(/PKW/);
      expect(out).toMatch(/LKW\/Güterverkehr/);
      expect(out).not.toMatch(/[\u{1F6B2}\u{1F697}\u{1F69B}]/u);
      expect(out).not.toMatch(/\[/);
    });
  });

  describe('proseLabelForExport', () => {
    test('is exposed on UA', () => {
      expect(typeof UA.proseLabelForExport).toBe('function');
    });

    test('replaces emojis and bracket tokens with prose, keeps other text intact', () => {
      expect(UA.proseLabelForExport('🚲: 4')).toBe('Radverkehr: 4');
      expect(UA.proseLabelForExport('[Rad]+[PKW]: 3')).toBe('Radverkehr + PKW: 3');
      expect(UA.proseLabelForExport('Mehrjahres-Trend: stagnierend')).toBe('Mehrjahres-Trend: stagnierend');
      expect(UA.proseLabelForExport(null)).toBe('');
      expect(UA.proseLabelForExport(undefined)).toBe('');
      expect(UA.proseLabelForExport('')).toBe('');
    });
  });
});
