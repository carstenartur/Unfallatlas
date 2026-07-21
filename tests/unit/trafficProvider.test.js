'use strict';

const sourceManifest = require('../../js/ua.source_manifest');
const traffic = require('../../js/ua.traffic_provider');

const HASH = 'a'.repeat(64);
const BONN = { lat: 50.735, lon: 7.095 };

function sourceFields(overrides = {}) {
  return {
    publisher: 'Open-Data-Teststelle',
    datasetTitle: 'Verkehrszählungen Bonn',
    datasetUrl: 'https://example.org/datasets/traffic-counts',
    distributionUrl: 'https://example.org/downloads/traffic-counts.csv',
    licenseId: 'DL-DE-BY-2.0',
    licenseName: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/by-2-0',
    requiredAttribution: '© Open-Data-Teststelle, Verkehrszählungen Bonn',
    temporalCoverage: '2019–2025',
    spatialCoverage: 'Bonn',
    versionOrPublicationDate: '2026-01-15',
    retrievedAt: '2026-07-21T12:00:00Z',
    contentHash: HASH,
    changedOrDerived: true,
    changeNotice: 'Auf relevante Zählstellen gefiltert und auf Straßenabschnitte gematcht.',
    permissions: {
      permitsRedistribution: true,
      permitsDerivatives: true,
      commercialUseAllowed: true,
    },
    qualityNotes: ['Testfixture mit vollständiger Provenienz.'],
    ...overrides,
  };
}

function descriptor(measurementType, overrides = {}) {
  return {
    id: `traffic.${measurementType}.test`,
    ...sourceFields(),
    measurementType,
    modes: ['motor_vehicle'],
    unit: measurementType === 'proxy' ? null : 'Kfz/24 h',
    priority: measurementType === 'count' ? 1 : measurementType === 'model' ? 2 : 4,
    ...overrides,
  };
}

function pointGeometry(lat = BONN.lat, lon = BONN.lon) {
  return { type: 'Point', coordinates: [lon, lat] };
}

function road(wayId, latOffset = 0, lonOffset = 0) {
  return {
    wayId,
    coordinates: [
      { lat: BONN.lat + latOffset, lon: BONN.lon - 0.001 + lonOffset },
      { lat: BONN.lat + latOffset, lon: BONN.lon + 0.001 + lonOffset },
    ],
  };
}

function rawObservation(overrides = {}) {
  return {
    observationId: 'count-2024-main-road',
    measurementType: 'count',
    mode: 'motor_vehicle',
    year: 2024,
    period: 'DTVw',
    value: 18500,
    unit: 'Kfz/24 h',
    geometry: pointGeometry(),
    direction: 'Querschnitt, beide Richtungen',
    qualityNotes: ['Automatische Dauerzählstelle.'],
    ...overrides,
  };
}

function createProvider(measurementType, observations, overrides = {}) {
  return traffic.createProvider({
    descriptor: descriptor(measurementType, overrides.descriptor),
    canProvide: overrides.canProvide,
    loadObservations: async () => observations,
  });
}

describe('licensed traffic evidence provider core', () => {
  test('shares one source-manifest-backed contract between browser and Node', () => {
    expect(window.UA.sourceManifest).toBe(sourceManifest);
    expect(window.UA.trafficProvider).toBe(traffic);
    expect(traffic.MEASUREMENT_TYPES).toEqual(['count', 'model', 'proxy']);
  });

  test('normalizes a measured observation with complete linked provenance', async () => {
    const provider = createProvider('count', [rawObservation()]);
    const observations = await provider.loadObservations({ city: 'Bonn' });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(expect.objectContaining({
      observationId: 'count-2024-main-road',
      measurementType: 'count',
      mode: 'motor_vehicle',
      value: 18500,
      unit: 'Kfz/24 h',
      coordinate: BONN,
    }));
    expect(observations[0].source).toEqual(expect.objectContaining({
      sourceId: 'traffic.count.test',
      role: 'traffic_count',
      licenseId: 'DL-DE-BY-2.0',
      datasetUrl: 'https://example.org/datasets/traffic-counts',
    }));
    expect(Object.isFrozen(observations[0])).toBe(true);
  });

  test('registry collects only available providers in deterministic priority order', async () => {
    const registry = traffic.createRegistry();
    const proxy = createProvider('proxy', [traffic.createOsmProxyObservation({
      observationId: 'proxy-way-2', highway: 'secondary', wayId: '2', year: 2026,
    })]);
    const measured = createProvider('count', [rawObservation({ wayId: '1', geometry: undefined })]);
    const unavailableModel = createProvider('model', [rawObservation({
      observationId: 'model-unavailable', measurementType: 'model', year: 2025,
    })], { canProvide: () => false });

    registry.register(proxy);
    registry.register(unavailableModel);
    registry.register(measured);

    expect(registry.list().map(provider => provider.id)).toEqual([
      'traffic.count.test', 'traffic.model.test', 'traffic.proxy.test',
    ]);
    const collected = await registry.collect({ city: 'Bonn' });
    expect(collected.map(item => item.observationId)).toEqual([
      'count-2024-main-road', 'proxy-way-2',
    ]);
    expect(() => registry.register(measured)).toThrow(/duplicate_provider/);
  });

  test('matches an explicit way ID without inventing spatial uncertainty', async () => {
    const [observation] = await createProvider('count', [rawObservation({
      wayId: '42', geometry: undefined,
    })]).loadObservations();
    const match = traffic.matchObservationToRoads(observation, [road('7'), road('42')]);

    expect(match).toEqual(expect.objectContaining({
      wayId: '42',
      distanceMeters: 0,
      matchQuality: 'high',
      matchMethod: 'explicit-way-id',
    }));
  });

  test('matches point counts to the nearest road and reports distance quality', async () => {
    const [observation] = await createProvider('count', [rawObservation()]).loadObservations();
    const near = traffic.matchObservationToRoads(observation, [
      road('far', 0.002),
      road('near', 0.0002),
    ]);

    expect(near.wayId).toBe('near');
    expect(near.distanceMeters).toBeGreaterThan(20);
    expect(near.distanceMeters).toBeLessThan(25);
    expect(near.matchQuality).toBe('high');
    expect(traffic.matchObservationToRoads(observation, [road('too-far', 0.01)], {
      maxDistanceMeters: 100,
    })).toBeNull();
  });

  test('prefers a fresh measured count over model, stale count and proxy', async () => {
    const countProvider = createProvider('count', [rawObservation({ wayId: '1', geometry: undefined })]);
    const staleProvider = createProvider('count', [rawObservation({
      observationId: 'count-2015', year: 2015, value: 17000, wayId: '1', geometry: undefined,
    })], { descriptor: { id: 'traffic.count.stale', priority: 3 } });
    const modelProvider = createProvider('model', [rawObservation({
      observationId: 'model-2025', measurementType: 'model', year: 2025,
      value: 19000, wayId: '1', geometry: undefined,
    })]);
    const proxyProvider = createProvider('proxy', [traffic.createOsmProxyObservation({
      observationId: 'proxy-1', highway: 'primary', wayId: '1', year: 2026,
    })]);
    const observations = [
      ...(await proxyProvider.loadObservations()),
      ...(await modelProvider.loadObservations()),
      ...(await staleProvider.loadObservations()),
      ...(await countProvider.loadObservations()),
    ];
    const matches = observations.map(observation =>
      traffic.matchObservationToRoads(observation, [road('1')])
    );
    const result = traffic.selectTrafficEvidence(matches, {
      referenceYear: 2026,
      maxFreshAgeYears: 5,
      mode: 'motor_vehicle',
    });

    expect(result.evidenceType).toBe('measured');
    expect(result.observation.observationId).toBe('count-2024-main-road');
    expect(result.statement).toMatch(/Gemessene Verkehrsbelastung: 18[.\s]500 Kfz\/24 h/);
    expect(result.statement).toMatch(/DTVw 2024/);
  });

  test('prefers a current model over an outdated measured count', async () => {
    const staleProvider = createProvider('count', [rawObservation({
      observationId: 'count-2010', year: 2010, value: 13000, wayId: '1', geometry: undefined,
    })]);
    const modelProvider = createProvider('model', [rawObservation({
      observationId: 'model-2025', measurementType: 'model', year: 2025,
      value: 14500, wayId: '1', geometry: undefined,
    })]);
    const observations = [
      ...(await staleProvider.loadObservations()),
      ...(await modelProvider.loadObservations()),
    ];
    const result = traffic.selectTrafficEvidence(observations.map(observation =>
      traffic.matchObservationToRoads(observation, [road('1')])
    ), { referenceYear: 2026, maxFreshAgeYears: 5 });

    expect(result.evidenceType).toBe('model');
    expect(result.observation.observationId).toBe('model-2025');
    expect(result.statement).toMatch(/^Verkehrsmodell:/);
  });

  test('labels an old measured value and preserves its year', async () => {
    const provider = createProvider('count', [rawObservation({
      observationId: 'count-2012', year: 2012, value: 12500, wayId: '1', geometry: undefined,
    })]);
    const [observation] = await provider.loadObservations();
    const result = traffic.selectTrafficEvidence([
      traffic.matchObservationToRoads(observation, [road('1')]),
    ], { referenceYear: 2026, maxFreshAgeYears: 5 });

    expect(result.evidenceType).toBe('stale-measured');
    expect(result.ageYears).toBe(14);
    expect(result.warning).toMatch(/älter/);
    expect(result.statement).toMatch(/Älterer gemessener Verkehrswert/);
    expect(result.statement).toMatch(/2012/);
  });

  test('OSM fallback remains a qualitative proxy without invented DTV', async () => {
    const raw = traffic.createOsmProxyObservation({
      observationId: 'proxy-primary-1', highway: 'primary', wayId: '1', year: 2026,
    });
    expect(raw).toEqual(expect.objectContaining({
      measurementType: 'proxy', proxyClass: 'high', period: 'OSM highway=primary',
    }));
    expect(raw).not.toHaveProperty('value');
    expect(raw).not.toHaveProperty('unit');

    const provider = createProvider('proxy', [raw]);
    const [observation] = await provider.loadObservations();
    const result = traffic.selectTrafficEvidence([
      traffic.matchObservationToRoads(observation, [road('1')]),
    ], { referenceYear: 2026 });

    expect(result.evidenceType).toBe('proxy');
    expect(result.observation.value).toBeNull();
    expect(result.observation.unit).toBeNull();
    expect(result.statement).toMatch(/Verkehrsproxy: hohe Exposition/);
    expect(result.statement).toMatch(/keine Verkehrszählung/);
    expect(result.statement).not.toMatch(/Kfz\/24 h|DTV/);
  });

  test('rejects numeric proxy values and proxy units fail closed', async () => {
    expect(() => traffic.normalizeDescriptor(descriptor('proxy', { unit: 'Kfz/24 h' })))
      .toThrow(/proxy_numeric_unit_forbidden/);

    const provider = createProvider('proxy', [{
      ...traffic.createOsmProxyObservation({
        observationId: 'bad-proxy', highway: 'primary', wayId: '1', year: 2026,
      }),
      value: 15000,
      unit: 'Kfz/24 h',
    }]);
    await expect(provider.loadObservations()).rejects.toThrow(/proxy_numeric_value_forbidden/);
  });

  test('uses SourceManifest licence policy and rejects unclear or restrictive data', () => {
    expect(() => traffic.normalizeDescriptor(descriptor('count', {
      licenseId: 'Portal Terms',
      licenseName: 'Portal Terms',
    }))).toThrow(/unsupported_license/);

    expect(() => traffic.normalizeDescriptor(descriptor('count', {
      permissions: {
        permitsRedistribution: true,
        permitsDerivatives: false,
        commercialUseAllowed: true,
      },
    }))).toThrow(/restricted_source/);

    expect(() => traffic.normalizeDescriptor(descriptor('count', {
      requiredAttribution: '',
    }))).toThrow(/missing_attribution/);
  });

  test('rejects descriptor/observation type, mode, unit and location mismatches', async () => {
    const wrongType = createProvider('count', [rawObservation({ measurementType: 'model' })]);
    await expect(wrongType.loadObservations()).rejects.toThrow(/observation_type_mismatch/);

    const wrongMode = createProvider('count', [rawObservation({ mode: 'bicycle' })]);
    await expect(wrongMode.loadObservations()).rejects.toThrow(/observation_mode_mismatch/);

    const wrongUnit = createProvider('count', [rawObservation({ unit: 'Fahrzeuge/Stunde' })]);
    await expect(wrongUnit.loadObservations()).rejects.toThrow(/observation_unit_mismatch/);

    const noLocation = createProvider('count', [rawObservation({ geometry: undefined, wayId: undefined })]);
    await expect(noLocation.loadObservations()).rejects.toThrow(/missing_location/);
  });

  test('keeps modes separate when selecting evidence', async () => {
    const motorProvider = createProvider('count', [rawObservation({
      observationId: 'motor', wayId: '1', geometry: undefined,
    })]);
    const bicycleProvider = createProvider('count', [{
      ...rawObservation({
        observationId: 'bike', mode: 'bicycle', value: 1800,
        unit: 'Fahrräder/24 h', wayId: '1', geometry: undefined,
      }),
    }], { descriptor: {
      id: 'traffic.bicycle.count', modes: ['bicycle'], unit: 'Fahrräder/24 h',
    } });
    const observations = [
      ...(await motorProvider.loadObservations()),
      ...(await bicycleProvider.loadObservations()),
    ];
    const matches = observations.map(observation =>
      traffic.matchObservationToRoads(observation, [road('1')])
    );

    expect(traffic.selectTrafficEvidence(matches, {
      referenceYear: 2026, mode: 'bicycle',
    }).observation.observationId).toBe('bike');
    expect(traffic.selectTrafficEvidence(matches, {
      referenceYear: 2026, mode: 'motor_vehicle',
    }).observation.observationId).toBe('motor');
  });
});
