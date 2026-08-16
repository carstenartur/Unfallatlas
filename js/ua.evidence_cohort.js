(function initEvidenceCohort(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.UA) {
    root.UA.EvidenceCohort = Object.freeze(api);
    api.install(root.UA, root);
  }
})(typeof window !== 'undefined' ? window : null, function evidenceCohortFactory() {
  'use strict';

  const SCHEMA_VERSION = 'unfallwerkbank.evidenceCohorts.v1';
  const COVERAGE_SCHEMA = 'unfallwerkbank.evidenceCohortCoverage.v1';
  const CONTRACT_SCHEMA = 'unfallwerkbank.evidenceCohortContract.v1';
  const MODULE_VERSION = '1.0.0';
  const HOOK_MARK = '_uaEvidenceCohortWrapped';
  const AI_GATE_MARK = '_uaEvidenceGateBound';
  const INVOLVEMENT_BITS = Object.freeze([
    [1, 'Rad'], [2, 'Fuß'], [4, 'Pkw'], [8, 'Kraftrad'], [16, 'Güterkraftfahrzeug'], [32, 'Sonstige'],
  ]);
  const SEVERITY_LABELS = Object.freeze({ 1: 'Getötet', 2: 'Schwerverletzt', 3: 'Leichtverletzt' });
  const ROAD_LABELS = Object.freeze({ 0: 'trocken', 1: 'nass/feucht/schlüpfrig', 2: 'winterglatt' });
  const WEEKDAY_LABELS = Object.freeze({
    1: 'Sonntag', 2: 'Montag', 3: 'Dienstag', 4: 'Mittwoch', 5: 'Donnerstag', 6: 'Freitag', 7: 'Samstag',
  });

  const clean = value => String(value == null ? '' : value).trim();
  const list = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const numberOrNull = value => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const intOrNull = value => {
    const number = numberOrNull(value);
    return number === null ? null : Math.trunc(number);
  };
  const first = (source, keys) => {
    for (const key of keys) {
      if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
    return null;
  };

  function rootContext(ctx) {
    let current = ctx;
    const seen = new Set();
    for (let depth = 0; current && typeof current === 'object' && depth < 32 && !seen.has(current); depth += 1) {
      seen.add(current);
      const next = current.__analysisScopeOriginalCtx || current.__uaOriginalCtx || null;
      if (!next) break;
      current = next;
    }
    return current || ctx;
  }

  function plainBounds(bounds) {
    if (!bounds) return null;
    if (typeof bounds.getSouth === 'function') {
      return {
        south: Number(bounds.getSouth()), west: Number(bounds.getWest()),
        north: Number(bounds.getNorth()), east: Number(bounds.getEast()),
      };
    }
    if (typeof bounds.getSouthWest === 'function' && typeof bounds.getNorthEast === 'function') {
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      return { south: Number(sw.lat), west: Number(sw.lng), north: Number(ne.lat), east: Number(ne.lng) };
    }
    if (Array.isArray(bounds) && bounds.length === 4) {
      return { south: Number(bounds[0]), west: Number(bounds[1]), north: Number(bounds[2]), east: Number(bounds[3]) };
    }
    if (typeof bounds === 'object') {
      return {
        south: Number(bounds.south), west: Number(bounds.west),
        north: Number(bounds.north), east: Number(bounds.east),
      };
    }
    return null;
  }

  function validBounds(bounds) {
    const result = plainBounds(bounds);
    if (!result || !Object.values(result).every(Number.isFinite)) return null;
    if (result.south > result.north || result.west > result.east) return null;
    return result;
  }

  function exportBounds(ctx) {
    const source = rootContext(ctx);
    let mapBounds = null;
    try { mapBounds = source?.map?.getBounds?.() || null; } catch (_) { mapBounds = null; }
    return validBounds(source?.selectionBounds || mapBounds);
  }

  function pointInBounds(point, bounds) {
    const b = validBounds(bounds);
    const lat = numberOrNull(point?.lat);
    const lon = numberOrNull(point?.lon);
    return !!b && lat !== null && lon !== null
      && lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  }

  function maskFromPoint(UA, point) {
    if (typeof UA?.maskFromProps === 'function') return Number(UA.maskFromProps(point?.props || {})) || 0;
    const props = point?.props || {};
    const flag = keys => clean(first(props, keys)) === '1';
    return (flag(['istrad', 'IstRad']) ? 1 : 0)
      | (flag(['istfuss', 'IstFuss']) ? 2 : 0)
      | (flag(['istpkw', 'IstPKW']) ? 4 : 0)
      | (flag(['istkrad', 'IstKrad']) ? 8 : 0)
      | (flag(['istgkfz', 'IstGkfz']) ? 16 : 0)
      | (flag(['istsonstig', 'IstSonstig']) ? 32 : 0);
  }

  function involvementLabel(mask) {
    const labels = INVOLVEMENT_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, label]) => label);
    return labels.length ? labels.join(' + ') : 'Beteiligungsart nicht veröffentlicht';
  }

  function fnv1a(text, seed) {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function fingerprintForPoint(UA, point) {
    const props = point?.props || {};
    const sourceId = first(props, [
      'objectid', 'OBJECTID', 'unfallid', 'UnfallID', 'uid', 'UID', 'id', 'ID', 'fid', 'FID',
    ]);
    const canonical = [
      sourceId,
      first(props, ['ujahr', 'UJAHR', 'year', 'Jahr']),
      first(props, ['umonat', 'UMONAT', 'month', 'Monat']),
      first(props, ['uwochentag', 'UWOCHENTAG', 'weekday']),
      first(props, ['ustunde', 'USTUNDE', 'hour']),
      first(props, ['ukategorie', 'UKATEGORIE', 'severity']),
      first(props, ['strzustand', 'STRZUSTAND', 'roadCondition']),
      first(props, ['utyp1', 'UTYP1', 'accidentType']),
      first(props, ['uart', 'UART', 'accidentKind']),
      first(props, ['ulichtverh', 'ULICHTVERH', 'light']),
      maskFromPoint(UA, point),
      numberOrNull(point?.lat)?.toFixed(7),
      numberOrNull(point?.lon)?.toFixed(7),
    ].map(value => value == null ? '' : String(value)).join('|');
    const left = fnv1a(canonical, 0x811c9dc5).toString(16).padStart(8, '0');
    const right = fnv1a(canonical.split('').reverse().join(''), 0x9e3779b9).toString(16).padStart(8, '0');
    return `${left}${right}`;
  }

  function sourceIdForPoint(point) {
    const value = first(point?.props || {}, [
      'objectid', 'OBJECTID', 'unfallid', 'UnfallID', 'uid', 'UID', 'id', 'ID', 'fid', 'FID',
    ]);
    return value == null ? null : String(value);
  }

  function pointSortKey(UA, point) {
    const props = point?.props || {};
    const part = value => value == null ? 9999 : Number(value);
    return [
      part(intOrNull(first(props, ['ujahr', 'UJAHR', 'year', 'Jahr']))),
      part(intOrNull(first(props, ['umonat', 'UMONAT', 'month', 'Monat']))),
      part(intOrNull(first(props, ['uwochentag', 'UWOCHENTAG', 'weekday']))),
      part(intOrNull(first(props, ['ustunde', 'USTUNDE', 'hour']))),
      numberOrNull(point?.lat) ?? 999,
      numberOrNull(point?.lon) ?? 999,
      fingerprintForPoint(UA, point),
    ];
  }

  function compareTuple(a, b) {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if (a[index] < b[index]) return -1;
      if (a[index] > b[index]) return 1;
    }
    return 0;
  }

  function baseAnalysisUrl(report, rootValue) {
    const candidate = report?.structured?.meta?.link
      || report?.structured?.meta?.mapUrl
      || report?.structured?.mapUrl
      || rootValue?.location?.href
      || '';
    return clean(candidate);
  }

  function deepLink(baseUrl, row, options) {
    if (!baseUrl) return '';
    try {
      const url = new URL(baseUrl, 'https://example.invalid/');
      url.searchParams.set('evidenceLabels', '1');
      url.searchParams.set('evidenceScope', 'complete');
      if (row?.displayId) url.searchParams.set('evidenceAccident', row.displayId);
      if (Number.isFinite(row?.lat) && Number.isFinite(row?.lon)) {
        url.searchParams.set('centerLat', Number(row.lat).toFixed(6));
        url.searchParams.set('centerLon', Number(row.lon).toFixed(6));
        url.searchParams.set('zoom', String(Math.max(18, Number(options?.zoom) || 19)));
      }
      return url.origin === 'https://example.invalid' ? `${url.pathname}${url.search}${url.hash}` : url.href;
    } catch (_) {
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}evidenceLabels=1&evidenceScope=complete${row?.displayId ? `&evidenceAccident=${encodeURIComponent(row.displayId)}` : ''}`;
    }
  }

  function weekdayGroup(code) {
    return code === 1 || code === 7 ? 'Wochenende' : (code == null ? null : 'Werktag');
  }

  function rowFromPoint(UA, point, discoveryFingerprints, displayId, baseUrl) {
    const props = point?.props || {};
    const mask = maskFromPoint(UA, point);
    const year = intOrNull(first(props, ['ujahr', 'UJAHR', 'year', 'Jahr']));
    const month = intOrNull(first(props, ['umonat', 'UMONAT', 'month', 'Monat']));
    const weekday = intOrNull(first(props, ['uwochentag', 'UWOCHENTAG', 'weekday']));
    const hour = intOrNull(first(props, ['ustunde', 'USTUNDE', 'hour']));
    const severity = intOrNull(first(props, ['ukategorie', 'UKATEGORIE', 'severity']));
    const roadCondition = intOrNull(first(props, ['strzustand', 'STRZUSTAND', 'roadCondition']));
    const fingerprint = fingerprintForPoint(UA, point);
    const discoveryMatch = discoveryFingerprints.has(fingerprint);
    const row = {
      displayId,
      sourceFingerprint: fingerprint,
      sourceId: sourceIdForPoint(point),
      year,
      month,
      weekday,
      weekdayLabel: WEEKDAY_LABELS[weekday] || '—',
      weekdayGroup: weekdayGroup(weekday),
      hour,
      severity,
      severityLabel: SEVERITY_LABELS[severity] || 'Schwere nicht veröffentlicht',
      involvementMask: mask,
      involvementLabel: involvementLabel(mask),
      roadCondition,
      roadConditionLabel: ROAD_LABELS[roadCondition] || 'nicht veröffentlicht',
      accidentType: intOrNull(first(props, ['utyp1', 'UTYP1', 'accidentType'])),
      accidentKind: intOrNull(first(props, ['uart', 'UART', 'accidentKind'])),
      light: intOrNull(first(props, ['ulichtverh', 'ULICHTVERH', 'light'])),
      lat: numberOrNull(point?.lat),
      lon: numberOrNull(point?.lon),
      discoveryMatch,
      discoveryRole: discoveryMatch ? 'durch aktive Suchfilter hervorgehoben' : 'zusätzlich in vollständiger Gebietsevidenz berücksichtigt',
      mapRef: null,
      mapDeepLink: '',
    };
    row.mapDeepLink = deepLink(baseUrl, row);
    try {
      Object.defineProperty(point, '__uaEvidenceDisplayId', { value: displayId, enumerable: false, configurable: true });
      Object.defineProperty(point, '__uaEvidenceFingerprint', { value: fingerprint, enumerable: false, configurable: true });
    } catch (_) { /* read-only fixtures remain usable */ }
    return row;
  }

  function reportingPeriod(rows) {
    const years = rows.map(row => row.year).filter(Number.isFinite);
    return years.length ? { from: Math.min(...years), to: Math.max(...years) } : null;
  }

  function hasVulnerablePoi(structured) {
    const poi = structured?.poi || structured?.poiAnalysis || {};
    const within = poi.withinByType || {};
    const near = poi.nearByType || {};
    const types = ['school', 'kindergarten', 'childcare', 'kita'];
    return types.some(type => Number(within[type] || 0) > 0 || Number(near[type] || 0) > 0)
      || list(poi.items || poi.features).some(item => types.includes(clean(item?.type || item?.properties?.type).toLowerCase()));
  }

  function activeDiscoveryPoints(UA, ctx, bounds) {
    const source = rootContext(ctx);
    let points = [];
    if (typeof UA?.AnalysisScope?.getActiveFilteredPoints === 'function') {
      try { points = UA.AnalysisScope.getActiveFilteredPoints(source); } catch (_) { points = []; }
    }
    if (!points.length) points = list(source?.filteredAll).length ? source.filteredAll : list(source?.viewportPts);
    return list(points).filter(point => pointInBounds(point, bounds));
  }

  function allAreaPoints(ctx, bounds) {
    return list(rootContext(ctx)?.allPts).filter(point => pointInBounds(point, bounds));
  }

  function partitionRows(rows, maxPerMap) {
    const limit = Math.max(1, Number(maxPerMap) || 18);
    const partitions = [];
    function split(items) {
      if (items.length <= limit) {
        partitions.push(items.slice());
        return;
      }
      const lats = items.map(item => item.lat).filter(Number.isFinite);
      const lons = items.map(item => item.lon).filter(Number.isFinite);
      const latSpan = lats.length ? Math.max(...lats) - Math.min(...lats) : 0;
      const lonSpan = lons.length ? Math.max(...lons) - Math.min(...lons) : 0;
      const axis = latSpan >= lonSpan ? 'lat' : 'lon';
      const sorted = items.slice().sort((a, b) => (a[axis] - b[axis]) || a.displayId.localeCompare(b.displayId));
      const mid = Math.ceil(sorted.length / 2);
      split(sorted.slice(0, mid));
      split(sorted.slice(mid));
    }
    split(list(rows));
    partitions.forEach((partition, index) => partition.forEach(row => { row.mapRef = `E${index + 1}`; }));
    return partitions;
  }

  function boundsForRows(rows) {
    const valid = list(rows).filter(row => Number.isFinite(row.lat) && Number.isFinite(row.lon));
    if (!valid.length) return null;
    return {
      south: Math.min(...valid.map(row => row.lat)),
      west: Math.min(...valid.map(row => row.lon)),
      north: Math.max(...valid.map(row => row.lat)),
      east: Math.max(...valid.map(row => row.lon)),
    };
  }

  function buildCohorts(UA, ctx, report, rootValue) {
    const source = rootContext(ctx);
    const bounds = exportBounds(source);
    const baseUrl = baseAnalysisUrl(report, rootValue);
    if (!bounds || !Array.isArray(source?.allPts)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        moduleVersion: MODULE_VERSION,
        generatedAt: new Date().toISOString(),
        status: 'not-assessable',
        bounds: bounds || null,
        reportingPeriod: null,
        numberedMapUrl: baseUrl ? deepLink(baseUrl, null) : null,
        discoveryCohort: { purpose: 'Mustererkennung und Priorisierung', rule: 'aktive Filter', count: 0, accidentIds: [] },
        completeEvidenceCohort: { purpose: 'vollständige Antrags- und Beweisgrundlage', rule: 'alle veröffentlichten Personenschadensunfälle im Gebiet', count: 0, accidentIds: [], rows: [] },
        referenceCohort: { purpose: 'ausgewiesene statistische Referenz', rule: 'siehe Methodik', count: null },
        relationship: { discoveryIsSubset: false, completeCount: 0, discoveryCount: 0, additionallyConsideredCount: 0 },
        vulnerableUserPriority: {
          principle: 'Besonders verletzliche Menschen sind bei gleicher Evidenz vorrangig zu schützen.',
          rule: 'Schulen und Kindertagesstätten erhöhen Schutz- und Prüfpriorität, sind aber kein Ursachennachweis.',
          requiresExplicitConsideration: hasVulnerablePoi(report?.structured),
        },
      };
    }

    const completePoints = allAreaPoints(source, bounds).sort((a, b) => compareTuple(pointSortKey(UA, a), pointSortKey(UA, b)));
    const discoveryPoints = activeDiscoveryPoints(UA, source, bounds);
    const discoveryFingerprints = new Set(discoveryPoints.map(point => fingerprintForPoint(UA, point)));
    const width = Math.max(3, String(Math.max(1, completePoints.length)).length);
    const rows = completePoints.map((point, index) => rowFromPoint(
      UA, point, discoveryFingerprints, `A${String(index + 1).padStart(width, '0')}`, baseUrl
    ));
    const partitions = partitionRows(rows, 18);
    const completeFingerprints = new Set(rows.map(row => row.sourceFingerprint));
    const missingDiscovery = [...discoveryFingerprints].filter(value => !completeFingerprints.has(value));
    const discoveryIds = rows.filter(row => row.discoveryMatch).map(row => row.displayId);
    const completeIds = rows.map(row => row.displayId);
    const numberedMapUrl = deepLink(baseUrl, null);
    const filters = report?.structured?.meta?.filters || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      moduleVersion: MODULE_VERSION,
      generatedAt: new Date().toISOString(),
      status: missingDiscovery.length ? 'not-assessable' : 'complete',
      bounds,
      reportingPeriod: reportingPeriod(rows),
      activeFilterSnapshot: filters,
      numberedMapUrl: numberedMapUrl || null,
      discoveryCohort: {
        purpose: 'Mustererkennung und Priorisierung nach dem Prinzip hoher Sicherheitsnutzen pro eingesetzter Ressource',
        rule: 'alle aktiven Beteiligungs-, Schwere-, Zeit-, Straßen- und Kontextfilter innerhalb des Gebiets',
        count: discoveryIds.length,
        accidentIds: discoveryIds,
      },
      completeEvidenceCohort: {
        purpose: 'vollständige Tatsachen-, Antrags- und Beweisgrundlage',
        rule: 'alle im geladenen Unfallatlas-Datensatz veröffentlichten Unfälle mit Personenschaden innerhalb der Auswahlgrenzen; Suchfilter begrenzen diese Menge nicht',
        count: completeIds.length,
        accidentIds: completeIds,
        rows,
      },
      referenceCohort: {
        purpose: 'ausgewiesene statistische Referenz für Musteranteils- oder andere Vergleichsverfahren',
        rule: report?.structured?.meta?.baselineScope?.basis || 'siehe Methodik und Referenzpopulation des Analyseberichts',
        count: numberOrNull(report?.structured?.deviations?.baseline?.total),
      },
      relationship: {
        discoveryIsSubset: missingDiscovery.length === 0,
        completeCount: completeIds.length,
        discoveryCount: discoveryIds.length,
        additionallyConsideredCount: Math.max(0, completeIds.length - discoveryIds.length),
        missingDiscoveryFingerprints: missingDiscovery,
      },
      detailMapPartitions: partitions.map((partition, index) => ({
        mapRef: `E${index + 1}`,
        accidentIds: partition.map(row => row.displayId),
        count: partition.length,
        bounds: boundsForRows(partition),
      })),
      vulnerableUserPriority: {
        principle: 'Besonders verletzliche Menschen – insbesondere Kinder, zu Fuß Gehende und Radfahrende – sind bei Priorisierung und Maßnahmenfolgen ausdrücklich zu berücksichtigen.',
        rule: 'Schulen und Kindertagesstätten erhöhen Schutz- und Prüfpriorität für Geschwindigkeit, Querungen, Sicht, Bring-/Holverkehr sowie durchgängige Fuß- und Radführungen; ihre Nähe beweist keine Unfallursache.',
        requiresExplicitConsideration: hasVulnerablePoi(report?.structured),
      },
    };
  }

  function severitySummary(rows) {
    const bySev = { '1': 0, '2': 0, '3': 0, other: 0 };
    for (const row of rows) {
      const key = String(row.severity ?? 'other');
      if (Object.prototype.hasOwnProperty.call(bySev, key)) bySev[key] += 1;
      else bySev.other += 1;
    }
    return { total: rows.length, bySev };
  }

  function yearSummary(rows) {
    const map = new Map();
    for (const row of rows) {
      if (!Number.isFinite(row.year)) continue;
      const item = map.get(row.year) || { year: row.year, sev1: 0, sev2: 0, sev3: 0, total: 0 };
      item.total += 1;
      if (row.severity === 1) item.sev1 += 1;
      else if (row.severity === 2) item.sev2 += 1;
      else if (row.severity === 3) item.sev3 += 1;
      map.set(row.year, item);
    }
    return [...map.values()].sort((a, b) => a.year - b.year);
  }

  function crossSummary(rows) {
    const byMask = new Map();
    for (const row of rows) {
      const item = byMask.get(row.involvementMask) || {
        mask: row.involvementMask, textLabel: row.involvementLabel,
        sev1: 0, sev2: 0, sev3: 0, total: 0,
      };
      item.total += 1;
      if (row.severity === 1) item.sev1 += 1;
      else if (row.severity === 2) item.sev2 += 1;
      else if (row.severity === 3) item.sev3 += 1;
      byMask.set(row.involvementMask, item);
    }
    const resultRows = [...byMask.values()].sort((a, b) => b.total - a.total || a.mask - b.mask);
    const totals = resultRows.reduce((sum, item) => ({
      sev1: sum.sev1 + item.sev1,
      sev2: sum.sev2 + item.sev2,
      sev3: sum.sev3 + item.sev3,
      total: sum.total + item.total,
    }), { sev1: 0, sev2: 0, sev3: 0, total: 0 });
    return { rows: resultRows, totals };
  }

  function detailItem(row) {
    return {
      displayId: row.displayId,
      sourceFingerprint: row.sourceFingerprint,
      sourceId: row.sourceId,
      year: row.year,
      severity: row.severity == null ? '' : String(row.severity),
      sevLabel: row.severityLabel,
      involved: row.involvementLabel,
      hour: row.hour,
      weekday: row.weekdayLabel,
      weekdayGroup: row.weekdayGroup,
      roadCondition: row.roadConditionLabel,
      mask: row.involvementMask,
      lat: row.lat,
      lon: row.lon,
      discoveryMatch: row.discoveryMatch,
      discoveryRole: row.discoveryRole,
      mapRef: row.mapRef,
      mapDeepLink: row.mapDeepLink,
    };
  }

  function buildEvidenceStructured(cohorts, baseStructured) {
    const rows = list(cohorts?.completeEvidenceCohort?.rows);
    const detailRows = rows.map(detailItem);
    const groups = [{
      key: 'complete-evidence',
      count: detailRows.length,
      rows: detailRows,
      overflow: 0,
      headers: {
        text: `--- Vollständiges Gebietskollektiv (n=${detailRows.length}) ---`,
        html: `<div style="font-weight:700;margin-top:10px;">Vollständiges Gebietskollektiv (n=${detailRows.length})</div>`,
        docx: [{ text: `Vollständiges Gebietskollektiv (n=${detailRows.length})`, bold: true }],
      },
    }];
    return {
      ...(baseStructured || {}),
      totalAccidents: rows.length,
      severity: severitySummary(rows),
      yearTable: yearSummary(rows),
      crossTable: crossSummary(rows),
      accidentDetails: {
        viewId: 'flat',
        columns: ['Unfall-ID', 'Jahr', 'Schwere', 'Beteiligte', 'Uhrzeit', 'Wochentag', 'Fahrbahnzustand', 'Koordinaten'],
        total: detailRows.length,
        rows: detailRows,
        groups,
        truncated: false,
      },
      evidenceCohorts: cohorts,
      accidentEvidenceAppendix: buildAppendix(cohorts, baseStructured),
      deviations: { local: { total: rows.length }, baseline: {}, focus: [] },
      recommendedMeasures: [],
      patterns: [],
      meta: {
        ...(baseStructured?.meta || {}),
        documentPurpose: 'complete-numbered-accident-evidence-appendix',
        filters: {
          ...(baseStructured?.meta?.filters || {}),
          severity: 'all', roadCondition: 'all', dayType: 'all', hourFrom: 0, hourTo: 23,
          involvementMode: 'or', includeCyclist: true, includePedestrian: true, includeCar: true,
          includeMotorcycle: true, includeGkfz: true, includeSonstig: true,
          evidenceScope: 'complete-area',
        },
        countScope: {
          primary: 'complete-evidence-area',
          area: 'ausgewählter Untersuchungsbereich',
          completeEvidenceCount: rows.length,
          discoveryCount: cohorts?.discoveryCohort?.count || 0,
          includesDiscoveryFilters: false,
        },
      },
      methodikScope: {
        title: 'Methodik – vollständige Beweisanlage',
        lines: [
          `Vollständige Gebietsevidenz: ${rows.length} veröffentlichte Unfälle mit Personenschaden innerhalb der Auswahlgrenzen.`,
          `Entdeckungsteilmenge: ${cohorts?.discoveryCohort?.count || 0} Unfälle unter den aktiven Suchfiltern.`,
          'Die Suchfilter dienen der Mustererkennung und Priorisierung; sie begrenzen weder den Antrag noch diese Beweisanlage.',
          'A### ist eine snapshotgebundene Dokumentkennung und keine amtliche Unfallnummer.',
        ],
      },
    };
  }

  function buildAppendix(cohorts, structured) {
    const rows = list(cohorts?.completeEvidenceCohort?.rows).map(row => ({ ...row }));
    return {
      schemaVersion: 'unfallwerkbank.accidentEvidenceAppendix.v1',
      complete: cohorts?.status === 'complete' && cohorts?.relationship?.discoveryIsSubset === true,
      truncated: false,
      total: rows.length,
      discoveryCount: cohorts?.discoveryCohort?.count || 0,
      additionallyConsideredCount: cohorts?.relationship?.additionallyConsideredCount || 0,
      rows,
      detailMapPartitions: list(cohorts?.detailMapPartitions),
      numberedMapUrl: cohorts?.numberedMapUrl || null,
      sourceNote: 'Amtliche Straßenverkehrsunfallstatistik auf Grundlage polizeilicher Meldungen; veröffentlicht sind Unfälle mit Personenschaden.',
      limitations: [
        'A### ist eine Dokumentkennung, keine amtliche Unfallnummer.',
        'Die veröffentlichte Lage darf nicht genauer interpretiert werden als die Quelldaten.',
        'Reine Sachschäden, Beinaheereignisse und nicht gemeldete Unfälle sind nicht enthalten.',
      ],
      patternFindingIds: list(structured?.patternDetection?.findings || structured?.patternAnalysis?.findings)
        .map(finding => clean(finding?.patternId || finding?.id)).filter(Boolean),
    };
  }

  function evidenceContract(cohorts) {
    return {
      schemaVersion: CONTRACT_SCHEMA,
      filingEvidenceRule: 'Der Antrag muss alle Unfälle aus completeEvidenceCohort berücksichtigen; discoveryCohort ist nur die durch Suchfilter hervorgehobene Teilmenge.',
      mapTableIdentityRule: 'A###-Kennungen müssen in Karte, Unfallliste, CSV, GeoJSON, KI-Befunden und Maßnahmenreferenzen identisch sein.',
      omissionRule: 'Ohne begründeten Datenfehler darf keine A###-Kennung ausgelassen werden.',
      measureCoverageRule: 'Jede Maßnahme muss adressierte, mitbetroffene und nicht adressierte A###-Unfälle sowie mögliche Risikoverlagerungen benennen.',
      vulnerableUserRule: cohorts?.vulnerableUserPriority?.rule || '',
    };
  }

  function attachIdsToExistingDetails(structured, cohorts) {
    const lookup = new Map(list(cohorts?.completeEvidenceCohort?.rows).map(row => {
      const key = `${row.year ?? ''}|${row.hour ?? ''}|${row.lat?.toFixed?.(7) ?? row.lat}|${row.lon?.toFixed?.(7) ?? row.lon}|${row.involvementMask}`;
      return [key, row];
    }));
    const attach = row => {
      if (!row || typeof row !== 'object') return row;
      const mask = Number(row.mask ?? row.involvementMask ?? 0);
      const key = `${row.year ?? ''}|${row.hour ?? ''}|${Number(row.lat)?.toFixed?.(7) ?? row.lat}|${Number(row.lon)?.toFixed?.(7) ?? row.lon}|${mask}`;
      const match = lookup.get(key);
      if (match) Object.assign(row, {
        displayId: match.displayId,
        sourceFingerprint: match.sourceFingerprint,
        discoveryMatch: match.discoveryMatch,
        mapRef: match.mapRef,
        mapDeepLink: match.mapDeepLink,
      });
      return row;
    };
    const details = structured?.accidentDetails;
    if (!details) return;
    details.columns = list(details.columns).length
      ? ['Unfall-ID', ...details.columns.slice(1)]
      : details.columns;
    list(details.rows).forEach(attach);
    list(details.groups).forEach(group => list(group?.rows).forEach(attach));
  }

  function escHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }

  function appendixHtml(cohorts) {
    const rows = list(cohorts?.completeEvidenceCohort?.rows);
    const body = rows.map(row => `<tr${row.discoveryMatch ? ' data-ua-discovery-match="1" style="background:#fff8d6;"' : ''}>`
      + `<td><a href="${escHtml(row.mapDeepLink)}">${escHtml(row.displayId)}</a></td>`
      + `<td>${row.year ?? '—'}</td><td>${escHtml(row.severityLabel)}</td>`
      + `<td>${escHtml(row.involvementLabel)}</td><td>${row.hour == null ? '—' : `${String(row.hour).padStart(2, '0')}:00`}</td>`
      + `<td>${escHtml(row.weekdayLabel)}</td><td>${escHtml(row.roadConditionLabel)}</td>`
      + `<td>${Number.isFinite(row.lat) && Number.isFinite(row.lon) ? `${row.lat.toFixed(5)}, ${row.lon.toFixed(5)}` : '—'}</td>`
      + `<td>${row.discoveryMatch ? 'Suchmuster' : 'weitere Gebietsevidenz'}</td><td>${escHtml(row.mapRef || '—')}</td></tr>`).join('');
    return `<section data-ua-evidence-appendix="1" style="margin-top:18px;">`
      + `<h2>Vollständige nummerierte Unfallbeweisanlage</h2>`
      + `<p>Die aktiven Filter haben ${cohorts?.discoveryCohort?.count || 0} Unfälle als Entdeckungsteilmenge hervorgehoben. `
      + `Der Antrag berücksichtigt vollständig alle ${rows.length} veröffentlichten Unfälle mit Personenschaden im Untersuchungsgebiet.</p>`
      + `<p><a href="${escHtml(cohorts?.numberedMapUrl || '')}">Nummerierte Karte öffnen</a>. `
      + `Gelb markierte Tabellenzeilen gehören zur Entdeckungsteilmenge. A### ist eine Dokumentkennung, keine amtliche Unfallnummer.</p>`
      + `<div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;font-size:11px;">`
      + `<thead><tr><th>ID</th><th>Jahr</th><th>Schwere</th><th>Beteiligte</th><th>Zeit</th><th>Wochentag</th><th>Zustand</th><th>veröffentlichte Lage</th><th>Rolle</th><th>Karte</th></tr></thead>`
      + `<tbody>${body}</tbody></table></div></section>`;
  }

  function appendixText(cohorts) {
    const rows = list(cohorts?.completeEvidenceCohort?.rows);
    const lines = [
      'VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISANLAGE',
      `Entdeckungsteilmenge unter aktiven Suchfiltern: ${cohorts?.discoveryCohort?.count || 0} Unfälle.`,
      `Vollständiges Gebietskollektiv: ${rows.length} veröffentlichte Unfälle mit Personenschaden.`,
      'A### ist eine Dokumentkennung, keine amtliche Unfallnummer.',
      'ID | Jahr | Schwere | Beteiligte | Uhrzeit | Wochentag | Fahrbahnzustand | Koordinaten | Rolle | Karte',
    ];
    for (const row of rows) {
      lines.push([
        row.displayId, row.year ?? '—', row.severityLabel, row.involvementLabel,
        row.hour == null ? '—' : `${String(row.hour).padStart(2, '0')}:00`,
        row.weekdayLabel, row.roadConditionLabel,
        Number.isFinite(row.lat) && Number.isFinite(row.lon) ? `${row.lat.toFixed(5)}, ${row.lon.toFixed(5)}` : '—',
        row.discoveryMatch ? 'Suchmuster' : 'weitere Gebietsevidenz', row.mapRef || '—',
      ].join(' | '));
    }
    return lines.join('\n');
  }

  function decorateReport(UA, ctx, report, rootValue) {
    if (!report || typeof report !== 'object') return report;
    const cohorts = buildCohorts(UA, ctx, report, rootValue);
    const structured = report.structured || (report.structured = {});
    structured.evidenceCohorts = cohorts;
    structured.evidenceCohortContract = evidenceContract(cohorts);
    structured.accidentEvidenceAppendix = buildAppendix(cohorts, structured);
    structured.completeEvidenceAnalysis = buildEvidenceStructured(cohorts, structured);
    attachIdsToExistingDetails(structured, cohorts);
    const method = structured.methodikScope || (structured.methodikScope = { title: 'Methodik – Auswertungsumfang', lines: [] });
    method.lines = list(method.lines);
    const cohortLine = `Vollständige Antrags- und Beweisgrundlage: ${cohorts.completeEvidenceCohort.count} veröffentlichte Unfälle mit Personenschaden im Gebiet; die ${cohorts.discoveryCohort.count} durch Suchfilter hervorgehobenen Unfälle sind eine Teilmenge. Suchfilter begrenzen diese Menge nicht.`;
    if (!method.lines.some(line => clean(line).includes('Suchfilter begrenzen diese Menge nicht'))) method.lines.push(cohortLine);
    if (typeof report.html === 'string' && !report.html.includes('data-ua-evidence-appendix')) {
      report.html += appendixHtml(cohorts);
    }
    if (typeof report.text === 'string' && !report.text.includes('VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISANLAGE')) {
      report.text += `\n\n${appendixText(cohorts)}`;
    }
    const source = rootContext(ctx);
    try { Object.defineProperty(source, '__uaEvidenceCohorts', { value: cohorts, configurable: true, enumerable: false }); } catch (_) { source.__uaEvidenceCohorts = cohorts; }
    return report;
  }

  function chainContains(fn, marker) {
    let current = fn;
    const seen = new Set();
    for (let depth = 0; typeof current === 'function' && depth < 32 && !seen.has(current); depth += 1) {
      if (current[marker]) return true;
      seen.add(current);
      current = current._uaOriginal || current._original || current.original || null;
    }
    return false;
  }

  function installReportHook(UA, rootValue) {
    const original = UA?.computeExportReport;
    if (typeof original !== 'function' || chainContains(original, HOOK_MARK)) return typeof original === 'function';
    const wrapped = async function evidenceCohortReport(ctx) {
      const report = await original.apply(this, arguments);
      return decorateReport(UA, ctx, report, rootValue);
    };
    wrapped[HOOK_MARK] = true;
    wrapped._uaOriginal = original;
    wrapped._original = original;
    UA.computeExportReport = wrapped;
    return true;
  }

  function wrapAccidentViews(UA) {
    const original = UA?.resolveAccidentView;
    if (typeof original !== 'function' || original._uaEvidenceIdsWrapped) return typeof original === 'function';
    const wrapped = function resolveEvidenceAwareView() {
      const view = original.apply(this, arguments);
      if (!view || !view.renderRow || view.__uaEvidenceIds) return view;
      const renderRow = { ...view.renderRow };
      if (typeof renderRow.text === 'function') {
        const previous = renderRow.text;
        renderRow.text = (row, index) => {
          const output = previous(row, index);
          return row?.displayId ? String(output).replace(new RegExp(`^(\\s*)${index + 1}(\\s*\\|)`), `$1${row.displayId}$2`) : output;
        };
      }
      if (typeof renderRow.html === 'function') {
        const previous = renderRow.html;
        renderRow.html = (row, index) => {
          const output = previous(row, index);
          return row?.displayId ? String(output).replace(`<td>${index + 1}</td>`, `<td>${escHtml(row.displayId)}</td>`) : output;
        };
      }
      if (typeof renderRow.docx === 'function') {
        const previous = renderRow.docx;
        renderRow.docx = (row, index) => {
          const cells = list(previous(row, index)).slice();
          if (row?.displayId && cells.length) cells[0] = row.displayId;
          return cells;
        };
      }
      return Object.freeze({ ...view, renderRow: Object.freeze(renderRow), __uaEvidenceIds: true });
    };
    wrapped._uaEvidenceIdsWrapped = true;
    wrapped._uaOriginal = original;
    UA.resolveAccidentView = wrapped;
    return true;
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function appendixCsv(cohorts) {
    const columns = [
      'evidence_id', 'source_fingerprint', 'source_id', 'year', 'month', 'weekday', 'hour',
      'severity', 'severity_label', 'involvement_mask', 'involvement_label', 'road_condition',
      'accident_type', 'accident_kind', 'light', 'latitude', 'longitude', 'discovery_match',
      'discovery_role', 'map_ref', 'map_deep_link',
    ];
    const lines = [columns.join(';')];
    for (const row of list(cohorts?.completeEvidenceCohort?.rows)) {
      const values = [
        row.displayId, row.sourceFingerprint, row.sourceId, row.year, row.month, row.weekday, row.hour,
        row.severity, row.severityLabel, row.involvementMask, row.involvementLabel, row.roadCondition,
        row.accidentType, row.accidentKind, row.light, row.lat, row.lon, row.discoveryMatch,
        row.discoveryRole, row.mapRef, row.mapDeepLink,
      ];
      lines.push(values.map(csvCell).join(';'));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  function appendixGeoJson(cohorts) {
    return {
      type: 'FeatureCollection',
      name: 'Unfallwerkbank vollständige nummerierte Unfallbeweisanlage',
      schemaVersion: 'unfallwerkbank.accidentEvidenceGeoJson.v1',
      evidenceCohorts: {
        discoveryCount: cohorts?.discoveryCohort?.count || 0,
        completeCount: cohorts?.completeEvidenceCohort?.count || 0,
      },
      features: list(cohorts?.completeEvidenceCohort?.rows).map(row => ({
        type: 'Feature',
        id: row.displayId,
        geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
        properties: {
          evidence_id: row.displayId,
          source_fingerprint: row.sourceFingerprint,
          source_id: row.sourceId,
          year: row.year,
          month: row.month,
          weekday: row.weekday,
          hour: row.hour,
          severity: row.severity,
          severity_label: row.severityLabel,
          involvement_mask: row.involvementMask,
          involvement_label: row.involvementLabel,
          road_condition: row.roadCondition,
          accident_type: row.accidentType,
          accident_kind: row.accidentKind,
          light: row.light,
          discovery_match: row.discoveryMatch,
          discovery_role: row.discoveryRole,
          map_ref: row.mapRef,
          map_deep_link: row.mapDeepLink,
        },
      })),
    };
  }

  function validateCoverage(result, facts) {
    const errors = [];
    const warnings = [];
    const cohorts = facts?.structured?.evidenceCohorts || facts?.evidenceCohorts || null;
    if (!cohorts || cohorts.status !== 'complete') {
      errors.push('Vollständiges Gebietskollektiv ist nicht verfügbar oder nicht konsistent.');
      return { passed: false, errors, warnings, expectedIds: [], consideredIds: [] };
    }
    const coverage = object(result?.evidenceCohortCoverage);
    if (clean(coverage.schemaVersion) !== COVERAGE_SCHEMA) errors.push(`evidenceCohortCoverage.schemaVersion muss ${COVERAGE_SCHEMA} sein.`);
    const expectedIds = list(cohorts.completeEvidenceCohort?.accidentIds).map(clean).filter(Boolean);
    const discoveryIds = list(cohorts.discoveryCohort?.accidentIds).map(clean).filter(Boolean);
    const consideredIds = list(coverage.consideredAccidentIds).map(clean).filter(Boolean);
    const considered = new Set(consideredIds);
    const missing = expectedIds.filter(id => !considered.has(id));
    const unknown = consideredIds.filter(id => !expectedIds.includes(id));
    if (Number(coverage.completeEvidenceCount) !== expectedIds.length) {
      errors.push(`completeEvidenceCount muss ${expectedIds.length} betragen.`);
    }
    if (missing.length) errors.push(`Folgende Unfälle aus dem vollständigen Gebietskollektiv fehlen: ${missing.join(', ')}.`);
    if (unknown.length) errors.push(`Unbekannte oder nicht snapshotgebundene Unfall-IDs: ${unknown.join(', ')}.`);
    const returnedDiscovery = list(coverage.discoveryAccidentIds).map(clean).filter(Boolean);
    const missingDiscovery = discoveryIds.filter(id => !returnedDiscovery.includes(id));
    if (missingDiscovery.length) errors.push(`Die Entdeckungsteilmenge ist unvollständig: ${missingDiscovery.join(', ')}.`);
    const omitted = list(coverage.omittedAccidentIds).map(clean).filter(Boolean);
    if (omitted.length) errors.push(`omittedAccidentIds muss leer sein; enthalten: ${omitted.join(', ')}.`);
    if (coverage.allAccidentsConsidered !== true) errors.push('allAccidentsConsidered muss true sein.');
    if (cohorts.vulnerableUserPriority?.requiresExplicitConsideration
        && coverage.vulnerableUserPriority?.schoolsAndKindergartensConsidered !== true) {
      errors.push('Schulen/Kindertagesstätten und der Schutz vulnerabler Personen wurden trotz vorhandener POI-Evidenz nicht ausdrücklich berücksichtigt.');
    }
    const explanation = clean(coverage.vulnerableUserPriority?.explanation);
    if (cohorts.vulnerableUserPriority?.requiresExplicitConsideration && !explanation) {
      errors.push('Begründung zur Berücksichtigung vulnerabler Personen fehlt.');
    }
    if (!Array.isArray(coverage.unaddressedAccidentIds)) {
      warnings.push('unaddressedAccidentIds sollte Maßnahmenlücken transparent ausweisen.');
    }
    return { passed: errors.length === 0, errors, warnings, expectedIds, consideredIds };
  }

  function evidenceCoverageSkeleton(cohorts) {
    const expected = list(cohorts?.completeEvidenceCohort?.accidentIds);
    const discovery = list(cohorts?.discoveryCohort?.accidentIds);
    return {
      schemaVersion: COVERAGE_SCHEMA,
      completeEvidenceCount: expected.length,
      consideredAccidentIds: expected,
      discoveryAccidentIds: discovery,
      omittedAccidentIds: [],
      unaddressedAccidentIds: [],
      allAccidentsConsidered: true,
      discoveryCohortUsedOnlyForPrioritization: true,
      vulnerableUserPriority: {
        schoolsAndKindergartensConsidered: cohorts?.vulnerableUserPriority?.requiresExplicitConsideration === true,
        explanation: '',
      },
      measureCoverage: [{
        measureId: '', directlyAddressedAccidentIds: [], additionallyBenefitingAccidentIds: [],
        notAddressedAccidentIds: [], displacementRisks: [],
      }],
    };
  }

  function wrapAiApi(UA) {
    const original = UA?.aiInvestigation;
    if (!original || original.__uaEvidenceCohortWrapped) return !!original;
    const buildRequest = handoff => {
      const request = original.buildInvestigationRequest(handoff);
      const cohorts = handoff?.facts?.structured?.evidenceCohorts || null;
      return {
        ...request,
        evidenceCohorts: cohorts,
        evidenceCohortContract: handoff?.facts?.structured?.evidenceCohortContract || null,
        expectedEvidenceCoverage: evidenceCoverageSkeleton(cohorts),
      };
    };
    const buildPrompt = handoff => {
      const base = original.buildInvestigationPrompt(handoff);
      const cohorts = handoff?.facts?.structured?.evidenceCohorts || null;
      return `${base}\n\n## Verbindliche vollständige Unfallabdeckung\n`
        + `Die aktiven Filter sind eine Such- und Priorisierungslinse. Der Antrag und seine Begründung müssen alle ${cohorts?.completeEvidenceCohort?.count ?? 0} Unfälle des vollständigen Gebietskollektivs berücksichtigen.\n`
        + `Gib im Ergebnis zusätzlich das Feld evidenceCohortCoverage exakt nach diesem Muster aus:\n`
        + `\`\`\`json\n${JSON.stringify(evidenceCoverageSkeleton(cohorts), null, 2)}\n\`\`\``;
    };
    const validate = (result, facts) => {
      const base = original.validateInvestigationResult(result, facts);
      const evidence = validateCoverage(base.result || result, facts);
      const errors = [...list(base.errors), ...evidence.errors.map((message, index) => ({
        code: `evidence-cohort-${index + 1}`, message, details: null,
      }))];
      const warnings = [...list(base.warnings), ...evidence.warnings.map((message, index) => ({
        code: `evidence-cohort-warning-${index + 1}`, message, details: null,
      }))];
      const passed = base.passed && evidence.passed;
      return {
        ...base,
        passed,
        readyForApplication: passed && base.readyForApplication,
        filingReady: passed && base.filingReady,
        errors,
        warnings,
        evidenceCohortCoverage: evidence,
      };
    };
    const applicationPrompt = (handoff, result, validation) => {
      const checked = validation || validate(result, handoff?.facts || {});
      if (!checked.evidenceCohortCoverage?.passed) {
        throw new Error(`Vollständige Unfallabdeckung nicht validiert: ${checked.evidenceCohortCoverage?.errors?.join(' | ') || 'unbekannter Fehler'}`);
      }
      return `${original.buildApplicationPrompt(handoff, result, checked)}\n\n## Vollständige Unfallbeweisanlage\n`
        + 'Beziehe alle A###-Unfälle des completeEvidenceCohort in Tatsachenkern und Gesamtbewertung ein. '
        + 'Das discoveryCohort dient nur der Priorisierung. Jede Maßnahme muss unmittelbar adressierte, zusätzlich profitierende und nicht adressierte Unfall-IDs sowie mögliche Risikoverlagerungen nennen.';
    };
    UA.aiInvestigation = Object.freeze({
      ...original,
      buildInvestigationRequest: buildRequest,
      buildInvestigationPrompt: buildPrompt,
      validateInvestigationResult: validate,
      buildApplicationPrompt: applicationPrompt,
      __uaEvidenceCohortWrapped: true,
    });
    return true;
  }

  function writeClipboard(rootValue, text) {
    if (rootValue?.navigator?.clipboard?.writeText) return rootValue.navigator.clipboard.writeText(text);
    throw new Error('Zwischenablage nicht verfügbar.');
  }

  function download(rootValue, filename, mime, content) {
    if (!rootValue?.document || !rootValue?.URL || typeof rootValue.Blob !== 'function') return false;
    const blob = new rootValue.Blob([content], { type: mime });
    const url = rootValue.URL.createObjectURL(blob);
    const anchor = rootValue.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    rootValue.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    rootValue.setTimeout(() => rootValue.URL.revokeObjectURL(url), 1000);
    return true;
  }

  function currentReport(UA) {
    const ctx = rootContext(UA?.getRuntimeContext?.() || {});
    return Promise.resolve(UA.computeExportReport(ctx)).then(report => ({ ctx, report, cohorts: report?.structured?.evidenceCohorts }));
  }

  function evidenceContext(ctx, cohorts) {
    const pointsById = new Map(list(rootContext(ctx)?.allPts).map(point => [point.__uaEvidenceDisplayId, point]));
    const completePoints = list(cohorts?.completeEvidenceCohort?.accidentIds).map(id => pointsById.get(id)).filter(Boolean);
    return Object.assign(Object.create(Object.getPrototypeOf(ctx) || Object.prototype), rootContext(ctx), {
      allPts: completePoints,
      filteredAll: completePoints,
      filteredCapped: completePoints,
      viewportPts: completePoints,
      visibleViewportPts: completePoints,
      selectionPts: completePoints,
      __uaEvidenceRows: cohorts?.completeEvidenceCohort?.rows || [],
      __uaEvidenceLabelsActive: true,
    });
  }

  function evidenceReport(report, cohorts) {
    const structured = buildEvidenceStructured(cohorts, report?.structured || {});
    return {
      text: [
        'Vollständige nummerierte Unfallbeweisanlage',
        '',
        `Gebietskollektiv: ${cohorts?.completeEvidenceCohort?.count || 0} veröffentlichte Unfälle mit Personenschaden.`,
        `Entdeckungsteilmenge unter aktiven Suchfiltern: ${cohorts?.discoveryCohort?.count || 0}.`,
        '',
        appendixText(cohorts),
      ].join('\n'),
      html: appendixHtml(cohorts),
      structured,
    };
  }

  function sourcePointsByEvidenceId(ctx) {
    return new Map(list(rootContext(ctx)?.allPts)
      .filter(point => clean(point?.__uaEvidenceDisplayId))
      .map(point => [point.__uaEvidenceDisplayId, point]));
  }

  function wait(rootValue, milliseconds) {
    return new Promise(resolve => (rootValue?.setTimeout || setTimeout)(resolve, milliseconds));
  }

  async function captureEvidenceMaps(UA, rootValue, ctx, cohorts) {
    if (typeof UA?.captureExportMapImage !== 'function') {
      throw new Error('Kartenaufnahme für die Beweisanlage ist nicht verfügbar.');
    }
    const map = rootContext(ctx)?.map;
    if (!map || typeof map.fitBounds !== 'function') {
      throw new Error('Karte oder Auswahlgrenzen für die Beweisanlage fehlen.');
    }
    const pointById = sourcePointsByEvidenceId(ctx);
    const rows = list(cohorts?.completeEvidenceCohort?.rows);
    if (!rows.length) throw new Error('Das vollständige Gebietskollektiv ist leer.');
    let center = null;
    let zoom = null;
    try { center = map.getCenter?.(); zoom = map.getZoom?.(); } catch (_) { /* restored only when available */ }

    const capture = async (mapRef, title, bounds, selectedRows) => {
      if (!bounds) throw new Error(`Kartengrenzen für ${mapRef} fehlen.`);
      map.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], {
        animate: false, padding: [24, 24], maxZoom: 19,
      });
      await wait(rootValue, 450);
      const exportPoints = selectedRows.map(row => pointById.get(row.displayId)).filter(Boolean);
      if (exportPoints.length !== selectedRows.length) {
        const missing = selectedRows.filter(row => !pointById.has(row.displayId)).map(row => row.displayId);
        throw new Error(`Kartenpunkte für folgende Unfall-IDs fehlen: ${missing.join(', ')}.`);
      }
      const captureCtx = evidenceContext(ctx, cohorts);
      const image = await UA.captureExportMapImage(captureCtx, {
        evidenceLabels: true,
        evidenceRows: selectedRows,
        exportPoints,
        heatmapExportOpacity: 0,
      });
      if (!clean(image).startsWith('data:image/png;base64,')) {
        throw new Error(`Kartenaufnahme ${mapRef} lieferte kein gültiges PNG.`);
      }
      return { mapRef, title, bounds, accidentIds: selectedRows.map(row => row.displayId), image };
    };

    try {
      const images = [await capture('E0', 'Übersicht – vollständiges Gebietskollektiv', cohorts.bounds, rows)];
      for (const partition of list(cohorts?.detailMapPartitions)) {
        const ids = new Set(list(partition.accidentIds));
        const selectedRows = rows.filter(row => ids.has(row.displayId));
        images.push(await capture(
          partition.mapRef,
          `Detail ${partition.mapRef} – ${selectedRows[0]?.displayId || ''} bis ${selectedRows[selectedRows.length - 1]?.displayId || ''}`,
          partition.bounds,
          selectedRows
        ));
      }
      return images;
    } finally {
      try {
        if (center && Number.isFinite(zoom)) map.setView(center, zoom, { animate: false });
      } catch (_) { /* preserve the export error */ }
    }
  }

  function pdfEvidenceTableRows(cohorts) {
    const header = [
      { text: 'ID', bold: true }, { text: 'Jahr', bold: true }, { text: 'Schwere', bold: true },
      { text: 'Beteiligte', bold: true }, { text: 'Zeit', bold: true }, { text: 'Zustand', bold: true },
      { text: 'Rolle', bold: true }, { text: 'Karte', bold: true },
    ];
    const rows = list(cohorts?.completeEvidenceCohort?.rows).map(row => [
      { text: row.displayId, link: row.mapDeepLink || undefined, bold: row.discoveryMatch },
      String(row.year ?? '—'), row.severityLabel, row.involvementLabel,
      row.hour == null ? '—' : `${String(row.hour).padStart(2, '0')}:00`,
      row.roadConditionLabel,
      row.discoveryMatch ? 'Suchmuster' : 'weitere Gebietsevidenz',
      row.mapRef || '—',
    ]);
    return [header, ...rows];
  }

  async function exportEvidencePdf(UA, rootValue, ctx, report, cohorts) {
    await UA.ensureExportLibraries?.();
    if (!rootValue?.pdfMake) throw new Error('pdfMake ist nicht verfügbar.');
    const maps = await captureEvidenceMaps(UA, rootValue, ctx, cohorts);
    const completeCount = cohorts.completeEvidenceCohort.count;
    const discoveryCount = cohorts.discoveryCohort.count;
    const content = [
      { text: 'ANLAGE – VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISLISTE', style: 'title' },
      { text: `Untersuchungsgebiet: ${report?.structured?.meta?.areaName || 'ausgewählte Grenzen'}`, margin: [0, 4, 0, 2] },
      { text: `Berichtszeitraum: ${cohorts.reportingPeriod ? `${cohorts.reportingPeriod.from}–${cohorts.reportingPeriod.to}` : 'aus veröffentlichtem Datenbestand'}` },
      { text: `Vollständiges Gebietskollektiv: ${completeCount} veröffentlichte Unfälle mit Personenschaden. Entdeckungsteilmenge unter aktiven Suchfiltern: ${discoveryCount}.`, margin: [0, 6, 0, 4] },
      { text: 'Die Suchfilter dienen der Mustererkennung und Priorisierung. Sie begrenzen weder den Antrag noch diese Beweisanlage. A### ist eine Dokumentkennung und keine amtliche Unfallnummer.', italics: true, margin: [0, 0, 0, 10] },
      { image: maps[0].image, fit: [515, 350], alignment: 'center' },
      { text: `Abbildung 1: ${maps[0].title}; dargestellt und nummeriert: ${completeCount} Unfälle.`, style: 'caption' },
    ];
    maps.slice(1).forEach((map, index) => {
      content.push(
        { text: map.title, style: 'heading', pageBreak: index % 2 === 0 ? 'before' : undefined },
        { image: map.image, fit: [515, 350], alignment: 'center' },
        { text: `Abbildung ${index + 2}: ${map.mapRef}; Unfall-IDs: ${map.accidentIds.join(', ')}.`, style: 'caption' },
      );
    });
    content.push(
      { text: 'Vollständige Unfallliste', style: 'heading', pageBreak: 'before' },
      {
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: [32, 28, 58, 92, 35, 55, 78, 30],
          body: pdfEvidenceTableRows(cohorts),
        },
        layout: 'lightHorizontalLines',
        fontSize: 7,
      },
      { text: 'Daten- und Beweisgrenzen', style: 'heading', margin: [0, 12, 0, 4] },
      { ul: [
        'Amtliche Straßenverkehrsunfallstatistik auf Grundlage polizeilicher Meldungen; veröffentlicht sind Unfälle mit Personenschaden.',
        'Reine Sachschäden, Beinaheereignisse und nicht gemeldete Unfälle sind nicht enthalten.',
        'Die veröffentlichte Lage darf nicht genauer interpretiert werden als die Quelldaten.',
        'Die vollständige Anlage bestätigt Ereignisse und veröffentlichte Attribute, nicht automatisch eine gemeinsame Ursache.',
      ] },
      { text: `Nummerierte interaktive Karte: ${cohorts.numberedMapUrl || 'nicht verfügbar'}`, link: cohorts.numberedMapUrl || undefined, fontSize: 8, margin: [0, 8, 0, 0] },
    );
    const definition = {
      pageSize: 'A4',
      pageOrientation: 'landscape',
      pageMargins: [34, 34, 34, 42],
      content,
      styles: {
        title: { fontSize: 17, bold: true, alignment: 'center' },
        heading: { fontSize: 12, bold: true, margin: [0, 10, 0, 6] },
        caption: { fontSize: 8, italics: true, alignment: 'center', margin: [0, 4, 0, 8] },
      },
      defaultStyle: { fontSize: 9 },
      footer(currentPage, pageCount) {
        return { text: `Unfallwerkbank-Beweisanlage · Seite ${currentPage} von ${pageCount}`, alignment: 'center', fontSize: 7, margin: [0, 10, 0, 0] };
      },
      info: {
        title: 'Vollständige nummerierte Unfallbeweisanlage',
        subject: `${completeCount} veröffentlichte Unfälle mit Personenschaden im Untersuchungsgebiet`,
      },
    };
    rootValue.pdfMake.createPdf(definition).download('unfallwerkbank_unfallbeweisanlage.pdf');
    return { definition, maps };
  }

  function pngBytes(rootValue, dataUrl) {
    const base64 = clean(dataUrl).replace(/^data:image\/png;base64,/, '');
    const binary = rootValue.atob(base64);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function wordImageRun(UA, rootValue, ImageRun, map, sequence) {
    let transformation = { width: 620, height: 360 };
    try {
      const dimensions = UA.readPngDimensions(map.image);
      transformation = UA.fitWithAspectRatio(dimensions, { width: 620, height: 360 });
    } catch (_) { /* use conservative fallback */ }
    return new ImageRun({
      type: 'png',
      data: pngBytes(rootValue, map.image),
      transformation,
      altText: {
        name: `Unfallkarte_${sequence}`,
        title: map.title,
        description: `Nummerierte Karte ${map.mapRef} mit den Unfall-IDs ${map.accidentIds.join(', ')}`,
        id: String(5000 + sequence),
      },
    });
  }

  async function exportEvidenceWord(UA, rootValue, ctx, report, cohorts) {
    await UA.ensureExportLibraries?.();
    if (!rootValue?.docx || !rootValue?.saveAs) throw new Error('Word-Exportbibliotheken sind nicht verfügbar.');
    const maps = await captureEvidenceMaps(UA, rootValue, ctx, cohorts);
    const {
      Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun,
      Table, TableRow, TableCell, WidthType, BorderStyle, PageOrientation,
    } = rootValue.docx;
    const borders = {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'B0B0B0' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'B0B0B0' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'B0B0B0' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'B0B0B0' },
    };
    const cell = (text, bold, shading) => new TableCell({
      borders,
      shading: shading ? { fill: shading } : undefined,
      children: [new Paragraph({ children: [new TextRun({ text: String(text ?? '—'), bold: !!bold, size: 14 })] })],
    });
    const rows = list(cohorts.completeEvidenceCohort.rows);
    const tableRows = [
      new TableRow({
        tableHeader: true, cantSplit: true,
        children: ['ID', 'Jahr', 'Schwere', 'Beteiligte', 'Zeit', 'Zustand', 'Rolle', 'Karte'].map(value => cell(value, true, 'E6E6E6')),
      }),
      ...rows.map(row => new TableRow({
        cantSplit: true,
        children: [
          row.displayId, row.year ?? '—', row.severityLabel, row.involvementLabel,
          row.hour == null ? '—' : `${String(row.hour).padStart(2, '0')}:00`, row.roadConditionLabel,
          row.discoveryMatch ? 'Suchmuster' : 'weitere Gebietsevidenz', row.mapRef || '—',
        ].map((value, index) => cell(value, index === 0 && row.discoveryMatch, row.discoveryMatch ? 'FFF2A8' : undefined)),
      })),
    ];
    const children = [
      new Paragraph({ text: 'ANLAGE – VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISLISTE', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
      new Paragraph({ text: `Untersuchungsgebiet: ${report?.structured?.meta?.areaName || 'ausgewählte Grenzen'}` }),
      new Paragraph({ text: `Vollständiges Gebietskollektiv: ${rows.length} veröffentlichte Unfälle mit Personenschaden. Entdeckungsteilmenge: ${cohorts.discoveryCohort.count}.` }),
      new Paragraph({ children: [new TextRun({ text: 'Die Suchfilter dienen der Mustererkennung und Priorisierung. Sie begrenzen weder den Antrag noch diese Beweisanlage. A### ist eine Dokumentkennung und keine amtliche Unfallnummer.', italics: true })] }),
    ];
    maps.forEach((map, index) => {
      if (index > 0) children.push(new Paragraph({ pageBreakBefore: true, text: map.title, heading: HeadingLevel.HEADING_2 }));
      children.push(new Paragraph({ children: [wordImageRun(UA, rootValue, ImageRun, map, index + 1)], alignment: AlignmentType.CENTER, keepNext: true }));
      children.push(new Paragraph({ children: [new TextRun({ text: `Abbildung ${index + 1}: ${map.title}; Unfall-IDs: ${map.accidentIds.join(', ')}.`, italics: true, size: 16 })], alignment: AlignmentType.CENTER }));
    });
    children.push(
      new Paragraph({ text: 'Vollständige Unfallliste', heading: HeadingLevel.HEADING_2, pageBreakBefore: true }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }),
      new Paragraph({ text: 'Daten- und Beweisgrenzen', heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ text: 'Amtliche Straßenverkehrsunfallstatistik auf Grundlage polizeilicher Meldungen; veröffentlicht sind Unfälle mit Personenschaden. Reine Sachschäden, Beinaheereignisse und nicht gemeldete Unfälle sind nicht enthalten. Die veröffentlichte Lage darf nicht genauer interpretiert werden als die Quelldaten.' }),
      new Paragraph({ text: `Nummerierte interaktive Karte: ${cohorts.numberedMapUrl || 'nicht verfügbar'}` }),
    );
    const documentValue = new Document({
      sections: [{
        properties: {
          page: { size: { orientation: PageOrientation?.LANDSCAPE || 'landscape' }, margin: { top: 720, right: 540, bottom: 720, left: 540 } },
        },
        children,
      }],
      creator: 'Unfallwerkbank',
      title: 'Vollständige nummerierte Unfallbeweisanlage',
    });
    const blob = await Packer.toBlob(documentValue);
    rootValue.saveAs(blob, 'unfallwerkbank_unfallbeweisanlage.docx');
    return { document: documentValue, maps };
  }

  function ensurePanel(UA, rootValue) {
    const documentValue = rootValue?.document;
    if (!documentValue || documentValue.getElementById('evidenceCohortPanel')) return !!documentValue;
    const anchor = documentValue.getElementById('exportGroupAntrag')
      || documentValue.getElementById('aiProposalSection')
      || documentValue.getElementById('exportHtml');
    if (!anchor?.parentNode) return false;
    const panel = documentValue.createElement('fieldset');
    panel.id = 'evidenceCohortPanel';
    panel.style.cssText = 'margin-top:10px;padding:10px 12px;border:1px solid #8a6d1d;border-radius:12px;background:#fffaf0;';
    panel.innerHTML = '<legend style="font-weight:800;color:#6a4b00;">📎 Vollständige Unfallbeweisanlage</legend>'
      + '<p id="evidenceCohortSummary" style="margin:0 0 8px;font-size:12px;line-height:1.45;">Die Suchfilter finden priorisierungsrelevante Muster; die Anlage umfasst alle Unfälle im Gebiet.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + '<button type="button" id="btnEvidenceNumberedMap">Nummerierte Karte</button>'
      + '<button type="button" id="btnEvidencePdf">Beweisanlage PDF</button>'
      + '<button type="button" id="btnEvidenceWord">Beweisanlage Word</button>'
      + '<button type="button" id="btnEvidenceCsv">Beweisanlage CSV</button>'
      + '<button type="button" id="btnEvidenceGeoJson">Beweisanlage GeoJSON</button>'
      + '</div><div id="evidenceCohortStatus" role="status" style="margin-top:7px;font-size:12px;"></div>';
    anchor.insertAdjacentElement('afterend', panel);
    const status = panel.querySelector('#evidenceCohortStatus');
    const setStatus = message => { status.textContent = message; };
    const withData = async task => {
      const data = await currentReport(UA);
      const summary = panel.querySelector('#evidenceCohortSummary');
      if (summary) summary.textContent = `${data.cohorts?.discoveryCohort?.count || 0} Unfälle durch Suchfilter hervorgehoben; ${data.cohorts?.completeEvidenceCohort?.count || 0} Unfälle vollständig in der Antrags- und Beweisgrundlage.`;
      return task(data);
    };
    panel.querySelector('#btnEvidenceNumberedMap').addEventListener('click', () => withData(({ cohorts }) => {
      if (!cohorts?.numberedMapUrl) throw new Error('Nummerierte Karten-URL fehlt.');
      rootValue.open(cohorts.numberedMapUrl, '_blank', 'noopener');
      setStatus('Nummerierte Karte geöffnet.');
    }).catch(error => setStatus(error.message)));
    panel.querySelector('#btnEvidenceCsv').addEventListener('click', () => withData(({ cohorts }) => {
      download(rootValue, 'unfallwerkbank_unfallbeweisanlage.csv', 'text/csv;charset=utf-8', appendixCsv(cohorts));
      setStatus('Vollständige CSV-Beweisanlage erzeugt.');
    }).catch(error => setStatus(error.message)));
    panel.querySelector('#btnEvidenceGeoJson').addEventListener('click', () => withData(({ cohorts }) => {
      download(rootValue, 'unfallwerkbank_unfallbeweisanlage.geojson', 'application/geo+json;charset=utf-8', `${JSON.stringify(appendixGeoJson(cohorts), null, 2)}\n`);
      setStatus('Vollständige GeoJSON-Beweisanlage erzeugt.');
    }).catch(error => setStatus(error.message)));
    panel.querySelector('#btnEvidencePdf').addEventListener('click', () => withData(async ({ ctx, report, cohorts }) => {
      await exportEvidencePdf(UA, rootValue, ctx, report, cohorts);
      setStatus('Vollständige nummerierte PDF-Beweisanlage erzeugt.');
    }).catch(error => setStatus(error.message)));
    panel.querySelector('#btnEvidenceWord').addEventListener('click', () => withData(async ({ ctx, report, cohorts }) => {
      await exportEvidenceWord(UA, rootValue, ctx, report, cohorts);
      setStatus('Vollständige nummerierte Word-Beweisanlage erzeugt.');
    }).catch(error => setStatus(error.message)));
    return true;
  }

  function rebindAiButtons(UA, rootValue) {
    const documentValue = rootValue?.document;
    const api = UA?.aiInvestigation;
    if (!documentValue || !api?.__uaEvidenceCohortWrapped || !UA?.aiVisualResearch?.generateResearchHandoff) return false;
    const validateButton = documentValue.getElementById('btnAiValidateInvestigation');
    const applicationButton = documentValue.getElementById('btnAiApplicationPromptCopy');
    const input = documentValue.getElementById('aiInvestigationResultInput');
    const output = documentValue.getElementById('aiInvestigationValidationStatus');
    if (!validateButton || !applicationButton || !input || !output || validateButton.dataset[AI_GATE_MARK] === '1') return false;
    let lastHandoff = null;
    let lastResult = null;
    let lastValidation = null;
    const freshValidate = validateButton.cloneNode(true);
    const freshApplication = applicationButton.cloneNode(true);
    freshValidate.dataset[AI_GATE_MARK] = '1';
    freshApplication.dataset[AI_GATE_MARK] = '1';
    validateButton.replaceWith(freshValidate);
    applicationButton.replaceWith(freshApplication);
    freshApplication.disabled = true;
    freshValidate.addEventListener('click', async () => {
      freshValidate.disabled = true;
      try {
        lastHandoff = await UA.aiVisualResearch.generateResearchHandoff(UA, UA.getRuntimeContext?.() || {});
        lastResult = api.parseInvestigationResult(input.value);
        lastValidation = api.validateInvestigationResult(lastResult, lastHandoff.facts);
        freshApplication.disabled = !lastValidation.readyForApplication;
        output.textContent = [
          `${lastValidation.passed ? 'VALIDIERT' : 'NICHT VALIDIERT'} · Score ${lastValidation.score}/100`,
          `Einreichungsstatus: ${lastValidation.filingReadinessStatus}`,
          ...list(lastValidation.errors).map(error => `FEHLER: ${error.message}`),
          ...list(lastValidation.warnings).map(warning => `HINWEIS: ${warning.message}`),
        ].join('\n');
      } catch (error) {
        freshApplication.disabled = true;
        output.textContent = `FEHLER: ${error?.message || error}`;
      } finally { freshValidate.disabled = false; }
    });
    freshApplication.addEventListener('click', async () => {
      try {
        if (!lastHandoff || !lastResult || !lastValidation) throw new Error('Zuerst Untersuchungsergebnis validieren.');
        await writeClipboard(rootValue, api.buildApplicationPrompt(lastHandoff, lastResult, lastValidation));
        output.textContent += '\nValidierter Antragsprompt mit vollständiger Unfallabdeckung kopiert.';
      } catch (error) { output.textContent += `\nFEHLER: ${error?.message || error}`; }
    });
    return true;
  }

  function rebindStageOneButtons(UA, rootValue) {
    const documentValue = rootValue?.document;
    const api = UA?.aiInvestigation;
    if (!documentValue || !api?.__uaEvidenceCohortWrapped || !UA?.aiVisualResearch?.generateResearchHandoff) return false;
    const button = documentValue.getElementById('btnAiResearchLinkCopy');
    if (!button || button.dataset[AI_GATE_MARK] === '1') return false;
    const clone = button.cloneNode(true);
    clone.dataset[AI_GATE_MARK] = '1';
    clone.textContent = '1. KI-Untersuchungsauftrag inkl. vollständiger Unfallliste kopieren';
    button.replaceWith(clone);
    clone.addEventListener('click', async () => {
      const old = clone.textContent;
      clone.disabled = true;
      try {
        const handoff = await UA.aiVisualResearch.generateResearchHandoff(UA, UA.getRuntimeContext?.() || {});
        await writeClipboard(rootValue, api.buildInvestigationPrompt(handoff));
        const status = documentValue.getElementById('aiPromptStatus');
        if (status) status.textContent = 'Untersuchungsauftrag mit vollständigem Gebietskollektiv und A###-Referenzen kopiert.';
      } finally { clone.disabled = false; clone.textContent = old; }
    });
    return true;
  }

  function annotateMapImage(rootValue, ctx, dataUrl, options) {
    const rows = list(options?.evidenceRows || ctx?.__uaEvidenceRows || ctx?.__uaEvidenceCohorts?.completeEvidenceCohort?.rows);
    if (!rows.length || !rootValue?.document || typeof rootValue.Image !== 'function') return Promise.resolve(dataUrl);
    return new Promise(resolve => {
      const image = new rootValue.Image();
      image.onload = () => {
        try {
          const canvas = rootValue.document.createElement('canvas');
          canvas.width = image.naturalWidth || image.width;
          canvas.height = image.naturalHeight || image.height;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          const mapSize = ctx?.map?.getSize?.() || { x: canvas.width, y: canvas.height };
          const sx = canvas.width / Math.max(1, Number(mapSize.x) || canvas.width);
          const sy = canvas.height / Math.max(1, Number(mapSize.y) || canvas.height);
          context.font = 'bold 11px sans-serif';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          for (const row of rows) {
            if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
            let point;
            try { point = ctx.map.latLngToContainerPoint([row.lat, row.lon]); } catch (_) { continue; }
            const x = point.x * sx;
            const y = point.y * sy - 11;
            const width = Math.max(28, context.measureText(row.displayId).width + 8);
            context.fillStyle = row.discoveryMatch ? '#fff2a8' : '#ffffff';
            context.strokeStyle = '#111111';
            context.lineWidth = 2;
            context.fillRect(x - width / 2, y - 8, width, 16);
            context.strokeRect(x - width / 2, y - 8, width, 16);
            context.fillStyle = '#111111';
            context.fillText(row.displayId, x, y);
          }
          resolve(canvas.toDataURL('image/png'));
        } catch (_) { resolve(dataUrl); }
      };
      image.onerror = () => resolve(dataUrl);
      image.src = dataUrl;
    });
  }

  function installCaptureHook(UA, rootValue) {
    const original = UA?.captureMapImage;
    if (typeof original !== 'function' || original._uaEvidenceLabelsWrapped) return typeof original === 'function';
    const wrapped = async function numberedEvidenceCapture(ctx, options) {
      const dataUrl = await original.apply(this, arguments);
      const enabled = options?.evidenceLabels === true || ctx?.__uaEvidenceLabelsActive === true;
      return enabled ? annotateMapImage(rootValue, ctx, dataUrl, options || {}) : dataUrl;
    };
    wrapped._uaEvidenceLabelsWrapped = true;
    wrapped._uaOriginal = original;
    UA.captureMapImage = wrapped;
    return true;
  }

  function installLiveLabels(UA, rootValue) {
    if (!rootValue?.document || !rootValue?.location || !rootValue?.L) return false;
    const params = new URLSearchParams(rootValue.location.search || '');
    if (params.get('evidenceLabels') !== '1') return false;
    const ctx = rootContext(UA?.getRuntimeContext?.() || {});
    if (!ctx?.map || !ctx?.allPts?.length) return false;
    const reportPromise = Promise.resolve(UA.computeExportReport(ctx));
    reportPromise.then(report => {
      const cohorts = report?.structured?.evidenceCohorts;
      const rows = list(cohorts?.completeEvidenceCohort?.rows);
      if (!rows.length) return;
      try { ctx.__uaEvidenceLabelLayer?.remove?.(); } catch (_) { /* noop */ }
      const layer = rootValue.L.layerGroup();
      const selected = params.get('evidenceAccident');
      for (const row of rows) {
        const isSelected = row.displayId === selected;
        const marker = rootValue.L.marker([row.lat, row.lon], {
          interactive: true,
          icon: rootValue.L.divIcon({
            className: 'ua-evidence-id-marker',
            html: `<span style="display:inline-block;padding:${isSelected ? '3px 6px' : '2px 4px'};border:2px solid #111;background:${row.discoveryMatch ? '#fff2a8' : '#fff'};border-radius:4px;font:bold ${isSelected ? '14px' : '11px'} sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.45);">${escHtml(row.displayId)}</span>`,
            iconSize: null,
            iconAnchor: [14, 22],
          }),
        });
        marker.bindPopup(`<strong>${escHtml(row.displayId)}</strong><br>${escHtml(row.severityLabel)}<br>${escHtml(row.involvementLabel)}<br>${row.discoveryMatch ? 'durch Suchfilter hervorgehoben' : 'weitere Gebietsevidenz'}`);
        marker.addTo(layer);
      }
      layer.addTo(ctx.map);
      ctx.__uaEvidenceLabelLayer = layer;
    }).catch(() => {});
    return true;
  }

  function install(UA, rootValue) {
    if (!UA || !rootValue) return false;
    const bind = () => {
      wrapAccidentViews(UA);
      installReportHook(UA, rootValue);
      installCaptureHook(UA, rootValue);
      wrapAiApi(UA);
      ensurePanel(UA, rootValue);
      rebindStageOneButtons(UA, rootValue);
      rebindAiButtons(UA, rootValue);
      installLiveLabels(UA, rootValue);
    };
    bind();
    const timer = rootValue.setInterval?.(() => {
      bind();
      if (UA.computeExportReport && UA.captureMapImage && UA.aiInvestigation?.__uaEvidenceCohortWrapped) {
        rootValue.clearInterval?.(timer);
      }
    }, 100);
    if (rootValue.document && typeof rootValue.MutationObserver === 'function') {
      const observer = new rootValue.MutationObserver(bind);
      observer.observe(rootValue.document.documentElement, { childList: true, subtree: true });
    }
    return true;
  }

  return Object.freeze({
    SCHEMA_VERSION,
    COVERAGE_SCHEMA,
    CONTRACT_SCHEMA,
    MODULE_VERSION,
    buildCohorts,
    buildEvidenceStructured,
    buildAppendix,
    partitionRows,
    appendixCsv,
    appendixGeoJson,
    validateCoverage,
    evidenceCoverageSkeleton,
    evidenceContract,
    decorateReport,
    rootContext,
    exportBounds,
    pointInBounds,
    fingerprintForPoint,
    install,
    _internal: Object.freeze({
      stableHash: fnv1a,
      rowFromPoint,
      severitySummary,
      yearSummary,
      crossSummary,
      appendixHtml,
      appendixText,
      attachIdsToExistingDetails,
      wrapAiApi,
      annotateMapImage,
      evidenceContext,
      evidenceReport,
      captureEvidenceMaps,
      exportEvidencePdf,
      exportEvidenceWord,
    }),
  });
});
