"use strict";

const elevation = require("../../js/ua.elevation_provider");

const ANCHOR = { lat: 52.3759, lon: 9.732 };
const METERS_PER_DEGREE_LON = 111320 * Math.cos((ANCHOR.lat * Math.PI) / 180);

function eastWestRoad(lengthMeters = 140) {
  const halfDegrees = lengthMeters / 2 / METERS_PER_DEGREE_LON;
  return [
    { lat: ANCHOR.lat, lon: ANCHOR.lon - halfDegrees },
    { lat: ANCHOR.lat, lon: ANCHOR.lon + halfDegrees },
  ];
}

function descriptor(overrides = {}) {
  return {
    ...elevation.createHannoverDgm1Descriptor("2026-07-21"),
    id: "test.dgm",
    ...overrides,
  };
}

function linearProvider(options = {}) {
  const slope = Number.isFinite(options.slope) ? options.slope : 0.05;
  const outlierAtAnchor = options.outlierAtAnchor || 0;
  return elevation.createProvider({
    descriptor: descriptor(options.descriptor),
    canProvide: options.canProvide,
    sampleElevations: (coordinates) =>
      coordinates.map((coordinate) => {
        const x = (coordinate.lon - ANCHOR.lon) * METERS_PER_DEGREE_LON;
        const outlier = Math.abs(x) < 1.5 ? outlierAtAnchor : 0;
        return 100 + x * slope + outlier;
      }),
  });
}

describe("provider-based elevation and road-gradient core", () => {
  test("exposes the identical browser and Node API without Leaflet", () => {
    expect(window.UA.elevationProvider).toBe(elevation);
    expect(elevation.SOURCE_TIERS.OFFICIAL_DGM_1_2).toBeLessThan(
      elevation.SOURCE_TIERS.GLOBAL_FALLBACK,
    );
  });

  test("registry resolves the highest-priority available provider deterministically", async () => {
    const registry = elevation.createRegistry();
    const fallback = linearProvider({
      descriptor: {
        id: "fallback",
        priority: 4,
        resolutionMeters: 30,
        modelType: "mixed",
      },
    });
    const dgm1 = linearProvider({
      descriptor: { id: "dgm1", priority: 1, resolutionMeters: 1 },
    });
    const unavailable = linearProvider({
      descriptor: { id: "unavailable", priority: 1, resolutionMeters: 0.5 },
      canProvide: () => false,
    });
    registry.register(fallback);
    registry.register(unavailable);
    registry.register(dgm1);

    await expect(registry.resolve({ city: "Hannover" })).resolves.toBe(dgm1);
    expect(registry.list().map((provider) => provider.id)).toEqual([
      "unavailable",
      "dgm1",
      "fallback",
    ]);
    expect(() => registry.register(dgm1)).toThrow(/duplicate_provider/);
  });

  test("computes a robust longitudinal gradient along the matched road", async () => {
    const result = await elevation.computeRoadGradient(
      linearProvider({ slope: 0.05 }),
      eastWestRoad(),
      ANCHOR,
      { windowMeters: 50, spacingMeters: 5, matchQuality: "high" },
    );

    expect(result.semanticType).toBe("road_longitudinal_gradient");
    expect(result.gradientPercent).toBeCloseTo(5.0, 1);
    expect(result.direction).toBe("uphill_along_geometry");
    expect(result.sampleCount).toBeGreaterThanOrEqual(20);
    expect(result.quality).toBe("high");
    expect(result.method).toBe("theil-sen-linear-profile-v1");
    expect(result.statement).toMatch(
      /Straßenlängsneigung: 5,0 % bergauf über 100 m/,
    );
    expect(result.source.id).toBe("test.dgm");
  });

  test("Theil-Sen fit resists one severe elevation outlier", async () => {
    const result = await elevation.computeRoadGradient(
      linearProvider({ slope: 0.04, outlierAtAnchor: 30 }),
      eastWestRoad(),
      ANCHOR,
      { windowMeters: 50, spacingMeters: 5, matchQuality: "high" },
    );

    expect(result.gradientPercent).toBeCloseTo(4.0, 1);
    expect(result.residualMadMeters).toBeLessThan(0.1);
    expect(result.sampleCount).toBeGreaterThanOrEqual(20);
  });

  test("normalizes direction relative to the supplied road geometry", async () => {
    const provider = linearProvider({ slope: 0.03 });
    const forward = await elevation.computeRoadGradient(
      provider,
      eastWestRoad(),
      ANCHOR,
      {
        windowMeters: 40,
        spacingMeters: 4,
        matchQuality: "high",
      },
    );
    const reverse = await elevation.computeRoadGradient(
      provider,
      eastWestRoad().slice().reverse(),
      ANCHOR,
      {
        windowMeters: 40,
        spacingMeters: 4,
        matchQuality: "high",
      },
    );

    expect(forward.gradientPercent).toBeCloseTo(3, 1);
    expect(reverse.gradientPercent).toBeCloseTo(-3, 1);
    expect(reverse.direction).toBe("downhill_along_geometry");
  });

  test.each([
    [{ bridge: "yes" }, "bridge_surface_not_represented_by_dtm"],
    [{ tunnel: "yes" }, "tunnel_surface_not_represented_by_dtm"],
  ])(
    "does not claim a road gradient for unsupported structures %p",
    async (osmTags, reason) => {
      const result = await elevation.computeRoadGradient(
        linearProvider(),
        eastWestRoad(),
        ANCHOR,
        { windowMeters: 40, spacingMeters: 4, matchQuality: "high", osmTags },
      );

      expect(result.usable).toBe(false);
      expect(result.quality).toBe("unusable");
      expect(result.gradientPercent).toBeNull();
      expect(result.uncertaintyReasons).toContain(reason);
      expect(result.statement).toMatch(/Keine belastbare Straßenlängsneigung/);
    },
  );

  test("degrades embankment, cutting and poor matching instead of hiding uncertainty", async () => {
    const result = await elevation.computeRoadGradient(
      linearProvider(),
      eastWestRoad(),
      { lat: ANCHOR.lat + 0.0003, lon: ANCHOR.lon },
      {
        windowMeters: 40,
        spacingMeters: 4,
        matchQuality: "low",
        osmTags: { embankment: "yes", cutting: "yes", layer: 1 },
      },
    );

    expect(result.usable).toBe(true);
    expect(result.quality).toBe("low");
    expect(result.uncertaintyReasons).toEqual(
      expect.arrayContaining([
        "embankment_may_differ_from_terrain",
        "cutting_may_differ_from_terrain",
        "non_ground_osm_layer",
        "low_road_match_quality",
        "accident_point_far_from_matched_road",
      ]),
    );
  });

  test("labels a coarse global model as terrain context without decimal precision", async () => {
    const fallback = elevation.createProvider({
      descriptor: {
        ...elevation.createGlobalFallbackDescriptor("2026-07-21"),
        id: "fallback.test",
      },
      sampleElevations: (coordinates) =>
        coordinates.map((coordinate) => {
          const x = (coordinate.lon - ANCHOR.lon) * METERS_PER_DEGREE_LON;
          return 100 + x * 0.035;
        }),
    });
    const result = await elevation.computeRoadGradient(
      fallback,
      eastWestRoad(180),
      ANCHOR,
      {
        windowMeters: 60,
        spacingMeters: 30,
        matchQuality: "high",
      },
    );

    expect(result.semanticType).toBe("terrain_context");
    expect(Number.isInteger(result.gradientPercent)).toBe(true);
    expect(result.quality).not.toBe("high");
    expect(result.uncertaintyReasons).toEqual(
      expect.arrayContaining([
        "coarse_global_elevation_model",
        "source_is_not_pure_dtm",
      ]),
    );
    expect(result.statement).toMatch(/Geländeneigung im Umfeld/);
    expect(result.statement).toMatch(/für die Fahrbahn nicht belastbar/);
  });

  test("fails closed on invalid descriptors and incomplete sample arrays", async () => {
    expect(() =>
      elevation.createProvider({
        descriptor: { ...descriptor(), resolutionMeters: 0 },
        sampleElevations: () => [],
      }),
    ).toThrow(/resolutionMeters/);

    const provider = elevation.createProvider({
      descriptor: descriptor(),
      sampleElevations: (coordinates) => coordinates.slice(1).map(() => 100),
    });
    await expect(
      elevation.computeRoadGradient(provider, eastWestRoad(), ANCHOR, {
        windowMeters: 40,
        spacingMeters: 4,
      }),
    ).rejects.toThrow(/invalid_samples/);
  });

  test("fails closed when geometry or source coverage cannot support a profile", async () => {
    const provider = elevation.createProvider({
      descriptor: descriptor(),
      sampleElevations: (coordinates) => coordinates.map(() => null),
    });
    await expect(
      elevation.computeRoadGradient(provider, eastWestRoad(), ANCHOR, {
        windowMeters: 40,
        spacingMeters: 4,
      }),
    ).rejects.toThrow(/insufficient_samples/);

    await expect(
      elevation.computeRoadGradient(linearProvider(), [ANCHOR], ANCHOR),
    ).rejects.toThrow(/invalid_geometry/);
  });

  test("Hannover DGM1 descriptor contains the required official provenance", () => {
    const dgm = elevation.createHannoverDgm1Descriptor("2026-07-21");
    expect(dgm).toEqual(
      expect.objectContaining({
        id: "hannover.dgm1",
        publisher: "Landeshauptstadt Hannover – Geoinformation",
        resolutionMeters: 1,
        modelType: "DTM",
        horizontalCrs: "EPSG:25832",
        licenseId: "CC-BY-4.0",
        priority: elevation.SOURCE_TIERS.OFFICIAL_DGM_1_2,
      }),
    );
    expect(dgm.datasetUrl).toMatch(/^https:\/\/www\.hannover\.de\//);
    expect(dgm.requiredAttribution).toMatch(/CC BY 4\.0/);
  });

  test("uses locale-independent code-point ordering for tied providers", () => {
    const registry = elevation.createRegistry();
    registry.register(
      linearProvider({
        descriptor: { id: "ä-provider", priority: 1, resolutionMeters: 1 },
      }),
    );
    registry.register(
      linearProvider({
        descriptor: { id: "z-provider", priority: 1, resolutionMeters: 1 },
      }),
    );
    expect(registry.list().map((provider) => provider.id)).toEqual([
      "z-provider",
      "ä-provider",
    ]);
  });

  test("does not degrade explicit negative embankment and cutting tags", async () => {
    const result = await elevation.computeRoadGradient(
      linearProvider(),
      eastWestRoad(),
      ANCHOR,
      {
        windowMeters: 40,
        spacingMeters: 4,
        matchQuality: "high",
        osmTags: { embankment: "no", cutting: "no" },
      },
    );
    expect(result.uncertaintyReasons).not.toContain(
      "embankment_may_differ_from_terrain",
    );
    expect(result.uncertaintyReasons).not.toContain(
      "cutting_may_differ_from_terrain",
    );
    expect(result.quality).toBe("high");
  });

  test("uses localized uncertainty explanations instead of machine codes", async () => {
    const result = await elevation.computeRoadGradient(
      linearProvider(),
      eastWestRoad(),
      ANCHOR,
      {
        windowMeters: 40,
        spacingMeters: 4,
        matchQuality: "high",
        osmTags: { bridge: "yes" },
      },
    );
    expect(result.statement).toMatch(
      /Brückenoberfläche ist im Geländemodell nicht abgebildet/,
    );
    expect(result.statement).not.toMatch(
      /bridge_surface_not_represented_by_dtm/,
    );
  });

  test("reports the actually sampled profile length near a geometry endpoint", async () => {
    const road = eastWestRoad(70);
    const result = await elevation.computeRoadGradient(
      linearProvider(),
      road,
      road[0],
      { windowMeters: 50, spacingMeters: 5, matchQuality: "high" },
    );
    expect(result.windowMeters).toBe(50);
    expect(result.profileLengthMeters).toBeCloseTo(50, 1);
    expect(result.statement).toMatch(/über 50 m/);
    expect(result.statement).not.toMatch(/über 100 m/);
  });

  test.each([
    "2026-02-31",
    "2026-07-21T25:00:00Z",
    "2026-07-21T12:00:00+14:30",
  ])("rejects impossible or malformed retrieval dates: %s", (retrievedAt) => {
    expect(() => elevation.createHannoverDgm1Descriptor(retrievedAt)).toThrow(
      /invalid_descriptor/,
    );
  });
});
