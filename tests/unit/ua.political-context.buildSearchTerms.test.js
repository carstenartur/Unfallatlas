/**
 * Unit tests für UA.PoliticalContext.buildSearchTerms (Issue 3).
 *
 * Stellt sicher, dass buildSearchTerms() Stadt + Straße + Stadtbezirk +
 * (optional) Suburb aus ctx.locationHint zieht und den generischen
 * "Radverkehr"-Fallback NUR dann anhängt, wenn weder Straße noch
 * Stadtbezirk noch Suburb vorhanden sind.
 *
 * @jest-environment jsdom
 */

describe('UA.PoliticalContext.buildSearchTerms', () => {
  let UA;

  beforeEach(() => {
    // Reset DOM and globals between tests so the input-element lookup is clean.
    document.body.innerHTML = '';
    delete window.UA;

    // Minimal UA stub (escHtml + namespace) — die richtige UA-Initialisierung
    // legt das ua.political-context.js-IIFE selbst an.
    window.UA = { escHtml: s => String(s == null ? '' : s) };

    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../js/ua.political-context.js'), 'utf8');
    // eslint-disable-next-line no-eval
    eval(src);
    UA = window.UA;
  });

  test('returns city + street + district from ctx.locationHint', () => {
    const ctx = {
      CITY_RAW: 'Hannover',
      locationHint: { street: 'Limmerstraße', district: 'Linden-Limmer', suburb: null }
    };
    const terms = UA.PoliticalContext.buildSearchTerms(ctx);
    expect(terms).toEqual(expect.arrayContaining(['Hannover', 'Limmerstraße', 'Linden-Limmer']));
    // Kein generischer Fallback, weil ein Ortsbezug existiert.
    expect(terms).not.toContain('Radverkehr');
  });

  test('adds suburb only when distinct from district', () => {
    const ctxA = {
      CITY_RAW: 'Hannover',
      locationHint: { street: null, district: 'Mitte', suburb: 'Mitte' }
    };
    const a = UA.PoliticalContext.buildSearchTerms(ctxA);
    expect(a.filter(t => t === 'Mitte').length).toBe(1);

    const ctxB = {
      CITY_RAW: 'Hannover',
      locationHint: { street: null, district: 'Linden-Limmer', suburb: 'Limmer' }
    };
    const b = UA.PoliticalContext.buildSearchTerms(ctxB);
    expect(b).toEqual(expect.arrayContaining(['Linden-Limmer', 'Limmer']));
  });

  test('appends "Radverkehr" fallback only when no location hint exists', () => {
    const ctx = { CITY_RAW: 'Hannover' };
    const terms = UA.PoliticalContext.buildSearchTerms(ctx);
    expect(terms).toEqual(['Hannover', 'Radverkehr']);
  });

  test('does not append fallback when locationHint has only suburb', () => {
    const ctx = {
      CITY_RAW: 'Hannover',
      locationHint: { street: null, district: null, suburb: 'Limmer' }
    };
    const terms = UA.PoliticalContext.buildSearchTerms(ctx);
    expect(terms).toContain('Limmer');
    expect(terms).not.toContain('Radverkehr');
  });

  test('integrates manual input from #polCtxSearchInput', () => {
    document.body.innerHTML = '<input id="polCtxSearchInput" value="Tempo 30, Schulwegsicherheit" />';
    const ctx = {
      CITY_RAW: 'Hannover',
      locationHint: { street: 'Limmerstraße', district: null, suburb: null }
    };
    const terms = UA.PoliticalContext.buildSearchTerms(ctx);
    expect(terms).toEqual(expect.arrayContaining(['Hannover', 'Limmerstraße', 'Tempo 30', 'Schulwegsicherheit']));
  });

  test('caps result at 5 terms', () => {
    document.body.innerHTML = '<input id="polCtxSearchInput" value="A, B, C, D, E, F" />';
    const ctx = {
      CITY_RAW: 'Hannover',
      locationHint: { street: 'Hauptstraße', district: 'Mitte', suburb: 'Altstadt' }
    };
    const terms = UA.PoliticalContext.buildSearchTerms(ctx);
    expect(terms.length).toBeLessThanOrEqual(5);
  });
});
