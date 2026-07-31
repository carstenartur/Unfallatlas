/** @jest-environment node */
'use strict';

const producer = require('../../scripts/producers/hannover_dgm1_road_profile_producer');

describe('Hannover DGM1 road-profile anchor', () => {
  test('uses the interpolated midpoint of a two-point geometry', () => {
    const anchor = producer.profileAnchor([
      { lat: 52.37, lon: 9.70 },
      { lat: 52.37, lon: 9.72 },
    ]);
    expect(anchor.lat).toBeCloseTo(52.37, 12);
    expect(anchor.lon).toBeCloseTo(9.71, 12);
  });

  test('uses half the actual polyline length rather than the middle array index', () => {
    const geometry = [
      { lat: 52.37, lon: 9.7000 },
      { lat: 52.37, lon: 9.7001 },
      { lat: 52.37, lon: 9.7200 },
    ];
    const anchor = producer.profileAnchor(geometry);
    expect(anchor.lon).toBeGreaterThan(9.709);
    expect(anchor.lon).toBeLessThan(9.711);
    expect(anchor).not.toEqual(geometry[1]);
  });

  test('rejects a geometry without a positive-length segment', () => {
    expect(() => producer.profileAnchor([
      { lat: 52.37, lon: 9.70 },
      { lat: 52.37, lon: 9.70 },
    ])).toThrow(/no positive-length segment/);
  });
});
