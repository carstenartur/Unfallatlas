/**
 * Unit tests for UA.ensureLocationHint() (Issue 3 — Vorgangs-Suche).
 *
 * ensureLocationHint() ist die Brücke zwischen Reverse-Geocoding und der
 * politischen Recherche: sie liest Straße/Stadtbezirk/Suburb aus dem
 * Reverse-Geocoder und cacht sie als ctx.locationHint, damit
 * UA.PoliticalContext.buildSearchTerms() einen orts-spezifischen
 * Treffersatz produzieren kann.
 */

describe('UA.ensureLocationHint', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };

    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    mockWindow.location = { href: 'http://localhost/?city=Hannover' };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeCenter(lat, lng) {
    return {
      getCenter: () => ({ lat, lng })
    };
  }

  test('returns null when ctx has no center (no selection, no map)', async () => {
    const ctx = {};
    const out = await UA.ensureLocationHint(ctx);
    expect(out).toBeNull();
    expect(ctx.locationHint).toBeUndefined();
  });

  test('returns existing locationHint without re-geocoding (idempotent)', async () => {
    const ctx = {
      locationHint: { street: 'Alte Straße', district: 'Linden', suburb: null, label: 'Alte Straße' },
      selectionBounds: makeCenter(52.37, 9.73)
    };
    const calls = [];
    UA.reverseGeocode = async (lat, lon) => {
      calls.push([lat, lon]);
      return { address: { road: 'X-Weg' }, label: 'X-Weg' };
    };
    const out = await UA.ensureLocationHint(ctx);
    expect(out.street).toBe('Alte Straße');
    expect(calls).toHaveLength(0); // not called again
  });

  test('populates ctx.locationHint with street/district/suburb from reverse-geocode result', async () => {
    const ctx = { selectionBounds: makeCenter(52.37, 9.73) };
    UA.reverseGeocode = async () => ({
      label: 'Limmerstraße 12, 30451 Hannover',
      address: {
        road: 'Limmerstraße',
        house_number: '12',
        suburb: 'Limmer',
        city_district: 'Linden-Limmer',
        city: 'Hannover',
        postcode: '30451'
      },
      admin: { suburb: 'Limmer', city_district: 'Linden-Limmer' }
    });
    const out = await UA.ensureLocationHint(ctx);
    expect(out).toEqual({
      street: 'Limmerstraße',
      district: 'Linden-Limmer',
      suburb: 'Limmer',
      label: 'Limmerstraße 12, 30451 Hannover'
    });
    expect(ctx.locationHint).toEqual(out);
  });

  test('falls back to ctx.map.getCenter() when no selectionBounds are present', async () => {
    const ctx = { map: makeCenter(52.37, 9.73) };
    UA.reverseGeocode = async () => ({
      label: 'Nordstadt',
      address: { road: null, suburb: 'Nordstadt', city_district: null },
      admin: {}
    });
    const out = await UA.ensureLocationHint(ctx);
    expect(out).toEqual({
      street: null,
      district: null,
      suburb: 'Nordstadt',
      label: 'Nordstadt'
    });
  });

  test('returns null and leaves ctx untouched when reverse-geocode has no usable fields', async () => {
    const ctx = { selectionBounds: makeCenter(52.37, 9.73) };
    UA.reverseGeocode = async () => ({
      label: '52.37000, 9.73000',
      address: { road: null, suburb: null, city_district: null }
    });
    const out = await UA.ensureLocationHint(ctx);
    expect(out).toBeNull();
    expect(ctx.locationHint).toBeUndefined();
  });

  test('uses admin.borough/quarter as district fallback when address.city_district is missing', async () => {
    const ctx = { selectionBounds: makeCenter(52.37, 9.73) };
    UA.reverseGeocode = async () => ({
      label: 'Test',
      address: { road: 'Hauptstraße', city_district: null, suburb: null },
      admin: { borough: 'Mitte', quarter: null, suburb: null, city_district: null }
    });
    const out = await UA.ensureLocationHint(ctx);
    expect(out.street).toBe('Hauptstraße');
    expect(out.district).toBe('Mitte');
  });

  test('returns null defensively when reverseGeocode throws', async () => {
    const ctx = { selectionBounds: makeCenter(52.37, 9.73) };
    UA.reverseGeocode = async () => { throw new Error('network down'); };
    const out = await UA.ensureLocationHint(ctx);
    expect(out).toBeNull();
    expect(ctx.locationHint).toBeUndefined();
  });
});
