/**
 * Licensed traffic-count/model/proxy provider boundary.
 *
 * Providers return typed observations. Matching and evidence selection preserve
 * measurement type, direction, age, distance and provenance; an OSM highway
 * proxy can never acquire an invented vehicles-per-day value.
 */
(function initTrafficProvider(root, factory) {
  const dependency =
    typeof module !== "undefined" && module.exports
      ? require("./ua.source_manifest")
      : root && root.UA && root.UA.sourceManifest;
  const api = factory(dependency);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.trafficProvider = api;
  }
})(
  typeof window !== "undefined" ? window : null,
  function createTrafficProviderApi(sourceManifest) {
    "use strict";

    if (
      !sourceManifest ||
      typeof sourceManifest.normalizeManifest !== "function"
    ) {
      throw new Error(
        "ua.source_manifest.js must be loaded before ua.traffic_provider.js",
      );
    }

    const MEASUREMENT_TYPES = Object.freeze(["count", "model", "proxy"]);
    const MODES = Object.freeze([
      "motor_vehicle",
      "heavy_vehicle",
      "bicycle",
      "pedestrian",
      "other",
    ]);
    const PROXY_CLASSES = Object.freeze(["low", "medium", "high", "very_high"]);
    const MATCH_QUALITIES = Object.freeze(["high", "medium", "low"]);
    const PROXY_LABELS_DE = Object.freeze({
      low: "niedrige",
      medium: "mittlere",
      high: "hohe",
      very_high: "sehr hohe",
    });
    const ZERO_HASH = "0".repeat(64);

    class TrafficProviderError extends Error {
      constructor(code, message, details) {
        super(message ? `${code}: ${message}` : code);
        this.name = "TrafficProviderError";
        this.code = code;
        this.details = details || null;
      }
    }

    function fail(code, message, details) {
      throw new TrafficProviderError(code, message, details);
    }

    function requiredString(value, path) {
      if (typeof value !== "string" || !value.trim()) {
        fail("invalid_value", `${path} must be a non-empty string`);
      }
      return value.trim();
    }

    function finiteNumber(value, path) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        fail("invalid_value", `${path} must be a finite non-negative number`);
      }
      return number;
    }

    function enumValue(value, path, allowed, code) {
      const normalized = requiredString(value, path);
      if (!allowed.includes(normalized)) {
        fail(code, `${path} has unsupported value ${normalized}`);
      }
      return normalized;
    }

    function compareStrings(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }

    function uniqueStrings(value, path, allowed) {
      if (!Array.isArray(value) || value.length === 0) {
        fail("invalid_value", `${path} must be a non-empty array`);
      }
      const result = [
        ...new Set(
          value.map((item, index) => requiredString(item, `${path}[${index}]`)),
        ),
      ];
      const invalid = allowed
        ? result.filter((item) => !allowed.includes(item))
        : [];
      if (invalid.length)
        fail(
          "invalid_value",
          `${path} contains unsupported values: ${invalid.join(", ")}`,
        );
      return result.sort(compareStrings);
    }

    function validateSourceRecord(value) {
      const record = {
        sourceId: value.id,
        role: "traffic_count",
        publisher: value.publisher,
        datasetTitle: value.datasetTitle,
        datasetUrl: value.datasetUrl,
        distributionUrl: value.distributionUrl,
        licenseId: value.licenseId,
        licenseName: value.licenseName,
        licenseUrl: value.licenseUrl,
        requiredAttribution: value.requiredAttribution,
        temporalCoverage: value.temporalCoverage,
        spatialCoverage: value.spatialCoverage,
        versionOrPublicationDate: value.versionOrPublicationDate,
        retrievedAt: value.retrievedAt,
        contentHash: value.contentHash,
        changedOrDerived: value.changedOrDerived,
        changeNotice: value.changeNotice,
        qualityNotes: value.qualityNotes,
        permissions: value.permissions,
      };
      const source = Object.fromEntries(
        Object.entries(record).filter(([, item]) => item !== undefined),
      );
      return sourceManifest.normalizeManifest({
        schemaVersion: 1,
        artifactId: "traffic-source-contract",
        generatedAt: value.retrievedAt,
        applicationVersion: "traffic-provider-v1",
        buildFingerprint: ZERO_HASH,
        dataFingerprint: ZERO_HASH,
        scenario: {
          city: requiredString(value.spatialCoverage, "spatialCoverage"),
          filters: {},
        },
        sources: [source],
        transformations: [],
      }).sources[0];
    }

    function normalizeDescriptor(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(
          "invalid_descriptor",
          "traffic source descriptor must be an object",
        );
      }
      const measurementType = enumValue(
        value.measurementType,
        "measurementType",
        MEASUREMENT_TYPES,
        "invalid_measurement_type",
      );
      const modes = uniqueStrings(value.modes, "modes", MODES);
      const unit =
        value.unit == null ? null : requiredString(value.unit, "unit");
      if (measurementType === "proxy" && unit) {
        fail(
          "proxy_numeric_unit_forbidden",
          "proxy descriptors must not declare a numeric traffic unit",
        );
      }
      if (measurementType !== "proxy" && !unit) {
        fail(
          "missing_unit",
          `${measurementType} descriptors require an explicit unit`,
        );
      }
      const priority = Number(value.priority);
      if (!Number.isInteger(priority) || priority < 1 || priority > 99) {
        fail("invalid_descriptor", "priority must be an integer from 1 to 99");
      }
      const source = validateSourceRecord({
        ...value,
        id: requiredString(value.id, "id"),
      });
      return Object.freeze({
        ...source,
        id: source.sourceId,
        measurementType,
        modes: Object.freeze(modes),
        unit,
        priority,
      });
    }

    function normalizeCoordinate(value, path) {
      let lat;
      let lon;
      if (Array.isArray(value)) {
        if (value.length !== 2)
          fail("invalid_coordinate", `${path} must contain two values`);
        [lon, lat] = value;
      } else if (value && typeof value === "object") {
        ({ lat, lon } = value);
      }
      lat = Number(lat);
      lon = Number(lon);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        fail("invalid_coordinate", `${path} is not a valid coordinate`);
      }
      return Object.freeze({ lat, lon });
    }

    function representativeCoordinate(geometry, path) {
      if (!geometry || typeof geometry !== "object") {
        fail("invalid_geometry", `${path} must be GeoJSON geometry`);
      }
      if (geometry.type === "Point") {
        return normalizeCoordinate(geometry.coordinates, `${path}.coordinates`);
      }
      if (
        geometry.type !== "LineString" ||
        !Array.isArray(geometry.coordinates) ||
        geometry.coordinates.length < 2
      ) {
        fail(
          "invalid_geometry",
          `${path} must be Point or a LineString with at least two points`,
        );
      }
      const coordinates = geometry.coordinates.map((item, index) =>
        normalizeCoordinate(item, `${path}.coordinates[${index}]`),
      );
      const middle = (coordinates.length - 1) / 2;
      const lower = coordinates[Math.floor(middle)];
      const upper = coordinates[Math.ceil(middle)];
      return Object.freeze({
        lat: (lower.lat + upper.lat) / 2,
        lon: (lower.lon + upper.lon) / 2,
      });
    }

    function normalizeObservation(value, descriptor, index) {
      const path = `observations[${index}]`;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("invalid_observation", `${path} must be an object`);
      }
      const measurementType = enumValue(
        value.measurementType == null
          ? descriptor.measurementType
          : value.measurementType,
        `${path}.measurementType`,
        MEASUREMENT_TYPES,
        "invalid_measurement_type",
      );
      if (measurementType !== descriptor.measurementType) {
        fail(
          "observation_type_mismatch",
          `${path} type does not match provider descriptor`,
        );
      }
      const mode = enumValue(value.mode, `${path}.mode`, MODES, "invalid_mode");
      if (!descriptor.modes.includes(mode)) {
        fail(
          "observation_mode_mismatch",
          `${path} mode is not declared by provider`,
        );
      }
      const year = Number(value.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2100) {
        fail("invalid_year", `${path}.year is invalid`);
      }

      let numericValue = null;
      let proxyClass = null;
      if (measurementType === "proxy") {
        if (value.value != null || value.unit != null) {
          fail(
            "proxy_numeric_value_forbidden",
            `${path} proxy must not carry a numeric value or unit`,
          );
        }
        proxyClass = enumValue(
          value.proxyClass,
          `${path}.proxyClass`,
          PROXY_CLASSES,
          "invalid_proxy_class",
        );
      } else {
        numericValue = finiteNumber(value.value, `${path}.value`);
        const unit = requiredString(value.unit, `${path}.unit`);
        if (unit !== descriptor.unit) {
          fail(
            "observation_unit_mismatch",
            `${path}.unit does not match provider descriptor`,
          );
        }
      }

      const geometry = value.geometry || null;
      const coordinate = geometry
        ? representativeCoordinate(geometry, `${path}.geometry`)
        : null;
      const wayId =
        value.wayId == null
          ? null
          : requiredString(String(value.wayId), `${path}.wayId`);
      if (!coordinate && !wayId)
        fail("missing_location", `${path} requires geometry or wayId`);

      return Object.freeze({
        observationId: requiredString(
          value.observationId,
          `${path}.observationId`,
        ),
        sourceId: descriptor.sourceId,
        measurementType,
        mode,
        year,
        period: requiredString(value.period, `${path}.period`),
        value: numericValue,
        unit: measurementType === "proxy" ? null : descriptor.unit,
        proxyClass,
        coordinate,
        geometry,
        wayId,
        direction:
          value.direction == null
            ? null
            : requiredString(value.direction, `${path}.direction`),
        qualityNotes: Object.freeze(
          Array.isArray(value.qualityNotes)
            ? value.qualityNotes.map((item, noteIndex) =>
                requiredString(item, `${path}.qualityNotes[${noteIndex}]`),
              )
            : [],
        ),
        source: descriptor,
      });
    }

    function createProvider(options) {
      const opts = options || {};
      const descriptor = normalizeDescriptor(opts.descriptor);
      if (typeof opts.loadObservations !== "function") {
        fail(
          "invalid_provider",
          `${descriptor.id} must implement loadObservations(context)`,
        );
      }
      const canProvide =
        typeof opts.canProvide === "function" ? opts.canProvide : () => true;
      return Object.freeze({
        id: descriptor.id,
        descriptor,
        async canProvide(context) {
          return Boolean(await canProvide(context || {}));
        },
        async loadObservations(context) {
          const raw = await opts.loadObservations(context || {});
          if (!Array.isArray(raw))
            fail(
              "invalid_observations",
              `${descriptor.id} did not return an array`,
            );
          const observations = raw.map((item, observationIndex) =>
            normalizeObservation(item, descriptor, observationIndex),
          );
          const ids = new Set();
          for (const observation of observations) {
            if (ids.has(observation.observationId)) {
              fail(
                "duplicate_observation",
                `${descriptor.id} returned duplicate ${observation.observationId}`,
              );
            }
            ids.add(observation.observationId);
          }
          return Object.freeze(observations);
        },
      });
    }

    function createRegistry() {
      const entries = new Map();
      const list = () =>
        [...entries.values()].sort(
          (left, right) =>
            left.descriptor.priority - right.descriptor.priority ||
            compareStrings(left.id, right.id),
        );
      return Object.freeze({
        register(provider) {
          if (
            !provider ||
            !provider.descriptor ||
            typeof provider.canProvide !== "function" ||
            typeof provider.loadObservations !== "function"
          ) {
            fail(
              "invalid_provider",
              "provider does not implement the traffic contract",
            );
          }
          if (entries.has(provider.id))
            fail(
              "duplicate_provider",
              `provider ${provider.id} already registered`,
            );
          entries.set(provider.id, provider);
          return provider;
        },
        get(id) {
          return entries.get(id) || null;
        },
        list,
        async collect(context) {
          const result = [];
          for (const provider of list()) {
            try {
              if (!(await provider.canProvide(context || {}))) continue;
              result.push(...(await provider.loadObservations(context || {})));
            } catch (error) {
              if (context && context.failOnProviderError) throw error;
            }
          }
          return Object.freeze(result);
        },
        clear() {
          entries.clear();
        },
      });
    }

    function localProjection(origin) {
      const metersPerLon =
        111320 *
        Math.max(0.01, Math.abs(Math.cos((origin.lat * Math.PI) / 180)));
      return (coordinate) => ({
        x: (coordinate.lon - origin.lon) * metersPerLon,
        y: (coordinate.lat - origin.lat) * 110540,
      });
    }

    function roadCoordinates(road, path) {
      if (
        !road ||
        typeof road !== "object" ||
        !Array.isArray(road.coordinates) ||
        road.coordinates.length < 2
      ) {
        fail(
          "invalid_road",
          `${path}.coordinates requires at least two points`,
        );
      }
      return road.coordinates.map((item, index) =>
        normalizeCoordinate(item, `${path}.coordinates[${index}]`),
      );
    }

    function pointToRoadDistance(coordinate, road, path) {
      const points = roadCoordinates(road, path);
      const project = localProjection(coordinate);
      const projected = points.map(project);
      let best = Infinity;
      for (let index = 0; index < projected.length - 1; index += 1) {
        const start = projected[index];
        const end = projected[index + 1];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const denominator = dx * dx + dy * dy;
        const t = denominator
          ? Math.max(
              0,
              Math.min(1, -(start.x * dx + start.y * dy) / denominator),
            )
          : 0;
        best = Math.min(best, Math.hypot(start.x + t * dx, start.y + t * dy));
      }
      return best;
    }

    function matchQuality(distanceMeters) {
      if (distanceMeters <= 25) return "high";
      if (distanceMeters <= 100) return "medium";
      return "low";
    }

    function matchObservationToRoads(observation, roads, options) {
      if (!observation || !observation.source) {
        fail("invalid_observation", "normalized observation required");
      }
      if (!Array.isArray(roads) || roads.length === 0) return null;
      const maxDistanceMeters = Math.max(
        1,
        Number(options && options.maxDistanceMeters) || 250,
      );
      if (observation.wayId) {
        const exactIndex = roads.findIndex(
          (road) => String(road.wayId) === observation.wayId,
        );
        if (exactIndex >= 0) {
          const exact = roads[exactIndex];
          if (!observation.coordinate) {
            return Object.freeze({
              observation,
              road: exact,
              wayId: String(exact.wayId),
              distanceMeters: null,
              matchQuality: "medium",
              matchMethod: "explicit-way-id-without-geometry",
            });
          }
          const distanceMeters = pointToRoadDistance(
            observation.coordinate,
            exact,
            `roads[${exactIndex}]`,
          );
          if (distanceMeters > maxDistanceMeters) return null;
          return Object.freeze({
            observation,
            road: exact,
            wayId: String(exact.wayId),
            distanceMeters: Math.round(distanceMeters * 10) / 10,
            matchQuality: matchQuality(distanceMeters),
            matchMethod: "explicit-way-id-with-geometry",
          });
        }
      }
      if (!observation.coordinate) return null;
      let best = null;
      roads.forEach((road, index) => {
        const distanceMeters = pointToRoadDistance(
          observation.coordinate,
          road,
          `roads[${index}]`,
        );
        if (!best || distanceMeters < best.distanceMeters)
          best = { road, distanceMeters };
      });
      if (!best || best.distanceMeters > maxDistanceMeters) return null;
      return Object.freeze({
        observation,
        road: best.road,
        wayId: String(best.road.wayId),
        distanceMeters: Math.round(best.distanceMeters * 10) / 10,
        matchQuality: matchQuality(best.distanceMeters),
        matchMethod: "nearest-road-segment",
      });
    }

    function evidenceRank(match, referenceYear, maxFreshAgeYears) {
      const type = match.observation.measurementType;
      const ageYears = referenceYear - match.observation.year;
      if (ageYears < 0) return 99;
      if (type === "count" && ageYears <= maxFreshAgeYears) return 1;
      if (type === "model") return 2;
      if (type === "count") return 3;
      if (type === "proxy") return 4;
      return 99;
    }

    function selectTrafficEvidence(matches, options) {
      const opts = options || {};
      const referenceYear = Number(opts.referenceYear);
      if (!Number.isInteger(referenceYear)) {
        fail("invalid_reference_year", "referenceYear must be an integer");
      }
      const maxFreshAgeYears =
        opts.maxFreshAgeYears == null ? 5 : Number(opts.maxFreshAgeYears);
      if (!Number.isFinite(maxFreshAgeYears) || maxFreshAgeYears < 0) {
        fail(
          "invalid_fresh_age",
          "maxFreshAgeYears must be a finite non-negative number",
        );
      }
      const mode =
        opts.mode == null
          ? null
          : enumValue(opts.mode, "mode", MODES, "invalid_mode");
      const candidates = (Array.isArray(matches) ? matches : [])
        .filter(Boolean)
        .filter((match) => !mode || match.observation.mode === mode)
        .filter((match) => match.observation.year <= referenceYear)
        .map((match) => ({
          ...match,
          ageYears: referenceYear - match.observation.year,
          rank: evidenceRank(match, referenceYear, maxFreshAgeYears),
        }))
        .sort(
          (left, right) =>
            left.rank - right.rank ||
            right.observation.year - left.observation.year ||
            (Number.isFinite(left.distanceMeters)
              ? left.distanceMeters
              : Infinity) -
              (Number.isFinite(right.distanceMeters)
                ? right.distanceMeters
                : Infinity) ||
            compareStrings(
              left.observation.observationId,
              right.observation.observationId,
            ),
        );

      if (!candidates.length) {
        return Object.freeze({
          evidenceType: "none",
          observation: null,
          statement: "Keine belastbare Verkehrsangabe verfügbar.",
        });
      }
      const selected = candidates[0];
      const evidenceType =
        selected.rank === 1
          ? "measured"
          : selected.rank === 2
            ? "model"
            : selected.rank === 3
              ? "stale-measured"
              : "proxy";
      const result = {
        evidenceType,
        observation: selected.observation,
        source: selected.observation.source,
        wayId: selected.wayId,
        distanceMeters: selected.distanceMeters,
        matchQuality: selected.matchQuality,
        matchMethod: selected.matchMethod,
        ageYears: selected.ageYears,
        warning:
          evidenceType === "stale-measured"
            ? "Messwert ist älter als die Frischegrenze."
            : null,
      };
      result.statement = formatTrafficStatement(result);
      return Object.freeze(result);
    }

    function formatInteger(value) {
      return new Intl.NumberFormat("de-DE", {
        maximumFractionDigits: 0,
      }).format(value);
    }

    function formatTrafficStatement(result) {
      if (!result || result.evidenceType === "none" || !result.observation) {
        return "Keine belastbare Verkehrsangabe verfügbar.";
      }
      const observation = result.observation;
      if (result.evidenceType === "proxy") {
        const label =
          PROXY_LABELS_DE[observation.proxyClass] || observation.proxyClass;
        return (
          `Verkehrsproxy: ${label} Exposition aus OSM-Straßenklasse; ` +
          `keine Verkehrszählung (${observation.source.publisher}).`
        );
      }
      const distance = Number.isFinite(result.distanceMeters)
        ? `, ${Math.round(result.distanceMeters)} m entfernt`
        : "";
      const label =
        result.evidenceType === "model"
          ? "Verkehrsmodell"
          : result.evidenceType === "stale-measured"
            ? "Älterer gemessener Verkehrswert"
            : "Gemessene Verkehrsbelastung";
      const stale =
        result.evidenceType === "stale-measured"
          ? "; veralteter Messstand"
          : "";
      return (
        `${label}: ${formatInteger(observation.value)} ${observation.unit} ` +
        `(${observation.period} ${observation.year}${distance}, ${observation.source.publisher}${stale}).`
      );
    }

    function createOsmProxyObservation(input) {
      const value = input || {};
      const highway = requiredString(value.highway, "highway");
      const classByHighway = {
        motorway: "very_high",
        trunk: "very_high",
        primary: "high",
        secondary: "high",
        tertiary: "medium",
        unclassified: "medium",
        residential: "low",
        living_street: "low",
        service: "low",
      };
      const proxyClass = classByHighway[highway];
      if (!proxyClass) {
        fail(
          "unsupported_highway_proxy",
          `no proxy mapping for highway=${highway}`,
        );
      }
      return {
        observationId: requiredString(value.observationId, "observationId"),
        measurementType: "proxy",
        mode: value.mode || "motor_vehicle",
        year: Number(value.year),
        period: `OSM highway=${highway}`,
        proxyClass,
        wayId: requiredString(String(value.wayId), "wayId"),
        direction: value.direction || null,
        qualityNotes: [
          "OSM-Straßenklassenproxy; kein Messwert und kein DTV-Schätzwert.",
        ],
      };
    }

    return Object.freeze({
      MEASUREMENT_TYPES,
      MODES,
      PROXY_CLASSES,
      MATCH_QUALITIES,
      PROXY_LABELS_DE,
      TrafficProviderError,
      normalizeDescriptor,
      normalizeObservation,
      createProvider,
      createRegistry,
      matchObservationToRoads,
      selectTrafficEvidence,
      formatTrafficStatement,
      createOsmProxyObservation,
      _test: Object.freeze({ evidenceRank, matchQuality, pointToRoadDistance }),
    });
  },
);
