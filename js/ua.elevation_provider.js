/**
 * Provider-based, uncertainty-aware road-gradient analysis.
 *
 * The module is deliberately independent from Leaflet, DOM and physical file
 * paths. Providers own elevation access; consumers supply a matched road
 * geometry and receive a provenance-rich semantic result suitable for every
 * renderer.
 */
(function initElevationProvider(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.elevationProvider = api;
  }
})(
  typeof window !== "undefined" ? window : null,
  function createElevationProviderApi() {
    "use strict";

    const EARTH_METERS_PER_DEGREE_LAT = 110540;
    const SOURCE_TIERS = Object.freeze({
      OFFICIAL_DGM_1_2: 1,
      OFFICIAL_DGM_5_10: 2,
      MUNICIPAL_OR_STATE_SERVICE: 3,
      GLOBAL_FALLBACK: 4,
    });
    const MODEL_TYPES = Object.freeze(["DTM", "DSM", "mixed"]);
    const QUALITY_VALUES = Object.freeze(["high", "medium", "low", "unusable"]);

    class ElevationProviderError extends Error {
      constructor(code, message, details) {
        super(message ? `${code}: ${message}` : code);
        this.name = "ElevationProviderError";
        this.code = code;
        this.details = details || null;
      }
    }

    function fail(code, message, details) {
      throw new ElevationProviderError(code, message, details);
    }

    function requiredString(value, path) {
      if (typeof value !== "string" || !value.trim())
        fail("invalid_descriptor", `${path} must be a non-empty string`);
      return value.trim();
    }

    function httpsUrl(value, path, optional) {
      if ((value == null || value === "") && optional) return undefined;
      const text = requiredString(value, path);
      let parsed;
      try {
        parsed = new URL(text);
      } catch (_) {
        fail("invalid_descriptor", `${path} must be an absolute URL`);
      }
      if (parsed.protocol !== "https:")
        fail("invalid_descriptor", `${path} must use https`);
      parsed.hash = "";
      return parsed.toString();
    }

    function isoDate(value, path) {
      const text = requiredString(value, path);
      const match =
        /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(
          text,
        );
      if (!match)
        fail(
          "invalid_descriptor",
          `${path} must be ISO-8601 with an explicit timezone`,
        );
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const calendarDate = new Date(Date.UTC(year, month - 1, day));
      if (
        calendarDate.getUTCFullYear() !== year ||
        calendarDate.getUTCMonth() !== month - 1 ||
        calendarDate.getUTCDate() !== day
      ) {
        fail(
          "invalid_descriptor",
          `${path} contains an impossible calendar date`,
        );
      }
      if (match[4] != null) {
        const hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = match[6] == null ? 0 : Number(match[6]);
        if (
          hour > 23 ||
          minute > 59 ||
          second > 59 ||
          !Number.isFinite(Date.parse(text))
        ) {
          fail("invalid_descriptor", `${path} contains an invalid timestamp`);
        }
        if (match[7] !== "Z") {
          const offsetHour = Number(match[7].slice(1, 3));
          const offsetMinute = Number(match[7].slice(4, 6));
          if (
            offsetHour > 14 ||
            offsetMinute > 59 ||
            (offsetHour === 14 && offsetMinute !== 0)
          ) {
            fail(
              "invalid_descriptor",
              `${path} contains an invalid timezone offset`,
            );
          }
        }
      }
      return text;
    }

    function normalizeDescriptor(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("invalid_descriptor", "descriptor must be an object");
      }
      const resolutionMeters = Number(value.resolutionMeters);
      if (!Number.isFinite(resolutionMeters) || resolutionMeters <= 0) {
        fail("invalid_descriptor", "resolutionMeters must be positive");
      }
      const priority = Number(value.priority);
      if (!Number.isInteger(priority) || priority < 1 || priority > 99) {
        fail("invalid_descriptor", "priority must be an integer from 1 to 99");
      }
      const modelType = requiredString(value.modelType, "modelType");
      if (!MODEL_TYPES.includes(modelType))
        fail("invalid_descriptor", `unsupported modelType ${modelType}`);
      return Object.freeze({
        id: requiredString(value.id, "id"),
        publisher: requiredString(value.publisher, "publisher"),
        datasetTitle: requiredString(value.datasetTitle, "datasetTitle"),
        datasetUrl: httpsUrl(value.datasetUrl, "datasetUrl"),
        ...(value.distributionUrl
          ? {
              distributionUrl: httpsUrl(
                value.distributionUrl,
                "distributionUrl",
              ),
            }
          : {}),
        licenseId: requiredString(value.licenseId, "licenseId"),
        licenseName: requiredString(value.licenseName, "licenseName"),
        licenseUrl: httpsUrl(value.licenseUrl, "licenseUrl"),
        requiredAttribution: requiredString(
          value.requiredAttribution,
          "requiredAttribution",
        ),
        resolutionMeters,
        modelType,
        horizontalCrs: requiredString(value.horizontalCrs, "horizontalCrs"),
        ...(value.verticalDatum
          ? {
              verticalDatum: requiredString(
                value.verticalDatum,
                "verticalDatum",
              ),
            }
          : {}),
        ...(value.acquisitionPeriod
          ? {
              acquisitionPeriod: requiredString(
                value.acquisitionPeriod,
                "acquisitionPeriod",
              ),
            }
          : {}),
        ...(value.publicationDate
          ? {
              publicationDate: requiredString(
                value.publicationDate,
                "publicationDate",
              ),
            }
          : {}),
        retrievedAt: isoDate(value.retrievedAt, "retrievedAt"),
        ...(value.modifiedDataNotice
          ? {
              modifiedDataNotice: requiredString(
                value.modifiedDataNotice,
                "modifiedDataNotice",
              ),
            }
          : {}),
        priority,
      });
    }

    function createProvider(options) {
      const opts = options || {};
      const descriptor = normalizeDescriptor(opts.descriptor);
      if (typeof opts.sampleElevations !== "function") {
        fail(
          "invalid_provider",
          `${descriptor.id} must implement sampleElevations(coordinates, context)`,
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
        async sampleElevations(coordinates, context) {
          const result = await opts.sampleElevations(
            coordinates,
            context || {},
          );
          if (!Array.isArray(result) || result.length !== coordinates.length) {
            fail(
              "invalid_samples",
              `${descriptor.id} returned ${result && result.length} samples for ${coordinates.length} coordinates`,
            );
          }
          return result.map((value, index) => {
            if (value == null) return null;
            const number = Number(
              typeof value === "object" ? value.elevation : value,
            );
            if (!Number.isFinite(number))
              fail(
                "invalid_samples",
                `${descriptor.id} sample ${index} is not finite`,
              );
            return number;
          });
        },
      });
    }

    function createRegistry() {
      const entries = new Map();
      return Object.freeze({
        register(provider) {
          if (
            !provider ||
            !provider.descriptor ||
            typeof provider.canProvide !== "function" ||
            typeof provider.sampleElevations !== "function"
          ) {
            fail(
              "invalid_provider",
              "provider does not implement the elevation contract",
            );
          }
          if (entries.has(provider.id))
            fail(
              "duplicate_provider",
              `provider ${provider.id} is already registered`,
            );
          entries.set(provider.id, provider);
          return provider;
        },
        get(id) {
          return entries.get(id) || null;
        },
        list() {
          return [...entries.values()].sort(compareProviders);
        },
        async resolve(context) {
          for (const provider of [...entries.values()].sort(compareProviders)) {
            try {
              if (await provider.canProvide(context || {})) return provider;
            } catch (_) {
              // A broken provider is skipped; callers receive null when none remain.
            }
          }
          return null;
        },
        clear() {
          entries.clear();
        },
      });
    }

    function compareProviders(left, right) {
      const priority = left.descriptor.priority - right.descriptor.priority;
      if (priority) return priority;
      const resolution =
        left.descriptor.resolutionMeters - right.descriptor.resolutionMeters;
      if (resolution) return resolution;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }

    function normalizeCoordinate(value, path) {
      let lat, lon;
      if (Array.isArray(value)) [lat, lon] = value;
      else if (value && typeof value === "object") ({ lat, lon } = value);
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
        fail("invalid_geometry", `${path} is not a valid lat/lon coordinate`);
      }
      return { lat, lon };
    }

    function localProjection(origin) {
      const cosine = Math.cos((origin.lat * Math.PI) / 180);
      const metersPerDegreeLon = 111320 * Math.max(0.01, Math.abs(cosine));
      return {
        toXY(coordinate) {
          return {
            x: (coordinate.lon - origin.lon) * metersPerDegreeLon,
            y: (coordinate.lat - origin.lat) * EARTH_METERS_PER_DEGREE_LAT,
          };
        },
        toLatLon(point) {
          return {
            lat: origin.lat + point.y / EARTH_METERS_PER_DEGREE_LAT,
            lon: origin.lon + point.x / metersPerDegreeLon,
          };
        },
      };
    }

    function preparePolyline(geometry, anchorValue) {
      if (!Array.isArray(geometry) || geometry.length < 2)
        fail("invalid_geometry", "road geometry requires at least two points");
      const anchor = normalizeCoordinate(anchorValue, "anchor");
      const projection = localProjection(anchor);
      const coordinates = geometry.map((value, index) =>
        normalizeCoordinate(value, `geometry[${index}]`),
      );
      const points = coordinates.map(projection.toXY);
      const cumulative = [0];
      for (let index = 1; index < points.length; index += 1) {
        const dx = points[index].x - points[index - 1].x;
        const dy = points[index].y - points[index - 1].y;
        cumulative.push(cumulative[index - 1] + Math.hypot(dx, dy));
      }
      if (cumulative[cumulative.length - 1] < 2)
        fail("invalid_geometry", "road geometry is too short");

      let nearest = { distanceSquared: Infinity, along: 0, segment: 0, t: 0 };
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const denominator = dx * dx + dy * dy;
        const t = denominator
          ? Math.max(
              0,
              Math.min(1, -(start.x * dx + start.y * dy) / denominator),
            )
          : 0;
        const x = start.x + t * dx;
        const y = start.y + t * dy;
        const distanceSquared = x * x + y * y;
        if (distanceSquared < nearest.distanceSquared) {
          nearest = {
            distanceSquared,
            along: cumulative[index] + t * Math.sqrt(denominator),
            segment: index,
            t,
          };
        }
      }
      return { anchor, projection, coordinates, points, cumulative, nearest };
    }

    function coordinateAtDistance(prepared, distance) {
      const total = prepared.cumulative[prepared.cumulative.length - 1];
      const bounded = Math.max(0, Math.min(total, distance));
      let segment = prepared.cumulative.length - 2;
      for (let index = 0; index < prepared.cumulative.length - 1; index += 1) {
        if (bounded <= prepared.cumulative[index + 1]) {
          segment = index;
          break;
        }
      }
      const startDistance = prepared.cumulative[segment];
      const segmentLength = prepared.cumulative[segment + 1] - startDistance;
      const t = segmentLength ? (bounded - startDistance) / segmentLength : 0;
      const start = prepared.points[segment];
      const end = prepared.points[segment + 1];
      return prepared.projection.toLatLon({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      });
    }

    function buildSamplePlan(prepared, windowMeters, spacingMeters) {
      const total = prepared.cumulative[prepared.cumulative.length - 1];
      const start = Math.max(0, prepared.nearest.along - windowMeters);
      const end = Math.min(total, prepared.nearest.along + windowMeters);
      if (end - start < Math.max(5, spacingMeters * 2)) {
        fail(
          "insufficient_geometry",
          "road geometry does not cover the requested analysis window",
        );
      }
      const distances = [];
      for (
        let distance = start;
        distance <= end + 1e-6;
        distance += spacingMeters
      )
        distances.push(distance);
      if (distances[distances.length - 1] < end - spacingMeters * 0.25)
        distances.push(end);
      return distances.map((distance) => ({
        alongMeters: distance - prepared.nearest.along,
        coordinate: coordinateAtDistance(prepared, distance),
      }));
    }

    function median(values) {
      if (!values.length) return null;
      const sorted = values.slice().sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function theilSen(samples) {
      const slopes = [];
      for (let left = 0; left < samples.length - 1; left += 1) {
        for (let right = left + 1; right < samples.length; right += 1) {
          const delta = samples[right].alongMeters - samples[left].alongMeters;
          if (Math.abs(delta) < 0.5) continue;
          slopes.push(
            (samples[right].elevation - samples[left].elevation) / delta,
          );
        }
      }
      if (!slopes.length)
        fail("insufficient_samples", "no independent elevation sample pairs");
      const slope = median(slopes);
      const intercept = median(
        samples.map((sample) => sample.elevation - slope * sample.alongMeters),
      );
      const residuals = samples.map((sample) =>
        Math.abs(sample.elevation - (intercept + slope * sample.alongMeters)),
      );
      return { slope, intercept, residualMadMeters: median(residuals) || 0 };
    }

    function affirmativeTag(value) {
      return ["yes", "true", "1"].includes(
        String(value == null ? "" : value)
          .trim()
          .toLowerCase(),
      );
    }

    function riskReasons(tags) {
      const value = tags || {};
      const reasons = [];
      if (affirmativeTag(value.bridge))
        reasons.push("bridge_surface_not_represented_by_dtm");
      if (affirmativeTag(value.tunnel))
        reasons.push("tunnel_surface_not_represented_by_dtm");
      if (Number(value.layer || 0) !== 0) reasons.push("non_ground_osm_layer");
      if (affirmativeTag(value.embankment))
        reasons.push("embankment_may_differ_from_terrain");
      if (affirmativeTag(value.cutting))
        reasons.push("cutting_may_differ_from_terrain");
      return reasons;
    }

    function qualityFor(
      descriptor,
      sampleCount,
      residualMadMeters,
      matchQuality,
      reasons,
    ) {
      if (reasons.some((reason) => /bridge|tunnel/.test(reason)))
        return "unusable";
      let score = 0;
      if (descriptor.modelType === "DTM") score += 2;
      if (descriptor.resolutionMeters <= 2) score += 3;
      else if (descriptor.resolutionMeters <= 10) score += 2;
      else score += 0;
      if (sampleCount >= 15) score += 2;
      else if (sampleCount >= 7) score += 1;
      if (residualMadMeters <= 0.25) score += 2;
      else if (residualMadMeters <= 0.75) score += 1;
      if (matchQuality === "high") score += 2;
      else if (matchQuality === "medium") score += 1;
      score -= reasons.length;
      if (score >= 9) return "high";
      if (score >= 6) return "medium";
      return "low";
    }

    function degradeQuality(quality) {
      if (quality === "high") return "medium";
      if (quality === "medium") return "low";
      return quality;
    }

    function directionFor(gradientPercent) {
      if (gradientPercent > 0.25) return "uphill_along_geometry";
      if (gradientPercent < -0.25) return "downhill_along_geometry";
      return "approximately_flat";
    }

    const REASON_LABELS_DE = Object.freeze({
      bridge_surface_not_represented_by_dtm:
        "Brückenoberfläche ist im Geländemodell nicht abgebildet",
      tunnel_surface_not_represented_by_dtm:
        "Tunneloberfläche ist im Geländemodell nicht abgebildet",
      non_ground_osm_layer: "Straßengeometrie liegt nicht auf der Geländeebene",
      embankment_may_differ_from_terrain:
        "Straßendamm kann vom Geländeprofil abweichen",
      cutting_may_differ_from_terrain:
        "Einschnitt kann vom Geländeprofil abweichen",
      source_is_not_pure_dtm: "Quelle ist kein reines Geländemodell",
      coarse_global_elevation_model:
        "globales Höhenmodell ist für die Fahrbahn zu grob",
      low_road_match_quality: "Straßenzuordnung ist unsicher",
      accident_point_far_from_matched_road:
        "Bezugspunkt liegt weit von der zugeordneten Straße entfernt",
    });

    function displayStatement(result) {
      if (!result.usable) {
        const reasons = result.uncertaintyReasons
          .map(
            (reason) =>
              REASON_LABELS_DE[reason] ||
              "nicht näher spezifizierte Unsicherheit",
          )
          .join("; ");
        return `Keine belastbare Straßenlängsneigung: ${reasons}.`;
      }
      if (result.semanticType === "terrain_context") {
        const range = result.gradientRangePercent;
        return (
          `Geländeneigung im Umfeld: ungefähr ${range[0]}–${range[1]} %, ` +
          `${result.source.datasetTitle} (${result.source.resolutionMeters} m); für die Fahrbahn nicht belastbar.`
        );
      }
      const value = Math.abs(result.gradientPercent)
        .toFixed(1)
        .replace(".", ",");
      const direction =
        result.direction === "uphill_along_geometry"
          ? "bergauf"
          : result.direction === "downhill_along_geometry"
            ? "bergab"
            : "nahezu eben";
      const profileLength = Number(result.profileLengthMeters).toLocaleString(
        "de-DE",
        {
          maximumFractionDigits: 1,
        },
      );
      return (
        `Straßenlängsneigung: ${value} % ${direction} über ${profileLength} m, ` +
        `${result.source.datasetTitle} (${result.source.resolutionMeters} m), Qualität ${result.quality}.`
      );
    }

    async function computeRoadGradient(provider, geometry, anchor, options) {
      if (
        !provider ||
        !provider.descriptor ||
        typeof provider.sampleElevations !== "function"
      ) {
        fail(
          "invalid_provider",
          "computeRoadGradient requires a registered provider",
        );
      }
      const opts = options || {};
      const windowMeters = Math.max(10, Number(opts.windowMeters) || 50);
      const spacingMeters = Math.max(
        1,
        Number(opts.spacingMeters) || provider.descriptor.resolutionMeters,
      );
      const prepared = preparePolyline(geometry, anchor);
      const plan = buildSamplePlan(prepared, windowMeters, spacingMeters);
      const elevations = await provider.sampleElevations(
        plan.map((item) => item.coordinate),
        opts.context || {},
      );
      const samples = plan
        .map((item, index) => ({
          ...item,
          elevation: elevations[index],
        }))
        .filter((item) => Number.isFinite(item.elevation));
      if (samples.length < 3)
        fail(
          "insufficient_samples",
          `only ${samples.length} valid elevation samples`,
        );
      const profileLengthMeters =
        Math.round(
          Math.abs(
            samples[samples.length - 1].alongMeters - samples[0].alongMeters,
          ) * 10,
        ) / 10;
      if (profileLengthMeters < Math.max(5, spacingMeters * 2)) {
        fail(
          "insufficient_samples",
          "valid elevation samples cover too little of the road profile",
        );
      }
      const fit = theilSen(samples);
      const reasons = riskReasons(opts.osmTags);
      if (provider.descriptor.modelType !== "DTM")
        reasons.push("source_is_not_pure_dtm");
      if (provider.descriptor.resolutionMeters >= 20)
        reasons.push("coarse_global_elevation_model");
      if (opts.matchQuality === "low") reasons.push("low_road_match_quality");
      if (prepared.nearest.distanceSquared > 25 * 25)
        reasons.push("accident_point_far_from_matched_road");

      const rawGradientPercent = fit.slope * 100;
      const uncertaintyPercent = Math.max(
        provider.descriptor.resolutionMeters >= 20 ? 1 : 0.2,
        (100 * 1.4826 * fit.residualMadMeters) /
          Math.max(profileLengthMeters / 2, 1),
      );
      let quality = qualityFor(
        provider.descriptor,
        samples.length,
        fit.residualMadMeters,
        opts.matchQuality || "unknown",
        reasons,
      );
      const semanticType =
        provider.descriptor.resolutionMeters >= 20 ||
        provider.descriptor.modelType !== "DTM"
          ? "terrain_context"
          : "road_longitudinal_gradient";
      if (semanticType === "terrain_context") quality = degradeQuality(quality);
      const unusable = quality === "unusable";
      const gradientPercent = unusable
        ? null
        : semanticType === "terrain_context"
          ? Math.round(rawGradientPercent)
          : Math.round(rawGradientPercent * 10) / 10;
      const range = unusable
        ? null
        : [
            Math.round(rawGradientPercent - uncertaintyPercent),
            Math.round(rawGradientPercent + uncertaintyPercent),
          ].sort((a, b) => a - b);
      const result = {
        schemaVersion: 1,
        semanticType,
        usable: !unusable,
        gradientPercent,
        gradientRangePercent: range,
        direction: unusable ? null : directionFor(rawGradientPercent),
        windowMeters,
        profileLengthMeters,
        spacingMeters,
        sampleCount: samples.length,
        residualMadMeters: Math.round(fit.residualMadMeters * 1000) / 1000,
        uncertaintyPercent: Math.round(uncertaintyPercent * 10) / 10,
        quality,
        uncertaintyReasons: [...new Set(reasons)].sort(),
        matchDistanceMeters:
          Math.round(Math.sqrt(prepared.nearest.distanceSquared) * 10) / 10,
        source: provider.descriptor,
        method: "theil-sen-linear-profile-v1",
      };
      result.statement = displayStatement(result);
      return Object.freeze(result);
    }

    function createHannoverDgm1Descriptor(retrievedAt) {
      return normalizeDescriptor({
        id: "hannover.dgm1",
        publisher: "Landeshauptstadt Hannover – Geoinformation",
        datasetTitle: "Digitales Geländemodell DGM1",
        datasetUrl:
          "https://www.hannover.de/Leben-in-der-Region-Hannover/Verwaltungen-Kommunen/Die-Verwaltung-der-Landeshauptstadt-Hannover/Dezernate-und-Fachbereiche-der-LHH/Stadtentwicklung-und-Bauen/Fachbereich-Planen-und-Stadtentwicklung/Geoinformation/Open-GeoData/3D-Stadtmodell-und-Gel%C3%A4ndemodell/Digitales-Gel%C3%A4ndemodell-DGM1",
        licenseId: "CC-BY-4.0",
        licenseName: "Creative Commons Attribution 4.0 International",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        requiredAttribution:
          "© Landeshauptstadt Hannover, Fachbereich Planen und Stadtentwicklung, Geoinformation, CC BY 4.0",
        resolutionMeters: 1,
        modelType: "DTM",
        horizontalCrs: "EPSG:25832",
        acquisitionPeriod: "Laserscannerbefliegung 2010",
        publicationDate: "2024-01-15",
        retrievedAt,
        modifiedDataNotice:
          "Höhenprofil entlang gematchter Straßengeometrien robust ausgewertet.",
        priority: SOURCE_TIERS.OFFICIAL_DGM_1_2,
      });
    }

    function createGlobalFallbackDescriptor(retrievedAt) {
      return normalizeDescriptor({
        id: "global.srtm30",
        publisher: "NASA / USGS",
        datasetTitle: "SRTM 30 m global elevation model",
        datasetUrl: "https://registry.opendata.aws/terrain-tiles/",
        licenseId: "public-domain",
        licenseName: "Public Domain / source-specific terms",
        licenseUrl: "https://www2.jpl.nasa.gov/srtm/",
        requiredAttribution: "NASA Shuttle Radar Topography Mission (SRTM)",
        resolutionMeters: 30,
        modelType: "mixed",
        horizontalCrs: "EPSG:4326",
        retrievedAt,
        modifiedDataNotice:
          "Global raster values sampled and converted to a coarse terrain-context profile.",
        priority: SOURCE_TIERS.GLOBAL_FALLBACK,
      });
    }

    return Object.freeze({
      SOURCE_TIERS,
      MODEL_TYPES,
      QUALITY_VALUES,
      ElevationProviderError,
      normalizeDescriptor,
      createProvider,
      createRegistry,
      computeRoadGradient,
      createHannoverDgm1Descriptor,
      createGlobalFallbackDescriptor,
      _test: Object.freeze({
        buildSamplePlan,
        directionFor,
        median,
        preparePolyline,
        theilSen,
      }),
    });
  },
);
