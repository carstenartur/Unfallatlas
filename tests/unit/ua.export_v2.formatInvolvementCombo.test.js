/**
 * Tests for UA.formatInvolvementCombo (PR-Werkbank Task 1).
 *
 * Deterministic mapping for participant combinations in tables. Replaces the
 * QA-flagged failure mode where unreadable rendering ("+", "=", "0") leaked
 * into PDF/DOCX exports.
 */

describe('UA.formatInvolvementCombo (Task 1)', () => {
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

  test('is exposed on UA', () => {
    expect(typeof UA.formatInvolvementCombo).toBe('function');
  });

  test('numeric mask → text label', () => {
    expect(UA.formatInvolvementCombo(1)).toBe('[Rad]');
    expect(UA.formatInvolvementCombo(2)).toBe('[Fuss]');
    expect(UA.formatInvolvementCombo(4)).toBe('[PKW]');
    expect(UA.formatInvolvementCombo(8)).toBe('[Krad]');
    expect(UA.formatInvolvementCombo(16)).toBe('[Lkw]');
    expect(UA.formatInvolvementCombo(32)).toBe('[Sonst]');
  });

  test('combined masks → joined text labels', () => {
    expect(UA.formatInvolvementCombo(5)).toBe('[Rad]+[PKW]');
    expect(UA.formatInvolvementCombo(3)).toBe('[Rad]+[Fuss]');
    expect(UA.formatInvolvementCombo(17)).toBe('[Rad]+[Lkw]');
    expect(UA.formatInvolvementCombo(7)).toBe('[Rad]+[Fuss]+[PKW]');
  });

  test('emoji format produces the original COMBO_LABEL emoji string', () => {
    expect(UA.formatInvolvementCombo(1, { format: 'emoji' })).toBe('🚲');
    expect(UA.formatInvolvementCombo(5, { format: 'emoji' })).toBe('🚲+🚗');
  });

  test('emoji input is normalised to text labels in default format', () => {
    expect(UA.formatInvolvementCombo('🚲+🚗')).toBe('[Rad]+[PKW]');
    expect(UA.formatInvolvementCombo('🚲: 4')).toBe('[Rad]: 4');
  });

  test('mask = 0 → fallback "k. A."', () => {
    expect(UA.formatInvolvementCombo(0)).toBe('k. A.');
    expect(UA.formatInvolvementCombo('0')).toBe('k. A.');
  });

  test('symbol-only / numeric-only strings → fallback "k. A."', () => {
    // The exact QA failure pattern: separators left over after emoji removal.
    expect(UA.formatInvolvementCombo('+')).toBe('k. A.');
    expect(UA.formatInvolvementCombo('+=0')).toBe('k. A.');
    expect(UA.formatInvolvementCombo('   ')).toBe('k. A.');
  });

  test('null/undefined/non-string non-numeric → fallback', () => {
    expect(UA.formatInvolvementCombo(null)).toBe('k. A.');
    expect(UA.formatInvolvementCombo(undefined)).toBe('k. A.');
    expect(UA.formatInvolvementCombo({})).toBe('k. A.');
  });

  test('custom fallback is honored', () => {
    expect(UA.formatInvolvementCombo(0, { fallback: '—' })).toBe('—');
    expect(UA.formatInvolvementCombo(null, { fallback: 'unbekannt' })).toBe('unbekannt');
  });

  test('mask above 6-bit range is masked to the lower 6 bits', () => {
    // Defensive: callers may pass legacy or junk values; we never throw.
    expect(UA.formatInvolvementCombo(0b1000001)).toBe('[Rad]'); // bit-7 ignored
  });
});
