/**
 * Connects the shared SourceManifest and artifact adapters to the live browser
 * downloads without coupling the analysis module to package/renderer details.
 */
(function initExportProvenance(root, factory) {
  const sourceManifest =
    typeof module !== "undefined" && module.exports
      ? require("./ua.source_manifest")
      : root?.UA?.sourceManifest;
  const artifactProvenance =
    typeof module !== "undefined" && module.exports
      ? require("./ua.artifact_provenance")
      : root?.UA?.artifactProvenance;
  const zip =
    typeof module !== "undefined" && module.exports
      ? require("./ua.zip")
      : root?.UA?.zip;
  const traffic = typeof module !== "undefined" && module.exports
    ? require("./ua.traffic_provider") : root?.UA?.trafficProvider;
  const api = factory(sourceManifest, artifactProvenance, zip, traffic);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.exportProvenance = api;
    api.install(UA, root);
  }
})(typeof window !== "undefined" ? window : null, function createExportProvenanceApi(
  sourceManifest,
  artifactProvenance,
  zip,
  traffic,
) {
  "use strict";

  const SOURCE_ID = "accidents.de.unfallatlas";
  const CORE_FIELDS = Object.freeze([
    "lat",
    "lon",
    "year",
    "ukategorie",
    "IstRad",
    "IstFuss",
    "IstPKW",
    "IstKrad",
    "IstGkfz",
    "IstSonstig",
    "ustunde",
    "uwochentag",
    "strzustand",
  ]);
  const manifestCache = new WeakMap();
  const buildFingerprintPromises = new WeakMap();
  let fallbackBuildFingerprintPromise = null;

  class LiveExportProvenanceError extends Error {
    constructor(code, message, details) {
      super(`${code}: ${message}`);
      this.name = "LiveExportProvenanceError";
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new LiveExportProvenanceError(code, message, details);
  }

  function requireDependencies() {
    if (!sourceManifest?.normalizeManifest) {
      fail("missing_dependency", "SourceManifest API is unavailable");
    }
    if (!artifactProvenance?.buildCsvPackageEntries) {
      fail("missing_dependency", "Artifact provenance API is unavailable");
    }
    if (!zip?.createStoredZip) {
      fail("missing_dependency", "ZIP API is unavailable");
    }
  }

  function value(element, fallback = null) {
    return element && element.value != null ? element.value : fallback;
  }

  function checked(element, fallback = false) {
    return element && typeof element.checked === "boolean" ? element.checked : fallback;
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function boundsObject(ctx) {
    const bounds = ctx?.selectionBounds || ctx?.map?.getBounds?.();
    if (!bounds) return null;
    const south = finite(bounds.getSouth?.() ?? bounds.getSouthWest?.()?.lat ?? bounds.south);
    const west = finite(bounds.getWest?.() ?? bounds.getSouthWest?.()?.lng ?? bounds.west);
    const north = finite(bounds.getNorth?.() ?? bounds.getNorthEast?.()?.lat ?? bounds.north);
    const east = finite(bounds.getEast?.() ?? bounds.getNorthEast?.()?.lng ?? bounds.east);
    if ([south, west, north, east].some((item) => item == null)) return null;
    if (south >= north || west >= east) return null;
    return { south, west, north, east };
  }

  function pointInside(point, bounds) {
    if (!bounds) return true;
    if (typeof bounds.contains === "function") {
      try {
        return Boolean(bounds.contains([point.lat, point.lon]));
      } catch (_) {
        try {
          return Boolean(bounds.contains({ lat: point.lat, lng: point.lon }));
        } catch (_) {
          // Continue with numeric bounds below.
        }
      }
    }
    const normalized = boundsObject({ selectionBounds: bounds });
    return (
      !normalized ||
      (point.lat >= normalized.south &&
        point.lat <= normalized.north &&
        point.lon >= normalized.west &&
        point.lon <= normalized.east)
    );
  }

  function exportPoints(UA, ctx) {
    const hasFilterFunction = typeof UA?.matchesNonInvolvementFilters === "function";
    if (hasFilterFunction && !ctx?.ui) {
      fail(
        "missing_filter_state",
        "Default export provenance requires the bound UI filter state",
      );
    }
    const bounds = ctx?.selectionBounds || ctx?.map?.getBounds?.() || null;
    const points = [];
    for (const point of ctx?.allPts || []) {
      if (!point || !point.props) continue;
      if (hasFilterFunction && !UA.matchesNonInvolvementFilters(ctx, point.props)) continue;
      if (!pointInside(point, bounds)) continue;
      points.push(point);
    }
    return points;
  }

  function scenarioFilters(ctx) {
    const ui = ctx?.ui || {};
    const filters = {
      severity: value(ui.severityEl, "all"),
      roadCondition: value(ui.roadConditionEl, "all"),
      includeCyclist: checked(ui.incBikeEl, true),
      includePedestrian: checked(ui.incPedEl, true),
      includeCar: checked(ui.incCarEl, true),
      includeMotorcycle: checked(ui.incMotoEl, false),
      includeGkfz: checked(ui.incGkfzEl, false),
      includeSonstig: checked(ui.incSonEl, false),
      hourFrom: finite(value(ui.hFromEl, 0)) ?? 0,
      hourTo: finite(value(ui.hToEl, 23)) ?? 23,
      dayType: value(ui.dayTypeEl, "all"),
      involvementMode: ctx?.involvementMode || "or",
      dataExportInvolvementPolicy:
        "Beteiligungsfilter dokumentiert; Datenexport enthält alle Kombinationen im übrigen Filterumfang",
    };
    const slopeClasses = Array.from(ctx?.contextFilters?.slopeClasses || []).sort();
    const trafficClasses = Array.from(ctx?.contextFilters?.trafficClasses || []).sort();
    if (slopeClasses.length) filters.contextSlopeClasses = slopeClasses;
    if (trafficClasses.length) filters.contextTrafficClasses = trafficClasses;
    if (ctx?.contextFilters?.onlyMatchedWays === true) filters.onlyMatchedWays = true;
    return filters;
  }

  function contextProperties(properties) {
    const p = properties || {};
    const typedTraffic = traffic && traffic.hasUsableTypedEvidence(p);
    const proxy = (p.traffic_measurement_type === 'proxy' || !p.traffic_measurement_type) &&
      ['low', 'medium', 'high', 'very_high'].includes(p.traffic_proxy_class);
    return Object.fromEntries(Object.keys(p).sort().filter(key =>
      /^(elevation_m$|slope_|road_slope_)/.test(key) ||
      (typedTraffic && /^traffic_/.test(key)) ||
      (proxy && ['traffic_measurement_type', 'traffic_proxy_class', 'traffic_proxy_basis',
        'traffic_volume_source', 'traffic_volume_confidence'].includes(key))
    ).filter(key => p[key] !== undefined).map(key => [key, p[key]]));
  }

  function contextSourceFacts(ctx, normalizedPoints) {
    const rows = normalizedPoints.filter(point => point.context);
    const available = ctx?.contextLayerState?.meta?.sources || {};
    const result = {};
    if (rows.some(point => Object.keys(point.context).some(key => /^(elevation_m$|slope_|road_slope_)/.test(key)))) {
      if (available.dem) result.dem = available.dem;
      if (available.roadSlope) result.roadSlope = available.roadSlope;
    }
    if (rows.some(point => point.context.traffic_evidence) && available.trafficMatched) result.trafficMatched = available.trafficMatched;
    if (rows.some(point => point.context.traffic_proxy_class) && available.traffic) result.traffic = available.traffic;
    return result;
  }

  function typedContextSources(normalizedPoints) {
    const sources = new Map();
    for (const point of normalizedPoints) {
      const descriptor = point.context?.traffic_evidence?.observation?.source;
      if (!descriptor) continue;
      const { id, measurementType, modes, unit, priority, ...source } = descriptor;
      const previous = sources.get(source.sourceId);
      if (previous && sourceManifest.stableStringify(previous) !== sourceManifest.stableStringify(source)) {
        fail('conflicting_context_source', `Different evidence snapshots share source ID ${source.sourceId}`);
      }
      sources.set(source.sourceId, source);
    }
    return [...sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  }

  async function compactContextEvidence(points, sources, declaredSources) {
    const fieldCounts = {};
    const measurementTypes = {};
    const rawObservations = new Map();
    const rawSelections = new Map();
    const artifacts = new Map();
    const terrainSources = new Map();
    const canonical = value => sourceManifest.stableStringify(value);
    const rememberObservation = raw => {
      if (!raw) return null;
      const key = canonical(raw);
      if (!rawObservations.has(key)) rawObservations.set(key, raw);
      return key;
    };
    for (const point of points) {
      const context = point.context;
      for (const [field, value] of Object.entries(context)) {
        if (!fieldCounts[field]) fieldCounts[field] = { present: 0, null: 0 };
        fieldCounts[field][value === null ? 'null' : 'present'] += 1;
      }
      if (context.traffic_measurement_type) {
        const type = context.traffic_measurement_type;
        measurementTypes[type] = (measurementTypes[type] || 0) + 1;
      }
      const evidence = context.traffic_evidence;
      if (evidence?.observation) {
        const observationKey = rememberObservation(evidence.observation);
        const facts = Object.fromEntries(['evidenceType', 'wayId', 'distanceMeters', 'matchQuality',
          'matchMethod', 'ageYears', 'warning'].filter(key => evidence[key] !== undefined).map(key => [key, evidence[key]]));
        rawSelections.set(canonical({ observationKey, ...facts }), { observationKey, facts });
      }
      for (const observation of context.traffic_observations || []) rememberObservation(observation);
      if (context.traffic_artifact) artifacts.set(canonical(context.traffic_artifact), context.traffic_artifact);
      if (Object.keys(context).some(key => /^(elevation_m$|slope_|road_slope_)/.test(key))) {
        const facts = Object.fromEntries(['slope_source', 'slope_resolution_m', 'slope_semantic_type',
          'road_slope_source_id', 'road_slope_source', 'road_slope_resolution_m', 'road_slope_reliable_for_road']
          .filter(key => context[key] !== undefined).map(key => [key, context[key]]));
        terrainSources.set(canonical(facts), facts);
      }
    }
    const observationHashes = new Map();
    const observations = new Map();
    const additionalSources = new Map();
    const knownSources = new Set(declaredSources.map(canonical));
    for (const [key, raw] of rawObservations) {
      // The full point hash still binds all raw context. Only observations
      // passing the existing SPI become compact, reusable evidence facts.
      let observation;
      try { observation = traffic.normalizeObservation(raw, traffic.normalizeDescriptor(raw.source), 0); }
      catch (_) { continue; }
      const { source, geometry, coordinate, ...facts } = observation;
      const { id, measurementType, modes, unit, priority, ...sourceRecord } = source;
      if (!knownSources.has(canonical(sourceRecord))) additionalSources.set(canonical(sourceRecord), sourceRecord);
      facts.sourceContentHash = source.contentHash || null;
      if (geometry || coordinate) facts.geometrySha256 = await artifactProvenance.sha256(canonical({ geometry, coordinate }));
      const observationSha256 = await artifactProvenance.sha256(canonical(facts));
      observationHashes.set(key, observationSha256);
      observations.set(observationSha256, { observationSha256, ...facts });
    }
    const selections = new Map();
    for (const { observationKey, facts } of rawSelections.values()) {
      const observationSha256 = observationHashes.get(observationKey);
      if (!observationSha256) continue;
      const selection = { observationSha256, ...facts };
      selections.set(canonical(selection), selection);
    }
    const ordered = map => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
    const compactSources = {};
    for (const [name, value] of Object.entries(sources)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { compactSources[name] = value; continue; }
      const { matchedArtifact, source, ...facts } = value;
      if (source !== undefined) {
        let record = source;
        if (source && typeof source === 'object') {
          try {
            const { id, measurementType, modes, unit, priority, ...normalized } = traffic.normalizeDescriptor(source);
            if (knownSources.has(canonical(normalized))) record = { sourceId: normalized.sourceId, contentHash: normalized.contentHash || null };
          } catch (_) { /* partial source facts stay partial */ }
        }
        facts.source = record;
      }
      if (matchedArtifact) {
        artifacts.set(canonical(matchedArtifact), matchedArtifact);
        facts.matchedArtifactSha256 = matchedArtifact.sha256 || null;
      }
      compactSources[name] = facts;
    }
    return {
      contextDataSha256: await artifactProvenance.sha256(canonical({ points, sources })),
      pointCount: points.length, fieldCounts, measurementTypes, sources: compactSources,
      observations: ordered(observations),
      selections: ordered(selections), artifacts: ordered(artifacts), terrainSources: ordered(terrainSources),
      additionalObservationSources: ordered(additionalSources),
    };
  }

  function attachContextProperties(collection, points) {
    if (!points.some(point => Object.keys(contextProperties(point.props)).length)) return collection;
    if (!Array.isArray(collection.features) || collection.features.length !== points.length) {
      fail('context_export_population_mismatch', 'GeoJSON context population differs from the selected accident population');
    }
    collection.features.forEach((feature, index) => {
      const point = points[index];
      const exported = canonicalPoint({ lat: feature.geometry?.coordinates?.[1], lon: feature.geometry?.coordinates?.[0], props: feature.properties });
      const expected = canonicalPoint(point);
      const context = expected.context || {};
      delete exported.context;
      delete expected.context;
      if (sourceManifest.stableStringify(exported) !== sourceManifest.stableStringify(expected)) {
        fail('context_export_population_mismatch', `GeoJSON context population differs at feature ${index}`);
      }
      feature.properties = { ...(feature.properties || {}), ...context };
    });
    return collection;
  }

  function canonicalPoint(point) {
    const props = point.props || {};
    const context = contextProperties(props);
    return {
      lat: Number(point.lat),
      lon: Number(point.lon),
      year: props.year ?? null,
      ukategorie: props.ukategorie ?? null,
      IstRad: props.IstRad ?? props.istrad ?? null,
      IstFuss: props.IstFuss ?? props.istfuss ?? null,
      IstPKW: props.IstPKW ?? props.istpkw ?? null,
      IstKrad: props.IstKrad ?? props.istkrad ?? null,
      IstGkfz: props.IstGkfz ?? props.istgkfz ?? null,
      IstSonstig: props.IstSonstig ?? props.istsonstig ?? null,
      ustunde: props.ustunde ?? null,
      uwochentag: props.uwochentag ?? null,
      strzustand: props.strzustand ?? null,
      ...(Object.keys(context).length ? { context } : {}),
    };
  }

  function buildLabel(UA, root) {
    const meta = root?.document?.querySelector?.('meta[name="unfallwerkbank-build"]');
    return String(UA?.BUILD || meta?.content || "unfallwerkbank-browser").trim();
  }

  async function buildFingerprint(UA, root) {
    const cacheableRoot = root && (typeof root === "object" || typeof root === "function");
    if (cacheableRoot && buildFingerprintPromises.has(root)) {
      return buildFingerprintPromises.get(root);
    }
    if (!cacheableRoot && fallbackBuildFingerprintPromise) {
      return fallbackBuildFingerprintPromise;
    }
    const promise = (async () => {
      if (typeof root?.fetch === "function") {
        try {
          const response = await root.fetch("build-manifest.json", { cache: "no-store" });
          if (response?.ok) {
            const manifest = await response.json();
            for (const candidate of [
              manifest?.buildFingerprint,
              manifest?.applicationFingerprint,
              manifest?.appFingerprint,
              manifest?.siteFingerprint,
            ]) {
              if (typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate)) {
                return candidate.toLowerCase();
              }
            }
            return artifactProvenance.sha256(sourceManifest.stableStringify(manifest));
          }
        } catch (_) {
          // Local source tests and direct module consumers use the build-label fallback.
        }
      }
      return artifactProvenance.sha256(buildLabel(UA, root));
    })();
    if (cacheableRoot) buildFingerprintPromises.set(root, promise);
    else fallbackBuildFingerprintPromise = promise;
    return promise;
  }

  function retrievedAt(ctx, generatedAt) {
    const candidate = ctx?.accidentDataRetrievedAt || ctx?.dataRetrievedAt;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : generatedAt;
  }

  async function createManifest(ctx, environment = {}) {
    requireDependencies();
    const UA = environment.UA || environment.root?.UA || {};
    const root = environment.root || (typeof window !== "undefined" ? window : null);
    if (ctx?.exportSourceManifest) {
      return sourceManifest.normalizeManifest(ctx.exportSourceManifest);
    }

    const points = exportPoints(UA, ctx);
    const city = String(ctx?.CITY_RAW || "").trim();
    if (!city) fail("missing_city", "A city is required for export provenance");
    const filters = scenarioFilters(ctx);
    const bounds = boundsObject(ctx);
    const normalizedPoints = points
      .map((point) => {
        const value = canonicalPoint(point);
        if (ctx?.exportContextEvidence === false) delete value.context;
        return { value, key: sourceManifest.stableStringify(value) };
      })
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => entry.value);
    const years = [
      ...new Set(
        normalizedPoints
          .map((point) => Number(point.year))
          .filter((year) => Number.isInteger(year)),
      ),
    ].sort((left, right) => left - right);
    const contextSources = typedContextSources(normalizedPoints);
    const contextFacts = contextSourceFacts(ctx, normalizedPoints);
    const contextPoints = normalizedPoints.filter(point => point.context);
    const dataSnapshot = { city, bounds, filters, years, points: normalizedPoints,
      ...(contextPoints.length ? { contextSources: contextFacts } : {}) };
    const dataCanonical = sourceManifest.stableStringify(dataSnapshot);
    const dataFingerprint = await artifactProvenance.sha256(dataCanonical);
    const appFingerprint = await buildFingerprint(UA, root);
    const cached = manifestCache.get(ctx);
    if (
      cached &&
      cached.dataFingerprint === dataFingerprint &&
      cached.buildFingerprint === appFingerprint
    ) {
      return cached.manifest;
    }

    const contextEvidence = contextPoints.length
      ? await compactContextEvidence(contextPoints, contextFacts, contextSources) : null;
    const generatedAt = new Date().toISOString();
    const normalized = sourceManifest.normalizeManifest({
      schemaVersion: sourceManifest.SCHEMA_VERSION,
      artifactId: `unfallwerkbank-${String(UA?.normKey?.(city) || city)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "export"}-${dataFingerprint.slice(0, 12)}`,
      generatedAt,
      applicationVersion: buildLabel(UA, root),
      buildFingerprint: appFingerprint,
      dataFingerprint,
      scenario: {
        city,
        ...(bounds ? { bounds } : {}),
        filters,
        ...(years.length ? { years } : {}),
      },
      sources: [
        {
          sourceId: SOURCE_ID,
          role: "accidents",
          publisher: "Statistische Ämter des Bundes und der Länder",
          datasetTitle: "Unfallatlas – Straßenverkehrsunfälle mit Personenschaden",
          datasetUrl: "https://www.statistikportal.de/de/karten/unfallatlas",
          distributionUrl: "https://unfallatlas.statistikportal.de/",
          licenseId: "DL-DE-BY-2.0",
          licenseName: "Datenlizenz Deutschland – Namensnennung – Version 2.0",
          licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
          requiredAttribution:
            "© Statistische Ämter des Bundes und der Länder, Unfallatlas",
          ...(years.length
            ? { temporalCoverage: `${years[0]}–${years[years.length - 1]}` }
            : {}),
          spatialCoverage: city,
          retrievedAt: retrievedAt(ctx, generatedAt),
          changedOrDerived: true,
          changeNotice:
            "Räumlich und nach den gewählten Filtern ausgewählt; Exportfelder normalisiert.",
          qualityNotes: [
            "Enthalten sind polizeilich erfasste Unfälle mit Personenschaden.",
          ],
          permissions: {
            permitsRedistribution: true,
            permitsDerivatives: true,
            commercialUseAllowed: true,
          },
        },
        ...contextSources,
      ],
      transformations: [
        {
          transformationId: "filter-export-selection",
          label: "Gefilterter Unfallstellenexport",
          description:
            "Auswahl im Exportbereich unter Schwere-, Zeit-, Zustands- und Kontextfiltern; Beteiligungsfilter werden dokumentiert, der Datenexport bewahrt jedoch alle Beteiligungskombinationen. Exportfelder werden normalisiert.",
          sourceIds: [SOURCE_ID],
          outputFields: CORE_FIELDS,
          softwareVersion: buildLabel(UA, root),
          parameters: { bounds, filters },
        },
        ...(contextPoints.length ? [{
          transformationId: 'context-evidence', label: 'Kontextdaten und Quellenbindung',
          description: 'Kontextfelder im ausgewählten Unfallbestand; Unfallquelle dient der räumlichen Zuordnung. Unvollständige Kontextquellenfakten bleiben als solche erhalten und werden nicht als vollständiger Quellenbeleg ausgegeben.',
          sourceIds: [SOURCE_ID, ...contextSources.map(source => source.sourceId)],
          outputFields: [...new Set(contextPoints.flatMap(point => Object.keys(point.context)))].sort(),
          parameters: contextEvidence,
        }] : []),
      ],
    });
    manifestCache.set(ctx, {
      dataFingerprint,
      buildFingerprint: appFingerprint,
      manifest: normalized,
    });
    return normalized;
  }

  async function readBlobText(blob, root) {
    if (blob && typeof blob.text === "function") return blob.text();
    const Reader = root?.FileReader || (typeof FileReader !== "undefined" ? FileReader : null);
    if (!Reader) fail("blob_reader_unavailable", "No Blob text reader is available");
    return new Promise((resolve, reject) => {
      const reader = new Reader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Blob read failed"));
      reader.readAsText(blob);
    });
  }

  async function captureOriginalExport(root, exporter, ctx) {
    if (typeof exporter !== "function") fail("missing_exporter", "Original exporter is unavailable");
    const previous = root.saveAs;
    let captured = null;
    root.saveAs = (blob, filename) => {
      captured = { blob, filename };
    };
    try {
      await exporter(ctx);
    } finally {
      if (previous === undefined) delete root.saveAs;
      else root.saveAs = previous;
    }
    if (!captured?.blob || !captured?.filename) {
      fail("capture_failed", "Original exporter did not produce a file");
    }
    return captured;
  }

  function download(root, blob, filename) {
    if (typeof root.saveAs === "function") {
      root.saveAs(blob, filename);
      return;
    }
    const url = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    root.document.body.appendChild(anchor);
    anchor.click();
    root.setTimeout(() => {
      root.URL.revokeObjectURL(url);
      anchor.remove();
    }, 1000);
  }

  function reportFailure(UA, root, error) {
    root?.console?.error?.("Export mit Quellenprovenienz fehlgeschlagen", error);
    if (typeof UA?.showToast === "function") {
      UA.showToast("Export abgebrochen: vollständige Quellenprovenienz konnte nicht erzeugt werden.");
    }
    if (typeof root?.CustomEvent === "function" && root?.dispatchEvent) {
      root.dispatchEvent(
        new root.CustomEvent("unfallwerkbank:export-error", {
          detail: { code: error?.code || "export_failed", message: error?.message || String(error) },
        }),
      );
    }
  }

  function install(UA, root) {
    requireDependencies();
    if (!UA || !root) fail("invalid_environment", "Browser UA and window are required");
    if (UA.__liveExportProvenanceInstalled) return UA.exportProvenanceRuntime;
    const stagedOriginals = UA.__exportProvenanceOriginals || null;
    const originals = {
      csv: stagedOriginals?.exportToCSV || UA.exportToCSV,
      geojson: stagedOriginals?.exportToGeoJSON || UA.exportToGeoJSON,
      kml: stagedOriginals?.exportToKML || UA.exportToKML,
    };
    if (Object.values(originals).some((exporter) => typeof exporter !== "function")) {
      fail("missing_exporter", "ua.export_v2.js must be loaded before provenance installation");
    }

    let queue = Promise.resolve();
    const enqueue = (task) => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    };
    const guarded = (task) =>
      enqueue(task).catch((error) => {
        reportFailure(UA, root, error);
        throw error;
      });

    UA.exportToCSV = function exportToCsvWithProvenance(ctx) {
      return guarded(async () => {
        const manifest = await createManifest(ctx, { UA, root });
        const captured = await captureOriginalExport(root, originals.csv, ctx);
        const csv = await readBlobText(captured.blob, root);
        const baseName = String(captured.filename).replace(/\.csv$/i, "");
        const packageEntries = await artifactProvenance.buildCsvPackageEntries({
          baseName,
          csv,
          manifest,
          title: `Unfalldatenexport ${ctx.CITY_RAW}`,
        });
        const archive = zip.createStoredZip(packageEntries.entries);
        const filename = `${packageEntries.baseName}.zip`;
        download(root, new root.Blob([archive], { type: "application/zip" }), filename);
        return { filename, manifest, packageEntries };
      });
    };

    UA.exportToGeoJSON = function exportToGeoJsonWithProvenance(ctx) {
      return guarded(async () => {
        const manifest = await createManifest(ctx, { UA, root });
        const captured = await captureOriginalExport(root, originals.geojson, ctx);
        const parsed = JSON.parse(await readBlobText(captured.blob, root));
        if (ctx?.exportContextEvidence !== false) attachContextProperties(parsed, exportPoints(UA, ctx));
        const enriched = await artifactProvenance.attachGeoJsonProvenance(parsed, manifest);
        download(
          root,
          new root.Blob([enriched.json], { type: "application/geo+json;charset=utf-8" }),
          captured.filename,
        );
        return { filename: captured.filename, manifest, geojson: enriched.geojson };
      });
    };

    UA.exportToKML = function exportToKmlWithProvenance(ctx) {
      return guarded(async () => {
        const manifest = await createManifest(ctx, { UA, root });
        const captured = await captureOriginalExport(root, originals.kml, ctx);
        const kml = await readBlobText(captured.blob, root);
        const enriched = await artifactProvenance.injectKmlProvenance(kml, manifest);
        download(
          root,
          new root.Blob([enriched.kml], {
            type: "application/vnd.google-earth.kml+xml;charset=utf-8",
          }),
          captured.filename,
        );
        return { filename: captured.filename, manifest, kml: enriched.kml };
      });
    };

    delete UA.__exportProvenanceOriginals;
    UA.__liveExportProvenanceInstalled = true;
    UA.exportProvenanceRuntime = Object.freeze({ originals, createManifest });
    return UA.exportProvenanceRuntime;
  }

  return Object.freeze({
    SOURCE_ID,
    CORE_FIELDS,
    LiveExportProvenanceError,
    boundsObject,
    exportPoints,
    scenarioFilters,
    createManifest,
    contextProperties,
    attachContextProperties,
    readBlobText,
    captureOriginalExport,
    install,
  });
});
