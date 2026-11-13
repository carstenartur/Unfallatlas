/** @jest-environment node */
'use strict';

const elevation = require('../../js/ua.elevation_provider');
const adapter = require('../../scripts/apply-hannover-dgm1-road-profiles');

const anchor = { lat: 52.3759, lon: 9.732 };
const metresPerDegree = 111320 * Math.cos(anchor.lat * Math.PI / 180);
const geometry = [-50, 50].map(x => ({ lat: anchor.lat, lon: anchor.lon + x / metresPerDegree }));

function residualProvider(amplitude) {
  return elevation.createProvider({
    descriptor: elevation.createHannoverDgm1Descriptor('2026-11-10'),
    sampleElevations(coordinates) {
      // Symmetric, balanced deviations keep the fitted slope/intercept at 0/100.
      // Their hand-derived median absolute residual is the supplied amplitude.
      const middle = (coordinates.length - 1) / 2;
      return coordinates.map((_, index) => 100 + [0, amplitude, -amplitude][Math.abs(index - middle) % 3]);
    },
  });
}

async function profile(amplitude, spacingMeters, osmTags = {}) {
  return elevation.computeRoadGradient(residualProvider(amplitude), geometry, anchor, {
    windowMeters: 50, spacingMeters, matchQuality: 'high', osmTags,
  });
}

test.each([
  [0, 'high'], [0.25, 'high'], [0.251, 'medium'],
  [0.75, 'medium'], [0.751, 'low'], [1.625, 'low'],
])('residual MAD %s caps confidence at %s regardless of dense sampling', async (amplitude, quality) => {
  for (const spacing of [25, 1]) {
    const result = await profile(amplitude, spacing);
    expect(result.sampleCount).toBe(spacing === 25 ? 5 : 101);
    expect(result.residualMadMeters).toBeCloseTo(amplitude, 3);
    expect(result.gradientPercent).toBe(0);
    expect(result.quality).toBe(quality);
    expect(result.usable).toBe(true);
    if (amplitude > 0.25) {
      expect(result.uncertaintyReasons).toContain('elevated_profile_residual');
      expect(result.statement).toMatch(/Höhenprofil.*linearen Anpassung/);
    } else {
      expect(result.uncertaintyReasons).not.toContain('elevated_profile_residual');
    }
  }
});

test('large residuals retain numerical uncertainty and reach runtime evidence as low confidence', async () => {
  const result = await profile(1.625, 1);
  expect(result.uncertaintyPercent).toBe(4.8);
  const row = {};
  adapter.applyProfileToRow(row, {
    wayId: 'synthetic-residual-profile',
    windows: { '50': { status: 'computed', result } },
  }, result.source);
  expect(row).toMatchObject({
    road_slope_percent: 0,
    road_slope_quality: 'low',
    road_slope_confidence: 'low',
    road_slope_residual_mad_m: 1.625,
    road_slope_uncertainty_percent: 4.8,
    road_slope_uncertainty_reasons: ['elevated_profile_residual'],
  });
  const presentation = elevation.presentContext(row);
  expect(presentation.uncertaintyReasons).toEqual(['elevated_profile_residual']);
  expect(presentation.statement).toMatch(/Höhenprofil.*linearen Anpassung/);
});

test('residual confidence never overrides bridge rejection', async () => {
  const result = await profile(1.625, 1, { bridge: 'yes' });
  expect(result.quality).toBe('unusable');
  expect(result.usable).toBe(false);
  expect(result.gradientPercent).toBeNull();
  expect(result.uncertaintyReasons).toEqual([
    'bridge_surface_not_represented_by_dtm', 'elevated_profile_residual',
  ]);
});

test.each([
  [{layer: 1}, 'non_ground_osm_layer'],
  [{embankment: 'yes'}, 'embankment_may_differ_from_terrain'],
  [{cutting: 'yes'}, 'cutting_may_differ_from_terrain'],
])('bounds dense DGM1 profiles with a single structural risk %j', async (tags, reason) => {
  const result = await profile(0, 1, tags);
  expect(result.uncertaintyReasons).toContain(reason);
  expect(result.quality).toBe('medium');
  expect(result.gradientPercent).toBe(0);
  const row = {};
  adapter.applyProfileToRow(row, {
    windows: { '50': {status: 'computed', result: {...result, quality: 'high'}} },
  }, result.source);
  expect(row.road_slope_confidence).toBe('medium');
  expect(row.road_slope_quality).toBe('medium');
});

test.each([
  ['low', anchor, 'low_road_match_quality'],
  ['high', {...anchor, lat: anchor.lat + 0.0003}, 'accident_point_far_from_matched_road'],
])('bounds dense profiles with a known match risk %s', async (matchQuality, point, reason) => {
  const result = await elevation.computeRoadGradient(residualProvider(0), geometry, point, {
    windowMeters: 50, spacingMeters: 1, matchQuality,
  });
  expect(result.uncertaintyReasons).toContain(reason);
  expect(result.quality).not.toBe('high');
});

test.each(['feature', 'way'])('retains stored %s evidence at the quality allowed by its reasons', origin => {
  const row = {
    road_slope_percent: -3.4, road_slope_quality: 'high', road_slope_confidence: 'high',
    road_slope_uncertainty_reasons: ['embankment_may_differ_from_terrain,non_ground_osm_layer'],
  };
  const feature = origin === 'feature' ? row : {};
  const way = origin === 'way' ? row : {};
  const result = elevation.projectSelectedWayEvidence(feature, way);
  expect(result).toEqual({...row, road_slope_quality: 'medium', road_slope_confidence: 'medium'});
  expect(row.road_slope_quality).toBe('high');
});
