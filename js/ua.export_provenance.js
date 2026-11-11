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
  const elevation = typeof module !== "undefined" && module.exports
    ? require("./ua.elevation_provider") : root?.UA?.elevationProvider;
  const api = factory(sourceManifest, artifactProvenance, zip, traffic, elevation);
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
  elevation,
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
  const manifestSnapshots = new WeakMap();
  const buildInfoPromises = new WeakMap();
  let fallbackBuildInfoPromise = null;

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
    const projectionCache = new WeakMap();
    for (const point of ctx?.allPts || []) {
      if (!point || !point.props) continue;
      if (hasFilterFunction && !UA.matchesNonInvolvementFilters(ctx, point.props)) continue;
      if (!pointInside(point, bounds)) continue;
      let props = projectionCache.get(point.props);
      if (!props) {
        let selectedWay = null;
        const state = ctx?.contextLayerState;
        const wayId = point.props.matched_way_id;
        if (state && wayId) {
          try {
            if (typeof UA?.contextLayers?.resolveWayAcrossTiles === 'function') {
              selectedWay = UA.contextLayers.resolveWayAcrossTiles(state, wayId);
            } else if (typeof UA?.contextLayers?.resolveWay === 'function') {
              selectedWay = UA.contextLayers.resolveWay(state, wayId);
            } else if (state.ways?.[wayId]) {
              selectedWay = Object.fromEntries(Object.entries(state.ways[wayId]).map(([key, value]) => {
                const dictionary = state.dicts?.[key];
                return [key, Array.isArray(dictionary) && Number.isInteger(value) && value >= 0 && value < dictionary.length
                  ? dictionary[value] : value];
              }));
            }
          } catch (_) { /* same missing-cache boundary as the popup */ }
        }
        const api = UA?.elevationProvider || elevation;
        if (!api?.projectSelectedWayEvidence) fail('missing_dependency', 'Selected Way evidence projection is unavailable');
        props = api.projectSelectedWayEvidence(point.props, selectedWay);
        projectionCache.set(point.props, props);
      }
      points.push({ ...point, props });
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
    const typedTraffic = traffic && traffic.hasUsableTypedEvidence(p, { mode: p.traffic_evidence?.observation?.mode });
    const proxy = (p.traffic_measurement_type === 'proxy' || !p.traffic_measurement_type) &&
      ['low', 'medium', 'high', 'very_high'].includes(p.traffic_proxy_class);
    return Object.fromEntries(Object.keys(p).sort().filter(key =>
      /^(matched_way_id$|elevation_m$|slope_|road_slope_)/.test(key) ||
      (typedTraffic && /^traffic_/.test(key)) ||
      (proxy && ['traffic_measurement_type', 'traffic_proxy_class', 'traffic_proxy_basis',
        'traffic_volume_source', 'traffic_volume_confidence'].includes(key))
    ).filter(key => p[key] !== undefined).map(key => [key, p[key]]));
  }

  // CSV/KML rows retain the selected facts and identifiers; complete source,
  // alternative-observation and artifact records remain deduplicated in the
  // embedded SourceManifest. GeoJSON continues to carry the full context.
  function dataContextProperties(properties) {
    const context = contextProperties(properties);
    const reference = observation => Object.fromEntries([
      ['sourceId', observation.sourceId], ['sourceContentHash', observation.source?.contentHash || null],
      ...['observationId', 'measurementType', 'mode', 'year', 'period', 'value', 'unit', 'direction']
        .map(key => [key, observation[key]])
    ].filter(([, value]) => value !== undefined));
    if (context.traffic_evidence?.observation) {
      const evidence = context.traffic_evidence;
      context.traffic_evidence = {
        ...Object.fromEntries(['evidenceType', 'wayId', 'distanceMeters', 'matchQuality', 'matchMethod', 'ageYears', 'warning']
          .filter(key => evidence[key] !== undefined).map(key => [key, evidence[key]])),
        observation: reference(evidence.observation),
      };
      context.traffic_volume_period = evidence.observation.period;
      context.traffic_volume_direction = evidence.observation.direction;
      context.traffic_volume_mode = evidence.observation.mode;
    }
    if (context.traffic_observations) context.traffic_observations = context.traffic_observations.map(reference);
    if (context.traffic_artifact) context.traffic_artifact = Object.fromEntries(
      ['sha256', 'artifactFingerprint'].filter(key => context.traffic_artifact[key] !== undefined).map(key => [key, context.traffic_artifact[key]]));
    return context;
  }

  function snapshotFor(ctx, manifest = ctx?.exportSourceManifest) {
    if (!manifest) return null;
    const cached = manifestCache.get(ctx);
    return cached?.dataFingerprint === manifest.dataFingerprint ? cached : manifestSnapshots.get(manifest);
  }

  function boundExportPoints(UA, ctx) {
    return snapshotFor(ctx)?.projectedPoints || exportPoints(UA, ctx);
  }

  function captureFilterContext(ctx) {
    const ui = { ...ctx?.ui };
    for (const key of ['severityEl','roadConditionEl','dayTypeEl','hFromEl','hToEl',
      'incBikeEl','incPedEl','incCarEl','incMotoEl','incGkfzEl','incSonEl']) {
      if (ui[key]) ui[key] = { value: ui[key].value, checked: ui[key].checked };
    }
    const contextFilters = { ...ctx?.contextFilters };
    for (const key of ['slopeClasses','trafficClasses']) {
      if (contextFilters[key]) contextFilters[key] = new Set(contextFilters[key]);
    }
    return { ui, contextFilters, involvementMode: ctx?.involvementMode };
  }

  function copyContext(ctx, overrides) {
    // Year adapters own only their normalized points and inherit the live
    // context. Materialize inherited state too, without assigning through the
    // adapter's read-only allPts property or retaining a live prototype link.
    const inherited = [];
    for (const key in ctx) {
      if (!Object.prototype.hasOwnProperty.call(ctx, key)) inherited.push([key, ctx[key]]);
    }
    return { ...Object.fromEntries(inherited), ...ctx, ...overrides };
  }

  function bindExportContext(UA, ctx, manifest) {
    const cached = snapshotFor(ctx, manifest);
    const points = cached?.projectedPoints || exportPoints(UA, ctx);
    const activePoints = cached?.activePoints || (UA?.AnalysisScope?.getActiveFilteredPoints
      ? UA.AnalysisScope.getActiveFilteredPoints(copyContext(ctx, { allPts: points })) : points);
    const filterContext = cached?.filterContext || captureFilterContext(ctx);
    const bound = copyContext(ctx, { ...filterContext, allPts: points, exportSourceManifest: manifest });
    const snapshot = { dataFingerprint: manifest.dataFingerprint, projectedPoints: points, activePoints, filterContext };
    manifestCache.set(bound, snapshot);
    manifestSnapshots.set(manifest, snapshot);
    return bound;
  }

  function buildContextNote(UA, ctx, options = {}) {
    if (ctx?.exportContextEvidence === false) return null;
    const cached = snapshotFor(ctx);
    const boundPoints = cached?.projectedPoints || exportPoints(UA, ctx);
    // Document notes retain the active population captured before hashing;
    // an ordinary standalone preview intentionally follows current controls.
    const points = cached?.activePoints || (UA?.AnalysisScope?.getActiveFilteredPoints
      ? UA.AnalysisScope.getActiveFilteredPoints(copyContext(ctx, { allPts: boundPoints })) : boundPoints);
    const groups = new Map();
    const sources = new Map();
    const safeUrl = value => {
      try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
      catch (_) { return null; }
    };
    const add = (label, url) => sources.set(JSON.stringify([label, safeUrl(url)]), { label, url: safeUrl(url) });
    const sets = () => ({ years: new Set(), periods: new Set(), directions: new Set(), qualities: new Set(), methods: new Set(), notes: new Set(), observationNotes: new Set(), values: new Set(), distances: [], unknownDistance: false });
    const facts = ctx?.exportSourceManifest?.transformations?.find(item => item.transformationId === 'context-evidence')?.parameters?.sources
      || contextSourceFacts(ctx, points.map(point => ({ context: contextProperties(point.props) })));
    for (const point of points) {
      const p = point.props;
      if (traffic?.hasUsableTypedEvidence(p, { mode: p.traffic_evidence?.observation?.mode })) {
        const selected = traffic.selectTrafficEvidence([p.traffic_evidence], { referenceYear: new Date().getUTCFullYear(), mode: p.traffic_evidence.observation.mode });
        const observation = selected.observation;
        const source = observation.source;
        const type = selected.evidenceType === 'model' ? 'Verkehrsmodell' : selected.evidenceType === 'stale-measured' ? 'Älterer gemessener Verkehrswert' : 'Gemessene Verkehrsbelastung';
        const key = JSON.stringify([source.sourceId, source.contentHash, type, observation.mode, observation.unit]);
        if (!groups.has(key)) groups.set(key, { ...sets(), source, type, mode: observation.mode, unit: observation.unit });
        const group = groups.get(key);
        group.values.add(observation.value);
        group.years.add(observation.year); group.periods.add(observation.period);
        group.directions.add(observation.direction || 'unbekannt');
        group.qualities.add(selected.matchQuality || 'unbekannt');
        group.methods.add(selected.matchMethod || 'unbekannt');
        for (const note of [...(source.qualityNotes || []), ...(observation.qualityNotes || [])]) group.notes.add(note);
        for (const note of observation.qualityNotes || []) group.observationNotes.add(note);
        if (Number.isFinite(selected.distanceMeters)) group.distances.push(selected.distanceMeters);
        else group.unknownDistance = true;
      } else if (['high','medium','low','very_high'].includes(p.traffic_proxy_class) && (!p.traffic_measurement_type || p.traffic_measurement_type === 'proxy')) {
        add('Verkehrsproxy aus OSM-Straßenklasse; qualitative Expositionsklasse, keine Verkehrszählung und kein numerischer Verkehrswert. © OpenStreetMap-Mitwirkende, ODbL.', 'https://www.openstreetmap.org/copyright');
      }
      if (Object.keys(p).some(key => /^(elevation_m$|slope_|road_slope_)/.test(key) && p[key] != null)) {
        const presentation = elevation.presentContext(p);
        const usesRoad = typeof p.road_slope_percent === 'number' && Number.isFinite(p.road_slope_percent);
        const meta = usesRoad
          ? (roadSourceMatches(p, facts.roadSlope) ? facts.roadSlope : {})
          : facts.dem || {};
        const descriptor = meta.source && typeof meta.source === 'object' ? meta.source : meta;
        const sourceName = presentation.source === 'Quelle nicht dokumentiert' ? 'Geländequelle nicht dokumentiert' : presentation.source;
        const clock = descriptor.retrievedAt || meta.retrievedAt;
        const label = `${presentation.reliableForRoad ? 'Straßenprofil' : 'Geländekontext (keine belastbare Fahrbahnneigung)'}: ${sourceName}` +
          `${presentation.sourceId ? ` [${presentation.sourceId}]` : ''}; Auflösung ${presentation.resolutionMeters == null ? 'unbekannt' : `${presentation.resolutionMeters} m`}; ` +
          `${clock ? `Abruf ${clock}` : 'Abruf unbekannt'}; ${presentation.uncertaintyPercent == null ? 'Unsicherheit nicht angegeben' : `Unsicherheit ±${presentation.uncertaintyPercent} Prozentpunkte`}` +
          `${presentation.uncertaintyReasons.length ? `; Einschränkungen: ${presentation.uncertaintyReasons.join('; ')}` : ''}.`;
        add(label, descriptor.distributionUrl || descriptor.datasetUrl || descriptor.url || (/SRTM/i.test(sourceName) ? 'https://registry.opendata.aws/terrain-tiles/' : null));
      }
      if (p.highway || p.osm_highway) add('OpenStreetMap-Straßenattribute (© OpenStreetMap-Mitwirkende, ODbL); keine Verkehrszählung.', 'https://www.openstreetmap.org/copyright');
    }
    const join = values => [...values].sort().join(', ');
    for (const group of groups.values()) {
      const minDistance = group.distances.reduce((min, value) => Math.min(min, value), Infinity);
      const maxDistance = group.distances.reduce((max, value) => Math.max(max, value), -Infinity);
      const distance = group.distances.length ? `${minDistance}${maxDistance === minDistance ? '' : `–${maxDistance}`} m` : 'unbekannt';
      const source = group.source;
      const values = [...group.values].sort((a,b) => a-b);
      const formatValue = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 20 }).format(value);
      const valueLabel = values.length === 1 ? `Originalwert: ${formatValue(values[0])} ${group.unit}`
        : `Spanne ausgewählter Originalwerte: ${formatValue(values[0])}–${formatValue(values[values.length-1])} ${group.unit} (keine Summe oder Zeitumrechnung)`;
      const visibleNotes = [];
      const detailedSource = options.sourceDetailsIncluded === true
        ? ctx?.exportSourceManifest?.sources?.find(item => item.sourceId === source.sourceId && item.contentHash === source.contentHash)
        : null;
      let hasDetailedNotes = false;
      for (const note of group.notes) {
        if (!group.observationNotes.has(note) && (source.qualityNotes || []).includes(note) &&
            detailedSource?.qualityNotes?.includes(note)) {
          hasDetailedNotes = true;
          continue;
        }
        const projected = artifactProvenance.projectQualityNote(note);
        const links = projected.runs.filter(run => run.url);
        if (links.length) {
          // A separate qualified source entry uses the existing real-link path
          // in text/HTML/DOCX/PDF, without repeating a technical URL in the label.
          for (const link of links) add(projected.text, link.url);
        } else visibleNotes.push(projected.text);
      }
      add(`${group.type}: ${source.publisher} – ${source.datasetTitle} [${source.sourceId}]; ${valueLabel}; Verkehrsart ${group.mode}; Einheit ${group.unit}; Zeitraum ${join(group.periods)}; Jahr ${join(group.years)}; Richtung ${join(group.directions).replace(/\s*→\s*/g, ' nach ')}; Matching ${join(group.methods)}, Qualität ${join(group.qualities)}, Entfernung ${distance}${group.unknownDistance && group.distances.length ? ' (teilweise unbekannt)' : ''}; Abruf ${source.retrievedAt}; Lizenz ${source.licenseId}.` +
        `${group.type === 'Älterer gemessener Verkehrswert' ? ' Veralteter Messstand.' : ''}` +
        `${visibleNotes.length ? ` Grenzen: ${visibleNotes.sort().join('; ')}` : ''}` +
        `${hasDetailedNotes ? ' Detaillierte Quellenhinweise: siehe Abschnitt Datenquellen, Methodik und Nachvollziehbarkeit.' : ''}`,
        source.distributionUrl || source.datasetUrl);
    }
    if (!sources.size) return null;
    return { title: 'Kontextdaten – Datenquellen',
      body: 'Die ausgewählten Kontextdaten beschreiben die Umgebung der Unfallorte, nicht deren Ursachen. Messwerte, Modelle und qualitative Proxys bleiben getrennte Evidenzarten; Einheiten, Zeiträume und Zuordnungsqualität sind nicht austauschbar.',
      sources: [...sources.values()].sort((a,b) => a.label.localeCompare(b.label)) };
  }

  function roadSourceMatches(p, source) {
    if (!source || !p.road_slope_source_id) return false;
    if ((source.sourceId || source.source?.id) !== p.road_slope_source_id) return false;
    if (p.road_slope_manifest_sha256 && source.manifestSha256 !== p.road_slope_manifest_sha256) return false;
    if (p.road_slope_distribution_sha256 && source.distributionSha256 !== p.road_slope_distribution_sha256) return false;
    return true;
  }

  function contextSourceFacts(ctx, normalizedPoints) {
    const rows = normalizedPoints.filter(point => point.context);
    const available = ctx?.contextLayerState?.meta?.sources || {};
    const result = {};
    if (rows.some(point => Object.keys(point.context).some(key => /^(elevation_m$|slope_)/.test(key)))) {
      if (available.dem) result.dem = available.dem;
    }
    if (rows.some(point => roadSourceMatches(point.context, available.roadSlope))) result.roadSlope = available.roadSlope;
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
      const ordinary = { ...(feature.properties || {}) };
      for (const key of Object.keys(ordinary)) {
        if (/^(matched_way_id$|elevation_m$|slope_|road_slope_|traffic_)/.test(key)) delete ordinary[key];
      }
      feature.properties = { ...ordinary, ...context };
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

  async function readBuildInfo(UA, root) {
    const cacheableRoot = root && (typeof root === "object" || typeof root === "function");
    if (cacheableRoot && buildInfoPromises.has(root)) {
      return buildInfoPromises.get(root);
    }
    if (!cacheableRoot && fallbackBuildInfoPromise) {
      return fallbackBuildInfoPromise;
    }
    const promise = (async () => {
      if (typeof root?.fetch === "function") {
        try {
          const response = await root.fetch("build-manifest.json", { cache: "no-store" });
          if (response?.ok) {
            const manifest = await response.json();
            const version = manifest?.application?.version;
            const declaredFingerprint = [
              manifest?.buildFingerprint,
              manifest?.applicationFingerprint,
              manifest?.appFingerprint,
              manifest?.siteFingerprint,
            ].find(candidate => typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate));
            return {
              applicationVersion: (typeof version === "string" && version.trim()) || "Version unbekannt",
              fingerprint: declaredFingerprint?.toLowerCase()
                || await artifactProvenance.sha256(sourceManifest.stableStringify(manifest)),
            };
          }
        } catch (_) {
          // Local source tests and direct module consumers use the build-label fallback.
        }
      }
      return {
        applicationVersion: "Version unbekannt",
        fingerprint: await artifactProvenance.sha256(buildLabel(UA, root)),
      };
    })();
    if (cacheableRoot) buildInfoPromises.set(root, promise);
    else fallbackBuildInfoPromise = promise;
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
      const normalized = sourceManifest.normalizeManifest(ctx.exportSourceManifest);
      const snapshot = snapshotFor(ctx);
      if (snapshot) manifestSnapshots.set(normalized, snapshot);
      return normalized;
    }

    const points = environment.projectedPoints || exportPoints(UA, ctx);
    const activePoints = UA?.AnalysisScope?.getActiveFilteredPoints
      ? UA.AnalysisScope.getActiveFilteredPoints(copyContext(ctx, { allPts: points })) : points;
    const filterContext = captureFilterContext(ctx);
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
    // Source metadata and selected Way evidence must describe the same frozen
    // data snapshot even if a lazy context load completes during hashing.
    const contextFacts = JSON.parse(sourceManifest.stableStringify(contextSourceFacts(ctx, normalizedPoints)));
    const contextPoints = normalizedPoints.filter(point => point.context);
    const dataSnapshot = { city, bounds, filters, years, points: normalizedPoints,
      ...(contextPoints.length ? { contextSources: contextFacts } : {}) };
    const dataCanonical = sourceManifest.stableStringify(dataSnapshot);
    const dataFingerprint = await artifactProvenance.sha256(dataCanonical);
    const { applicationVersion, fingerprint: appFingerprint } = await readBuildInfo(UA, root);
    const cached = manifestCache.get(ctx);
    if (
      cached &&
      cached.dataFingerprint === dataFingerprint &&
      cached.buildFingerprint === appFingerprint &&
      cached.manifest.applicationVersion === applicationVersion
    ) {
      // Population order may change without changing the canonical data hash.
      // Retain the currently selected order for an outer wrapper's bound export.
      cached.projectedPoints = points;
      cached.activePoints = activePoints;
      cached.filterContext = filterContext;
      manifestSnapshots.set(cached.manifest, cached);
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
      applicationVersion,
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
          softwareVersion: applicationVersion,
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
      projectedPoints: points,
      activePoints,
      filterContext,
    });
    manifestSnapshots.set(normalized, manifestCache.get(ctx));
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
        const captured = await captureOriginalExport(root, originals.csv, bindExportContext(UA, ctx, manifest));
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
        // Bind one projected snapshot before any async export step; loaded Way
        // rows may change later, but the emitted payload must match its hash.
        const points = boundExportPoints(UA, ctx);
        const manifest = await createManifest(ctx, { UA, root, projectedPoints: points });
        const captured = await captureOriginalExport(root, originals.geojson, bindExportContext(UA, ctx, manifest));
        const parsed = JSON.parse(await readBlobText(captured.blob, root));
        if (ctx?.exportContextEvidence !== false) attachContextProperties(parsed, points);
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
        const captured = await captureOriginalExport(root, originals.kml, bindExportContext(UA, ctx, manifest));
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
    dataContextProperties,
    boundExportPoints,
    bindExportContext,
    buildContextNote,
    attachContextProperties,
    readBlobText,
    captureOriginalExport,
    install,
  });
});
