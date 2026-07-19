'use strict';

const {
  classifyNominatimFixture,
  classifyOverpassFixture,
} = require('../e2e/fixtures/network/routing.cjs');

describe('canonical screenshot network fixture routing', () => {
  test('maps Nominatim coordinates to the matching city only', () => {
    expect(classifyNominatimFixture(
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=50.733&lon=7.095'
    )).toBe('bonn');
    expect(classifyNominatimFixture(
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=52.3702&lon=9.7394'
    )).toBe('hannover');
    expect(classifyNominatimFixture(
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=48.137&lon=11.575'
    )).toBeNull();
  });

  test('maps the Overpass POST bbox to the matching city only', () => {
    const endpoint = 'https://overpass-api.de/api/interpreter';
    expect(classifyOverpassFixture(endpoint, new URLSearchParams({
      data: '[out:json];way["highway"](50.7300,7.0900,50.7360,7.1000);out tags;'
    }).toString())).toBe('bonn');
    expect(classifyOverpassFixture(endpoint, new URLSearchParams({
      data: '[out:json];way["highway"](52.3600,9.7200,52.3900,9.7600);out tags;'
    }).toString())).toBe('hannover');
    expect(classifyOverpassFixture(endpoint, 'data=[out:json];out;')).toBeNull();
  });
});
