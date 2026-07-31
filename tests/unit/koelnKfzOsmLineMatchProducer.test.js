/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const matcher = require('../../scripts/producers/koeln_kfz_osm_line_match_producer');

const LAT = 50.93;
const LON = 6.95;
const LON_METERS = 111320 * Math.cos(LAT * Math.PI / 180);

function coordinate(eastMeters, northMeters = 0) {
  return [LON + eastMeters / LON_METERS, LAT + northMeters / 110540];
}

function observation({
  id,
  segment = 'S1',
  directionCode = 'forward',
  coordinates = [coordinate(0), coordinate(100)],
  value = 1000,
}) {
  const forward = directionCode === 'forward';
  return {
    observationId: id,
    wayId: `koeln-segment:${segment}:${directionCode}:${forward ? 'A->B' : 'B->A'}`,
    timestamp: '2019-01-01T00:00:00.000Z',
    value,
    geometry: { type: 'LineString', coordinates },
    officialGeometry: {
      segment,
      directionCode,
      fromNode: forward ? 'A' : 'B',
      toNode: forward ? 'B' : 'A',
    },
    qualityNotes: ['amtlich'],
  };
}

function trafficArtifact(observations) {
  return {
    schemaVersion: 1,
    type: matcher.INPUT_TYPE,
    generatedAt: '2026-07-30T00:00:00.000Z',
    source: { traffic: { id: 'traffic.count.koeln-kfz-links-2016-2019' } },
    observations,
  };
}

function osmArtifact(ways) {
  return {
    ways: Object.fromEntries(Object.entries(ways).map(([id, value]) => [id, {
      highway: value.highway || 'primary',
      name: value.name || null,
    }])),
    wayGeometries: Object.fromEntries(Object.entries(ways).map(([id, value]) => [id,
      value.coordinates.map(([lon, lat]) => ({ lon, lat })),
    ])),
  };
}

function input(value, name, hashCharacter) {
  return {
    file: `/tmp/${name}.json`,
    sha256: hashCharacter.repeat(64),
    value,
  };
}

function build(observations, ways, options = {}) {
  return matcher.buildMatchedArtifact(
    input(trafficArtifact(observations), 'traffic', 'a'),
    input(osmArtifact(ways), 'osm', 'b'),
    { generatedAt: '2026-07-31T12:00:00Z', ...options },
  );
}

describe('Cologne directed official-line to OSM matching', () => {
  test('matches repeated yearly observations once and preserves traffic values', () => {
    const observations = [
      observation({ id: '2018-forward', value: 1234 }),
      observation({ id: '2019-forward', value: 2345 }),
    ];
    const artifact = build(observations, {
      123: { coordinates: [coordinate(0), coordinate(100)], name: 'Teststraße' },
    });

    expect(artifact.coverage).toMatchObject({
      directedGeometryGroups: 1,
      matchedGroups: 1,
      observations: 2,
      matchedObservations: 2,
      ambiguousObservations: 0,
      unmatchedObservations: 0,
    });
    expect(artifact.directedMatches[0].observationCount).toBe(2);
    expect(artifact.observations.map(value => value.value)).toEqual([1234, 2345]);
    expect(artifact.observations.map(value => value.wayId)).toEqual(observations.map(value => value.wayId));
    expect(artifact.observations.every(value => value.osmMatch.wayId === '123')).toBe(true);
    expect(artifact.observations.every(value => value.osmMatch.matchQuality === 'high')).toBe(true);
    expect(artifact.truthBoundary.trafficValuesChanged).toBe(false);
  });

  test('records reverse relation when the OSM way storage order is opposite', () => {
    const artifact = build([observation({ id: 'forward' })], {
      456: { coordinates: [coordinate(100), coordinate(0)] },
    });

    expect(artifact.observations[0].osmMatch).toMatchObject({
      status: 'matched',
      wayId: '456',
      directionRelation: 'reverse',
      matchQuality: 'high',
    });
  });

  test('keeps equal parallel candidates ambiguous instead of inventing a way', () => {
    const artifact = build([observation({ id: 'ambiguous' })], {
      10: { coordinates: [coordinate(0, -2), coordinate(100, -2)] },
      20: { coordinates: [coordinate(0, 2), coordinate(100, 2)] },
    });

    expect(artifact.coverage).toMatchObject({
      matchedGroups: 0,
      ambiguousGroups: 1,
      ambiguousObservations: 1,
    });
    expect(artifact.observations[0].osmMatch).toMatchObject({
      status: 'ambiguous',
      reasonCode: 'score_margin_too_small',
      acceptedCandidateCount: 2,
    });
    expect(artifact.observations[0].osmMatch.wayId).toBeUndefined();
  });

  test('returns a typed unmatched result outside the spatial gate', () => {
    const artifact = build([observation({ id: 'far' })], {
      99: { coordinates: [coordinate(0, 100), coordinate(100, 100)] },
    });

    expect(artifact.coverage.unmatchedGroups).toBe(1);
    expect(artifact.observations[0].osmMatch).toMatchObject({
      status: 'unmatched',
      reasonCode: 'no_spatial_candidates',
      candidateCount: 0,
    });
  });

  test('does not collapse forward and reverse official observations into one directed group', () => {
    const forward = observation({ id: 'forward' });
    const reverse = observation({
      id: 'reverse',
      directionCode: 'reverse',
      coordinates: [coordinate(100), coordinate(0)],
    });
    const artifact = build([forward, reverse], {
      123: { coordinates: [coordinate(0), coordinate(100)] },
    });

    expect(artifact.coverage.directedGeometryGroups).toBe(2);
    expect(artifact.coverage.matchedGroups).toBe(2);
    expect(artifact.coverage.directionPairConflicts).toBe(0);
    expect(artifact.observations[0].osmMatch.directionRelation).toBe('same');
    expect(artifact.observations[1].osmMatch.directionRelation).toBe('reverse');
  });

  test('rejects geometry drift within one directed official identity', () => {
    const observations = [
      observation({ id: 'first' }),
      observation({ id: 'drift', coordinates: [coordinate(0), coordinate(90)] }),
    ];
    expect(() => build(observations, {
      123: { coordinates: [coordinate(0), coordinate(100)] },
    })).toThrow(/directed_geometry_drift/);
  });

  test('rejects symbolic-link inputs before parsing JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koeln-kfz-osm-match-'));
    try {
      const target = path.join(root, 'target.json');
      const linked = path.join(root, 'linked.json');
      fs.writeFileSync(target, '{}');
      fs.symlinkSync(target, linked);
      expect(() => matcher.readJsonFile(linked, 'trafficFile')).toThrow(/unsafe_file/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
