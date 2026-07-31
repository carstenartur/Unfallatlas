/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const traffic = require('../../js/ua.traffic_provider');
const matcher = require('../../scripts/producers/koeln_kfz_osm_line_match_producer');
const providerModule = require('../../scripts/providers/koeln_kfz_osm_matched_provider');

const LAT = 50.93;
const LON = 6.95;
const LON_METERS = 111320 * Math.cos(LAT * Math.PI / 180);

function coordinate(eastMeters, northMeters = 0) {
  return [LON + eastMeters / LON_METERS, LAT + northMeters / 110540];
}

function sourceDescriptor() {
  return {
    sourceId: 'traffic.count.koeln-kfz-links-2016-2019',
    role: 'traffic_count',
    publisher: 'Stadt Köln',
    datasetTitle: 'Kfz-Zählwerte Köln – richtungsbezogene Strecken 2016–2019',
    datasetUrl: 'https://open.nrw/dataset/kfz-zaehlstellen-und-werte-koeln-k',
    distributionUrl: 'https://offenedaten-koeln.de/KFZ_Zaehldaten_2016-2019_link.csv',
    licenseId: 'DL-DE-Zero-2.0',
    licenseName: 'Datenlizenz Deutschland – Zero – Version 2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
    requiredAttribution: 'Stadt Köln',
    temporalCoverage: '2016–2019',
    spatialCoverage: 'Köln',
    versionOrPublicationDate: '2019-12-31',
    retrievedAt: '2026-07-30T12:00:00.000Z',
    contentHash: '1'.repeat(64),
    changedOrDerived: true,
    changeNotice: 'Amtliche CSV-Werte wurden richtungsbezogen normalisiert.',
    permissions: {
      permitsRedistribution: true,
      permitsDerivatives: true,
      commercialUseAllowed: true,
    },
    qualityNotes: ['Kommunale Werktagszählung; Datenstand 2016–2019.'],
  };
}

function observation({ id, segment, northMeters, value, directionCode = 'forward' }) {
  const reverse = directionCode === 'reverse';
  const coordinates = reverse
    ? [coordinate(100, northMeters), coordinate(0, northMeters)]
    : [coordinate(0, northMeters), coordinate(100, northMeters)];
  return {
    observationId: id,
    sourceId: 'traffic.count.koeln-kfz-links-2016-2019',
    measurementType: 'count',
    mode: 'motor_vehicle',
    year: 2019,
    period: 'DTVw',
    value,
    unit: 'Kfz/24 h',
    wayId: `koeln-segment:${segment}:${directionCode}:${reverse ? 'B->A' : 'A->B'}`,
    direction: reverse ? 'B → A' : 'A → B',
    geometry: { type: 'LineString', coordinates },
    officialGeometry: {
      sourceId: 'traffic.geometry.koeln-kfz-2010-2019',
      segment,
      directionCode,
      fromNode: reverse ? 'B' : 'A',
      toNode: reverse ? 'A' : 'B',
    },
    qualityNotes: ['Amtliche Kölner Liniengeometrie verbunden.'],
  };
}

function trafficArtifact(observations) {
  return {
    schemaVersion: 1,
    type: matcher.INPUT_TYPE,
    generatedAt: '2026-07-30T12:00:00.000Z',
    source: {
      traffic: sourceDescriptor(),
      trafficDistribution: { path: 'counts.csv', sha256: '1'.repeat(64) },
      geometry: { id: 'traffic.geometry.koeln-kfz-2010-2019' },
    },
    observations,
  };
}

function osmArtifact() {
  const ways = {
    10: { highway: 'primary', name: 'Eindeutige Straße' },
    20: { highway: 'primary', name: 'Parallel links' },
    30: { highway: 'primary', name: 'Parallel rechts' },
  };
  const wayGeometries = {
    10: [coordinate(0, 0), coordinate(100, 0)].map(([lon, lat]) => ({ lon, lat })),
    20: [coordinate(0, 98), coordinate(100, 98)].map(([lon, lat]) => ({ lon, lat })),
    30: [coordinate(0, 102), coordinate(100, 102)].map(([lon, lat]) => ({ lon, lat })),
  };
  return { ways, wayGeometries };
}

function buildArtifact() {
  return matcher.buildMatchedArtifact(
    {
      file: '/tmp/official-geometry.json',
      sha256: 'a'.repeat(64),
      value: trafficArtifact([
        observation({ id: 'matched-2019', segment: 'S1', northMeters: 0, value: 18504 }),
        observation({ id: 'ambiguous-2019', segment: 'S2', northMeters: 100, value: 22153 }),
      ]),
    },
    { file: '/tmp/osm_koeln.json', sha256: 'b'.repeat(64), value: osmArtifact() },
    { generatedAt: '2026-07-31T12:00:00Z' },
  );
}

function writeArtifact(root, artifact = buildArtifact()) {
  const file = path.join(root, 'koeln-kfz-osm-matches.json');
  fs.writeFileSync(file, `${JSON.stringify(artifact)}\n`);
  return { file, sha256: providerModule.sha256(fs.readFileSync(file)) };
}

function road(wayId, northMeters) {
  return {
    wayId,
    coordinates: [coordinate(0, northMeters), coordinate(100, northMeters)]
      .map(([lon, lat]) => ({ lon, lat })),
  };
}

describe('Cologne OSM-matched traffic provider', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  function root() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koeln-kfz-matched-provider-'));
    roots.push(directory);
    return directory;
  }

  test('publishes only unambiguous matches through the common traffic SPI', async () => {
    const written = writeArtifact(root());
    const provider = providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: written.file,
      expectedArtifactSha256: written.sha256,
    });

    expect(provider.id).toBe(providerModule.PROVIDER_ID);
    expect(provider.coverage).toEqual({
      totalObservations: 2,
      publishedObservations: 1,
      excludedAmbiguousObservations: 1,
      excludedUnmatchedObservations: 0,
      matchedGroups: 1,
      ambiguousGroups: 1,
      unmatchedGroups: 0,
    });
    expect(await provider.canProvide({ city: 'Köln' })).toBe(true);
    expect(await provider.canProvide({ city: 'Bonn' })).toBe(false);

    const observations = await provider.loadObservations({ city: 'Köln' });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(expect.objectContaining({
      observationId: 'matched-2019',
      measurementType: 'count',
      value: 18504,
      unit: 'Kfz/24 h',
      wayId: '10',
      direction: 'A → B; OSM-Way-Richtung: same',
    }));
    expect(observations[0].qualityNotes.join(' ')).toMatch(/P95 0 m/);
    expect(observations[0].source).toEqual(expect.objectContaining({
      sourceId: providerModule.PROVIDER_ID,
      licenseId: 'DL-DE-Zero-2.0',
      contentHash: written.sha256,
    }));
  });

  test('feeds the existing age, road-match and fallback hierarchy without invented freshness', async () => {
    const written = writeArtifact(root());
    const provider = providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: written.file,
      expectedArtifactSha256: written.sha256,
    });
    const [observation] = await provider.loadObservations({ city: 'Köln' });
    const match = traffic.matchObservationToRoads(observation, [road('10', 0)]);
    const selected = traffic.selectTrafficEvidence([match], {
      referenceYear: 2026,
      maxFreshAgeYears: 5,
      mode: 'motor_vehicle',
    });

    expect(match).toEqual(expect.objectContaining({
      wayId: '10',
      distanceMeters: 0,
      matchQuality: 'high',
      matchMethod: 'explicit-way-id-with-geometry',
    }));
    expect(selected).toEqual(expect.objectContaining({
      evidenceType: 'stale-measured',
      ageYears: 7,
      warning: 'Messwert ist älter als die Frischegrenze.',
    }));
    expect(selected.statement).toMatch(/Älterer gemessener Verkehrswert/);
    expect(selected.statement).toMatch(/18[.\s]504 Kfz\/24 h/);
    expect(selected.statement).toMatch(/2019/);
  });

  test('can fail closed when an operational run requires complete OSM coverage', () => {
    const written = writeArtifact(root());
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: written.file,
      expectedArtifactSha256: written.sha256,
      requireFullCoverage: true,
    })).toThrow(/incomplete_osm_coverage/);
  });

  test('rejects external hash drift and internal fingerprint drift', () => {
    const directory = root();
    const written = writeArtifact(directory);
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: written.file,
      expectedArtifactSha256: 'f'.repeat(64),
    })).toThrow(/artifact_hash_mismatch/);

    const artifact = buildArtifact();
    artifact.coverage.matchedObservations = 99;
    const tampered = writeArtifact(directory, artifact);
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: tampered.file,
      expectedArtifactSha256: tampered.sha256,
    })).toThrow(/artifact_fingerprint_mismatch/);
  });

  test('rejects symbolic-link artifact paths before reading bytes', () => {
    const directory = root();
    const written = writeArtifact(directory);
    const linked = path.join(directory, 'linked.json');
    fs.symlinkSync(written.file, linked);
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: linked,
      expectedArtifactSha256: written.sha256,
    })).toThrow(/unsafe_file/);
  });
});
