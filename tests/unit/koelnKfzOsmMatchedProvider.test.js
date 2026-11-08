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
const coordinate = (east, north = 0) => [LON + east / LON_METERS, LAT + north / 110540];
const geometry = north => ({ type: 'LineString', coordinates: [coordinate(0, north), coordinate(100, north)] });

function descriptor() {
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
    permissions: { permitsRedistribution: true, permitsDerivatives: true, commercialUseAllowed: true },
    qualityNotes: ['Kommunale Werktagszählung; Datenstand 2016–2019.'],
  };
}

function observation(id, segment, north, value) {
  return {
    observationId: id,
    sourceId: descriptor().sourceId,
    measurementType: 'count',
    mode: 'motor_vehicle',
    year: 2019,
    period: 'DTVw',
    value,
    unit: 'Kfz/24 h',
    wayId: `koeln-segment:${segment}:forward:A->B`,
    direction: 'A → B',
    geometry: geometry(north),
    officialGeometry: {
      sourceId: 'traffic.geometry.koeln-kfz-2010-2019',
      segment,
      directionCode: 'forward',
      fromNode: 'A',
      toNode: 'B',
    },
    qualityNotes: ['Amtliche Kölner Liniengeometrie verbunden.'],
  };
}

function buildArtifact() {
  const ways = {
    10: { highway: 'primary', name: 'Eindeutige Straße' },
    20: { highway: 'primary', name: 'Parallel links' },
    30: { highway: 'primary', name: 'Parallel rechts' },
  };
  const wayGeometries = {
    10: geometry(0).coordinates.map(([lon, lat]) => ({ lon, lat })),
    20: geometry(98).coordinates.map(([lon, lat]) => ({ lon, lat })),
    30: geometry(102).coordinates.map(([lon, lat]) => ({ lon, lat })),
  };
  return matcher.buildMatchedArtifact(
    {
      file: '/tmp/official-geometry.json',
      sha256: 'a'.repeat(64),
      value: {
        schemaVersion: 1,
        type: matcher.INPUT_TYPE,
        source: {
          traffic: descriptor(),
          trafficDistribution: { path: 'counts.csv', sha256: '1'.repeat(64) },
          geometry: { id: 'traffic.geometry.koeln-kfz-2010-2019' },
        },
        observations: [
          observation('matched-2019', 'S1', 0, 18504),
          observation('ambiguous-2019', 'S2', 100, 22153),
        ],
      },
    },
    { file: '/tmp/osm_koeln.json', sha256: 'b'.repeat(64), value: { ways, wayGeometries } },
    { generatedAt: '2026-07-31T12:00:00Z' },
  );
}

function writeArtifact(root, artifact = buildArtifact()) {
  const file = path.join(root, 'koeln-kfz-osm-matches.json');
  fs.writeFileSync(file, `${JSON.stringify(artifact)}\n`);
  return { file, sha256: providerModule.sha256(fs.readFileSync(file)) };
}

function road(wayId, north) {
  return {
    wayId,
    coordinates: geometry(north).coordinates.map(([lon, lat]) => ({ lon, lat })),
  };
}

describe('Cologne OSM-matched traffic provider', () => {
  const roots = [];
  const makeRoot = () => {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'koeln-kfz-matched-provider-'));
    roots.push(value);
    return value;
  };
  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test('publishes only unambiguous matches through the common traffic SPI', async () => {
    const written = writeArtifact(makeRoot());
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

    const [value] = await provider.loadObservations({ city: 'Köln' });
    expect(value).toEqual(expect.objectContaining({
      observationId: 'matched-2019',
      measurementType: 'count',
      value: 18504,
      unit: 'Kfz/24 h',
      wayId: '10',
      direction: 'A → B; OSM-Way-Richtung: same',
    }));
    expect(value.match).toEqual(expect.objectContaining({ matchQuality: 'high', meanDistanceMeters: expect.any(Number),
      directionRelation: 'same', sourceWayId: expect.stringContaining('koeln-segment:') }));
    expect(provider.matchedArtifact.sources.traffic.sha256).toBe('a'.repeat(64));
    expect(value.qualityNotes.join(' ')).toMatch(/P95 0 m/);
    expect(value.source).toEqual(expect.objectContaining({
      sourceId: providerModule.PROVIDER_ID,
      licenseId: 'DL-DE-Zero-2.0',
      contentHash: written.sha256,
    }));
  });

  test('uses the existing age, road-match and fallback hierarchy', async () => {
    const written = writeArtifact(makeRoot());
    const provider = providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: written.file,
      expectedArtifactSha256: written.sha256,
    });
    const [value] = await provider.loadObservations({ city: 'Köln' });
    const match = traffic.matchObservationToRoads(value, [road('10', 0)]);
    const selected = traffic.selectTrafficEvidence([match], {
      referenceYear: 2026,
      maxFreshAgeYears: 5,
      mode: 'motor_vehicle',
    });

    expect(match).toEqual(expect.objectContaining({
      wayId: '10', distanceMeters: 0, matchQuality: 'high',
      matchMethod: 'explicit-way-id-with-geometry',
    }));
    expect(selected).toEqual(expect.objectContaining({
      evidenceType: 'stale-measured', ageYears: 7,
      warning: 'Messwert ist älter als die Frischegrenze.',
    }));
    expect(selected.statement).toMatch(/Älterer gemessener Verkehrswert/);
    expect(selected.statement).toMatch(/18[.\s]504 Kfz\/24 h/);
    expect(selected.statement).toMatch(/2019/);
  });

  test('pinned artifact application retains selected typed evidence and all source pins through proxy fallback', async () => {
    const root = makeRoot();
    const written = writeArtifact(root);
    const out = path.join(root, 'out');
    fs.mkdirSync(path.join(out, 'ctxtiles/koeln/1'), { recursive: true });
    const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value));
    write('ways_koeln.json', { ways: { 10: {}, 20: {} } });
    write('ctxtiles/koeln/index.json', { tiles: [{ x: 1, y: 2 }] });
    write('ctxtiles/koeln/1/2.json', { ways: { 10: {}, 20: {} } });
    write('output_all_years_koeln.geojson', { features: [10, 20].map(id => ({ properties: { matched_way_id: String(id) } })) });
    write('output_all_years_koeln.enrichment.meta.json', {});
    const { applyMatchedTraffic } = require('../../scripts/apply-matched-traffic');
    await applyMatchedTraffic({ root, city: 'Köln', artifactFile: written.file,
      expectedArtifactSha256: written.sha256, referenceYear: 2026 });
    const read = file => JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
    for (const row of [read('ways_koeln.json').ways['10'], read('ctxtiles/koeln/1/2.json').ways['10'],
      read('output_all_years_koeln.geojson').features[0].properties]) {
      expect(row).toEqual(expect.objectContaining({ traffic_measurement_type: 'count', traffic_volume_value: 18504,
        traffic_volume_year: 2019, traffic_evidence: expect.objectContaining({ evidenceType: 'stale-measured', ageYears: 7,
          matchQuality: 'high', observation: expect.objectContaining({ match: expect.objectContaining({ directionRelation: 'same' }) }) }) }));
      expect(row.traffic_artifact).toEqual(expect.objectContaining({ sha256: written.sha256,
        sources: expect.objectContaining({ osm: expect.objectContaining({ sha256: 'b'.repeat(64) }) }) }));
      const before = JSON.parse(JSON.stringify(row));
      expect(require('../../scripts/apply-qualitative-traffic-proxy').normalizeProxyRow(row,
        { proxyClass: 'high', highwayClass: 'primary' })).toBe(false);
      expect(row).toEqual(before);
    }
    expect(read('ways_koeln.json').ways['20']).not.toHaveProperty('traffic_volume_value');
    fs.mkdirSync(path.join(root, '.enrichment-cache/traffic'), { recursive: true });
    fs.writeFileSync(path.join(root, '.enrichment-cache/traffic/traffic_koeln.json'), JSON.stringify({
      measurementType: 'proxy', source: 'OSM-highway-class-proxy', ways: {
        10: { measurementType: 'proxy', proxyClass: 'high', highwayClass: 'primary' },
        20: { measurementType: 'proxy', proxyClass: 'low', highwayClass: 'residential' },
      } }));
    require('../../scripts/apply-qualitative-traffic-proxy').applyQualitativeTrafficProxy({ root, city: 'Köln' });
    expect(read('ways_koeln.json').ways['10'].traffic_volume_value).toBe(18504);
    expect(read('ways_koeln.json').ways['20'].traffic_measurement_type).toBe('proxy');
    expect(read('output_all_years_koeln.enrichment.meta.json').traffic).toEqual(expect.objectContaining({
      measurementType: 'mixed', numericValuesPresent: true, typedFeatures: 1, classifiedFeatures: 1 }));
    const meta = read('output_all_years_koeln.enrichment.meta.json');
    expect(meta.sources.trafficMatched.matchedArtifact).toEqual(expect.objectContaining({ sha256: written.sha256,
      sources: expect.objectContaining({ osm: expect.objectContaining({ sha256: 'b'.repeat(64) }) }) }));
  });

  test('supports fail-closed full-coverage production runs', () => {
    const written = writeArtifact(makeRoot());
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: written.file,
      expectedArtifactSha256: written.sha256,
      requireFullCoverage: true,
    })).toThrow(/incomplete_osm_coverage/);
  });

  test('rejects external hash drift and internal fingerprint drift', () => {
    const directory = makeRoot();
    const written = writeArtifact(directory);
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: written.file,
      expectedArtifactSha256: 'f'.repeat(64),
    })).toThrow(/artifact_hash_mismatch/);

    const artifact = JSON.parse(JSON.stringify(buildArtifact()));
    artifact.coverage.matchedObservations = 99;
    const tampered = writeArtifact(directory, artifact);
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: tampered.file,
      expectedArtifactSha256: tampered.sha256,
    })).toThrow(/artifact_fingerprint_mismatch/);
  });

  test('rejects symbolic-link artifact paths before reading bytes', () => {
    const directory = makeRoot();
    const written = writeArtifact(directory);
    const linked = path.join(directory, 'linked.json');
    fs.symlinkSync(written.file, linked);
    expect(() => providerModule.createKoelnKfzOsmMatchedProvider({
      artifactFile: linked,
      expectedArtifactSha256: written.sha256,
    })).toThrow(/unsafe_file/);
  });
});
