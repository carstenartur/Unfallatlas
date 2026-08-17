/**
 * UA.PatternPlugins — deterministic accident-pattern detection before AI.
 *
 * Reuses UA.AnalysisPipeline. Detector plugins consume auditable inputs and
 * emit normalised findings. A final aggregator produces
 * `unfallwerkbank.patternDetection.v1`. AI may evaluate and combine these
 * findings afterwards, but must not silently replace the deterministic stage.
 */
(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});

  const PATTERN_DETECTION_SCHEMA = 'unfallwerkbank.patternDetection.v1';
  const PATTERN_FINDING_SCHEMA = 'unfallwerkbank.patternFinding.v1';
  const DETECTOR_VERSION = '1.0.0';

  const DATA_KEYS = Object.freeze({
    STRUCTURED: 'structuredAnalysis',
    ACCIDENTS: 'accidents',
  });

  const ARTIFACT_KEYS = Object.freeze({
    DATA_QUALITY: 'patternFindings.dataQuality',
    SEVERITY: 'patternFindings.severity',
    INVOLVEMENT: 'patternFindings.involvement',
    TEMPORAL: 'patternFindings.temporal',
    SPATIAL: 'patternFindings.spatial',
    CONTEXT: 'patternFindings.context',
    AGGREGATE: 'patternDetection',
  });

  const DETECTOR_IDS = Object.freeze({
    DATA_QUALITY: 'pattern-data-quality',
    SEVERITY: 'pattern-severity-burden',
    INVOLVEMENT: 'pattern-involvement-composition',
    TEMPORAL: 'pattern-temporal-concentration',
    SPATIAL: 'pattern-spatial-morphology',
    CONTEXT: 'pattern-context-combination',
    AGGREGATE: 'pattern-aggregate',
  });

  const CAUSAL_STATUS = Object.freeze({
    DESCRIPTIVE: 'descriptive-association',
    SPATIAL: 'spatial-association',
    CANDIDATE: 'mechanism-candidate',
    PLAUSIBLE: 'mechanism-plausible',
    CONFIRMED: 'causally-confirmed',
    NOT_ASSESSABLE: 'not-assessable',
  });

  const MASK_INFO = Object.freeze({
    1:  { key: 'bike-only', label: 'Rad-only-/Fahrradalleinunfall-Konstellation', tags: ['bike_alone'] },
    2:  { key: 'ped-only', label: 'Fußverkehr ohne weitere kodierte Beteiligungsart', tags: ['ped_alone'] },
    3:  { key: 'bike-ped', label: 'Rad-/Fußverkehrskonflikt', tags: ['bike_ped', 'crossing'] },
    4:  { key: 'car-only', label: 'Pkw-only-Konstellation', tags: ['car_car'] },
    5:  { key: 'bike-car', label: 'Rad-/Pkw-Konflikt', tags: ['bike_car', 'junction'] },
    6:  { key: 'ped-car', label: 'Fuß-/Pkw-Konflikt', tags: ['ped_car', 'crossing'] },
    8:  { key: 'motorcycle-only', label: 'Krad-only-Konstellation', tags: ['motorcycle'] },
    9:  { key: 'bike-motorcycle', label: 'Rad-/Krad-Konflikt', tags: ['motorcycle', 'bike_car'] },
    16: { key: 'hgv-only', label: 'Lkw-/Schwerverkehr-only-Konstellation', tags: ['hgv'] },
    17: { key: 'bike-hgv', label: 'Rad-/Lkw-Konflikt', tags: ['bike_truck', 'hgv', 'junction'] },
    18: { key: 'ped-hgv', label: 'Fuß-/Lkw-Konflikt', tags: ['ped_car', 'hgv', 'crossing'] },
    32: { key: 'other-only', label: 'Sonstige-/ÖPNV-only-Konstellation', tags: ['transit'] },
    33: { key: 'bike-transit', label: 'Rad-/ÖPNV-Konflikt', tags: ['bike_car', 'transit'] },
    34: { key: 'ped-transit', label: 'Fuß-/ÖPNV-Konflikt', tags: ['ped_car', 'transit'] },
  });

  const FAMILY_ORDER = Object.freeze([
    'data-quality', 'severity', 'involvement', 'spatial', 'temporal', 'environment', 'infrastructure', 'context',
  ]);

  function clean(value, max = 500) {
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min = 0, max = 1) {
    const number = finite(value);
    return number === null ? min : Math.max(min, Math.min(max, number));
  }

  function round(value, digits = 4) {
    const number = finite(value);
    if (number === null) return null;
    const factor = 10 ** digits;
    return Math.round(number * factor) / factor;
  }

  function array(value) { return Array.isArray(value) ? value : []; }

  function uniqueStrings(values, max = 30) {
    return [...new Set(array(values).map(value => clean(value, 300)).filter(Boolean))].slice(0, max);
  }

  function confidenceLabel(score) {
    const value = clamp(score);
    if (value >= 0.8) return 'high';
    if (value >= 0.55) return 'medium';
    return 'low';
  }

  function evidence(field, value, extra) {
    return Object.assign({ field: clean(field, 180), value }, extra || {});
  }

  function createFinding(definition) {
    const def = definition || {};
    if (!def.id) throw new Error('Pattern finding id is required.');
    if (!def.detectorId) throw new Error(`Pattern finding ${def.id}: detectorId is required.`);
    if (!def.family) throw new Error(`Pattern finding ${def.id}: family is required.`);
    const score = clamp(def.confidence == null ? 0.5 : def.confidence);
    return {
      schemaVersion: PATTERN_FINDING_SCHEMA,
      id: clean(def.id, 160),
      patternId: clean(def.patternId || def.id, 160),
      detector: { id: clean(def.detectorId, 160), version: DETECTOR_VERSION },
      family: clean(def.family, 80),
      label: clean(def.label || def.id, 300),
      classification: clean(def.classification || 'secondary', 40),
      status: clean(def.status || 'observed', 50),
      causalStatus: clean(def.causalStatus || CAUSAL_STATUS.DESCRIPTIVE, 70),
      confidence: round(score, 3),
      confidenceLabel: confidenceLabel(score),
      scope: def.scope && typeof def.scope === 'object'
        ? JSON.parse(JSON.stringify(def.scope)) : { selection: 'active' },
      metrics: def.metrics && typeof def.metrics === 'object'
        ? JSON.parse(JSON.stringify(def.metrics)) : {},
      evidence: array(def.evidence).slice(0, 20).map(item => (
        item && typeof item === 'object' ? JSON.parse(JSON.stringify(item)) : evidence('note', clean(item, 500))
      )),
      rationale: clean(def.rationale, 1200),
      tags: uniqueStrings(def.tags),
      limitations: uniqueStrings(def.limitations),
      requiredVerification: uniqueStrings(def.requiredVerification),
    };
  }

  function propertyValue(props, ...names) {
    if (!props || typeof props !== 'object') return undefined;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
      const lower = String(name).toLowerCase();
      const key = Object.keys(props).find(candidate => candidate.toLowerCase() === lower);
      if (key) return props[key];
    }
    return undefined;
  }

  function truthyFlag(value) {
    return value === true || value === 1 || String(value).trim() === '1';
  }

  function involvementMask(props) {
    return (truthyFlag(propertyValue(props, 'istrad', 'IstRad')) ? 1 : 0)
      | (truthyFlag(propertyValue(props, 'istfuss', 'IstFuss')) ? 2 : 0)
      | (truthyFlag(propertyValue(props, 'istpkw', 'IstPKW')) ? 4 : 0)
      | (truthyFlag(propertyValue(props, 'istkrad', 'IstKrad')) ? 8 : 0)
      | (truthyFlag(propertyValue(props, 'istgkfz', 'IstGkfz')) ? 16 : 0)
      | (truthyFlag(propertyValue(props, 'istsonstig', 'IstSonstig')) ? 32 : 0);
  }

  function normaliseAccidents(input) {
    const raw = Array.isArray(input) ? input : array(input?.features);
    const out = [];
    for (const item of raw) {
      const coords = item?.geometry?.type === 'Point' ? item.geometry.coordinates : null;
      const lat = finite(item?.lat ?? (coords && coords[1]));
      const lon = finite(item?.lon ?? item?.lng ?? (coords && coords[0]));
      if (lat === null || lon === null) continue;
      const props = item?.props || item?.properties || item || {};
      out.push({
        lat,
        lon,
        props,
        mask: involvementMask(props),
        severity: finite(propertyValue(props, 'ukategorie', 'UKATEGORIE')),
        year: finite(propertyValue(props, 'year', 'ujahr', 'UJAHR')),
        hour: finite(propertyValue(props, 'ustunde', 'USTUNDE')),
        weekday: finite(propertyValue(props, 'uwochentag', 'UWOCHENTAG')),
        roadCondition: finite(propertyValue(props, 'strzustand', 'STRZUSTAND')),
      });
    }
    return out;
  }

  function maskInfo(mask) {
    if (MASK_INFO[Number(mask)]) return MASK_INFO[Number(mask)];
    const bits = [[1, 'Rad'], [2, 'Fuß'], [4, 'Pkw'], [8, 'Krad'], [16, 'Lkw'], [32, 'Sonstige/ÖPNV']]
      .filter(([bit]) => Number(mask) & bit).map(([, label]) => label);
    return { key: `mask-${Number(mask) || 0}`, label: bits.length ? `${bits.join('/')}-Konstellation` : `Beteiligungsmaske ${Number(mask) || 0}`, tags: [] };
  }

  function dataQualityFindings(structured, accidents) {
    const findings = [];
    const total = finite(structured?.severity?.total);
    const bySev = structured?.severity?.bySev || {};
    const severitySum = ['1', '2', '3'].reduce((sum, key) => sum + (finite(bySev[key]) || 0), 0);
    if (total !== null && total !== severitySum) {
      findings.push(createFinding({
        id: 'severity-total-mismatch', detectorId: DETECTOR_IDS.DATA_QUALITY, family: 'data-quality',
        label: 'Gesamtzahl und Schweregradsumme widersprechen sich', classification: 'data-quality',
        status: 'blocking-data-issue', causalStatus: CAUSAL_STATUS.NOT_ASSESSABLE, confidence: 1,
        metrics: { total, severitySum, difference: total - severitySum },
        evidence: [evidence('severity.total', total), evidence('sum(severity.bySev[1..3])', severitySum)],
        rationale: 'Eine widersprüchliche Grundgesamtheit kann nachgelagerte Musteranteile und Antragstexte verfälschen.',
        requiredVerification: ['Export-/Filterpipeline und Schweregradzuordnung prüfen.'],
      }));
    }

    const yearRows = array(structured?.yearTable);
    const yearSum = yearRows.reduce((sum, row) => sum + (finite(row?.total) || 0), 0);
    if (total !== null && yearRows.length && yearSum !== total) {
      findings.push(createFinding({
        id: 'year-total-mismatch', detectorId: DETECTOR_IDS.DATA_QUALITY, family: 'data-quality',
        label: 'Gesamtzahl und Jahressumme widersprechen sich', classification: 'data-quality',
        status: 'blocking-data-issue', causalStatus: CAUSAL_STATUS.NOT_ASSESSABLE, confidence: 1,
        metrics: { total, yearSum, difference: total - yearSum },
        evidence: [evidence('severity.total', total), evidence('sum(yearTable.total)', yearSum)],
        rationale: 'Der Mehrjahresverlauf ist nicht konsistent mit der ausgewiesenen Gesamtzahl.',
        requiredVerification: ['Nulljahre, Datenjahre und Filterübernahme in die Trendtabelle prüfen.'],
      }));
    }

    const details = structured?.accidentDetails;
    if (details?.truncated === true) {
      findings.push(createFinding({
        id: 'accident-details-truncated', detectorId: DETECTOR_IDS.DATA_QUALITY, family: 'data-quality',
        label: 'Einzelunfalltabelle ist gekürzt', classification: 'data-quality', status: 'warning',
        causalStatus: CAUSAL_STATUS.NOT_ASSESSABLE, confidence: 1,
        evidence: [evidence('accidentDetails.truncated', true), evidence('accidentDetails.total', finite(details.total))],
        rationale: 'Eine Musterprüfung darf nicht nur auf gekürzten Tabellenzeilen beruhen.',
        limitations: ['Räumliche Detektoren verwenden deshalb nach Möglichkeit die ungekappten Auswahlpunkte.'],
      }));
    }

    if (Array.isArray(accidents) && total !== null && accidents.length !== total) {
      findings.push(createFinding({
        id: 'raw-selection-count-mismatch', detectorId: DETECTOR_IDS.DATA_QUALITY, family: 'data-quality',
        label: 'Rohpunkte und strukturierte Gesamtzahl weichen ab', classification: 'data-quality', status: 'warning',
        causalStatus: CAUSAL_STATUS.NOT_ASSESSABLE, confidence: 0.9,
        metrics: { structuredTotal: total, rawPointCount: accidents.length },
        evidence: [evidence('severity.total', total), evidence('selectedAccidents.length', accidents.length)],
        rationale: 'Räumliche und aggregierte Detektoren arbeiten möglicherweise auf unterschiedlichen Teilmengen.',
        requiredVerification: ['Auswahlgrenze, Viewport-Puffer, Punktkappung und Beteiligungsfilter abgleichen.'],
      }));
    }
    return findings;
  }

  function involvementFindings(structured) {
    const focus = new Map();
    for (const row of array(structured?.deviations?.focus)) {
      const mask = finite(row?.mask);
      if (mask !== null) focus.set(mask, row);
    }
    const local = new Map();
    for (const row of array(structured?.crossTable?.rows)) {
      const mask = finite(row?.mask);
      if (mask !== null) local.set(mask, row);
    }

    const masks = new Set(focus.keys());
    for (const [mask, row] of local.entries()) {
      if ((finite(row?.total) || 0) >= (mask === 1 ? 2 : 3)) masks.add(mask);
    }

    const findings = [];
    for (const mask of masks) {
      const comparison = focus.get(mask) || null;
      const row = local.get(mask) || null;
      const localCount = finite(comparison?.locCnt ?? comparison?.localCount ?? row?.total) || 0;
      if (!localCount) continue;
      const significant = comparison?.isSignificant === true;
      const info = maskInfo(mask);
      const limitations = ['Beteiligungsmuster beschreibt die Zusammensetzung dokumentierter Unfälle, nicht die absolute Unfallrate je Verkehrsleistung.'];
      if (comparison && !significant) limitations.push('Die lokale Abweichung ist explorativ und statistisch nicht als Überrepräsentation abgesichert.');
      if (mask === 1) limitations.push('Die Rad-only-Maske belegt nicht zwingend genau eine einzelne radfahrende Person und keine konkrete Sturzursache.');
      findings.push(createFinding({
        id: `${info.key}-involvement-pattern`, detectorId: DETECTOR_IDS.INVOLVEMENT, family: 'involvement',
        label: info.label, classification: significant ? 'primary' : 'secondary',
        status: comparison ? 'observed' : 'frequency-observed', causalStatus: CAUSAL_STATUS.DESCRIPTIVE,
        confidence: significant ? 0.85 : comparison ? 0.58 : 0.45,
        scope: { selection: 'active', accidentSubset: { involvementMask: mask, key: info.key } },
        metrics: {
          localCount,
          baselineCount: finite(comparison?.baseCnt ?? comparison?.baselineCount),
          localShare: round(comparison?.locR ?? comparison?.localShare),
          baselineShare: round(comparison?.baseR ?? comparison?.baselineShare),
          factor: round(comparison?.factor), ciLow: round(comparison?.ciLow), ciHigh: round(comparison?.ciHigh),
          isSignificant: significant,
        },
        evidence: [
          evidence(`crossTable.rows[mask=${mask}].total`, localCount),
          ...(comparison ? [evidence(`deviations.focus[mask=${mask}]`, {
            factor: round(comparison.factor), ciLow: round(comparison.ciLow), ciHigh: round(comparison.ciHigh), isSignificant: significant,
          })] : []),
        ],
        rationale: comparison
          ? `${info.label} ist lokal ${significant ? 'statistisch abgesichert' : 'explorativ'} auffällig.`
          : `${info.label} gehört lokal zu den häufigeren dokumentierten Konstellationen.`,
        tags: info.tags, limitations,
        requiredVerification: mask === 1
          ? ['Einzelfallattribute und – soweit verfügbar – Unfallart/Unfalltyp prüfen.'] : [],
      }));
    }
    return findings;
  }

  function severityFindings(structured) {
    const total = finite(structured?.severity?.total) || 0;
    const bySev = structured?.severity?.bySev || {};
    const fatal = finite(bySev['1']) || 0;
    const serious = finite(bySev['2']) || 0;
    const ksi = fatal + serious;
    const share = total ? ksi / total : 0;
    const findings = [];
    if (fatal > 0) {
      findings.push(createFinding({
        id: 'fatal-accident-burden', detectorId: DETECTOR_IDS.SEVERITY, family: 'severity',
        label: 'Unfälle mit Getöteten im Auswahlbereich', classification: 'primary', status: 'observed',
        causalStatus: CAUSAL_STATUS.DESCRIPTIVE, confidence: 1,
        metrics: { total, fatal, serious, ksi, ksiShare: round(share) },
        evidence: [evidence('severity.bySev.1', fatal)],
        rationale: 'Mindestens ein amtlich dokumentierter Unfall mit tödlichem Ausgang erfordert eine einzelfallbezogene Vertiefung.',
        tags: ['fatal', 'ksi'], requiredVerification: ['Unfallkommissions- und Polizeiinformationen zum Einzelfall prüfen.'],
      }));
    }
    if (ksi > 0 && (share >= 0.25 || total < 10)) {
      findings.push(createFinding({
        id: 'high-ksi-burden', detectorId: DETECTOR_IDS.SEVERITY, family: 'severity',
        label: 'Hoher Anteil schwerer Unfallfolgen', classification: 'primary', status: 'observed',
        causalStatus: CAUSAL_STATUS.DESCRIPTIVE, confidence: total >= 10 ? 0.85 : 0.68,
        metrics: { total, fatal, serious, ksi, ksiShare: round(share) },
        evidence: [evidence('severity.total', total), evidence('severity.fatal+serious', ksi), evidence('ksiShare', round(share))],
        rationale: 'Die Schwere der Folgen ist unabhängig von der noch offenen Ursachenfrage priorisierungsrelevant.',
        tags: ['ksi'],
        limitations: total < 10 ? ['Kleine Stichprobe: Interpretation und Maßnahmenpassung nicht mit hoher Konfidenz bewerten.'] : [],
        requiredVerification: ['Schwere Einzelfälle getrennt nach Ort und Konfliktmechanismus prüfen.'],
      }));
    }
    return findings;
  }

  function cyclicWindow(counts, width) {
    let best = { start: 0, count: 0 };
    for (let start = 0; start < 24; start++) {
      let count = 0;
      for (let offset = 0; offset < width; offset++) count += counts[(start + offset) % 24] || 0;
      if (count > best.count) best = { start, count };
    }
    return best;
  }

  function temporalFindings(structured, accidents) {
    const findings = [];
    const trend = structured?.yearlyTrend;
    if (trend?.classification && trend.classification !== 'unbestimmt') {
      const rising = trend.classification === 'steigend';
      findings.push(createFinding({
        id: `yearly-trend-${clean(trend.classification, 40)}`, detectorId: DETECTOR_IDS.TEMPORAL, family: 'temporal',
        label: `Mehrjahrestrend: ${trend.classification}`, classification: rising ? 'primary' : 'secondary',
        status: 'observed', causalStatus: CAUSAL_STATUS.DESCRIPTIVE,
        confidence: finite(trend.r2) !== null && Number(trend.r2) >= 0.5 ? 0.82 : 0.62,
        metrics: { classification: trend.classification, slope: round(trend.slope), r2: round(trend.r2), nYears: finite(trend.nYears) },
        evidence: [evidence('yearlyTrend', { classification: trend.classification, slope: round(trend.slope), r2: round(trend.r2) })],
        rationale: 'Der kanonische Trend beschreibt die Entwicklung der dokumentierten Jahreswerte im selben Auswahlbereich.',
        tags: rising ? ['rising_trend'] : ['yearly_trend'],
        limitations: ['Der Trend ist keine Unfallrate je Verkehrsleistung.'],
      }));
    }

    if (!Array.isArray(accidents) || accidents.length < 5) return findings;
    const hourCounts = Array(24).fill(0);
    let hoursKnown = 0;
    let wet = 0;
    let roadKnown = 0;
    let weekend = 0;
    let weekdaysKnown = 0;
    for (const item of accidents) {
      if (item.hour !== null && item.hour >= 0 && item.hour <= 23) { hourCounts[item.hour]++; hoursKnown++; }
      if (item.roadCondition !== null) { roadKnown++; if (item.roadCondition === 1 || item.roadCondition === 2) wet++; }
      if (item.weekday !== null) { weekdaysKnown++; if (item.weekday === 1 || item.weekday === 7) weekend++; }
    }
    if (hoursKnown >= 5) {
      const peak = cyclicWindow(hourCounts, 3);
      const share = peak.count / hoursKnown;
      if (share >= 0.4) {
        findings.push(createFinding({
          id: 'three-hour-concentration', detectorId: DETECTOR_IDS.TEMPORAL, family: 'temporal',
          label: 'Deutliche Konzentration in einem Drei-Stunden-Fenster', classification: share >= 0.55 ? 'primary' : 'secondary',
          status: 'observed', causalStatus: CAUSAL_STATUS.DESCRIPTIVE, confidence: hoursKnown >= 15 ? 0.78 : 0.6,
          metrics: { knownHours: hoursKnown, startHour: peak.start, endHour: (peak.start + 2) % 24, count: peak.count, share: round(share) },
          evidence: [evidence('accidents.hourDistribution', hourCounts)],
          rationale: 'Die zeitliche Konzentration kann auf wiederkehrende Verkehrs-, Sicht- oder Nutzungsbedingungen hinweisen.',
          tags: ['time_cluster'],
          requiredVerification: ['Verkehrsablauf und Nutzung im erkannten Zeitfenster beobachten.'],
        }));
      }
    }
    if (roadKnown >= 5 && wet / roadKnown >= 0.3) {
      findings.push(createFinding({
        id: 'wet-or-slippery-concentration', detectorId: DETECTOR_IDS.TEMPORAL, family: 'environment',
        label: 'Erhöhter Anteil bei nasser oder glatter Fahrbahn', classification: wet / roadKnown >= 0.5 ? 'primary' : 'secondary',
        status: 'observed', causalStatus: CAUSAL_STATUS.DESCRIPTIVE, confidence: roadKnown >= 15 ? 0.78 : 0.6,
        metrics: { knownRoadCondition: roadKnown, wetOrSlippery: wet, share: round(wet / roadKnown) },
        evidence: [evidence('accidents.roadCondition', { known: roadKnown, wetOrSlippery: wet })],
        rationale: 'Die dokumentierte Bedingung begründet eine gezielte Prüfung von Griffigkeit, Entwässerung, Markierungen und Metallflächen.',
        tags: ['wet', 'surface'],
        limitations: ['Fahrbahnzustand ist eine Begleitbedingung und nicht automatisch die Unfallursache.'],
        requiredVerification: ['Belag, Entwässerung, Markierungen, Schienen und Metallflächen bei Nässe prüfen.'],
      }));
    }
    if (weekdaysKnown >= 5 && weekend / weekdaysKnown >= 0.45) {
      findings.push(createFinding({
        id: 'weekend-concentration', detectorId: DETECTOR_IDS.TEMPORAL, family: 'temporal',
        label: 'Ungewöhnlich hoher Wochenendanteil', classification: 'secondary', status: 'observed',
        causalStatus: CAUSAL_STATUS.DESCRIPTIVE, confidence: weekdaysKnown >= 15 ? 0.72 : 0.56,
        metrics: { knownWeekdays: weekdaysKnown, weekend, share: round(weekend / weekdaysKnown) },
        evidence: [evidence('accidents.weekday', { known: weekdaysKnown, weekend })],
        rationale: 'Ein hoher Wochenendanteil kann auf Freizeitverkehr oder andere Nutzungsmuster hinweisen.',
        tags: ['weekend'], requiredVerification: ['Nutzungs- und Verkehrsaufkommen werktags und am Wochenende vergleichen.'],
      }));
    }
    return findings;
  }

  function projectPoints(points) {
    if (!points.length) return [];
    const lat0 = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const lonScale = 111320 * Math.cos(lat0 * Math.PI / 180);
    return points.map(point => ({ ...point, x: point.lon * lonScale, y: point.lat * 110540 }));
  }

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function connectedComponents(points, radiusM) {
    const n = points.length;
    const visited = Array(n).fill(false);
    const components = [];
    for (let start = 0; start < n; start++) {
      if (visited[start]) continue;
      visited[start] = true;
      const queue = [start];
      const component = [];
      while (queue.length) {
        const current = queue.pop();
        component.push(current);
        for (let next = 0; next < n; next++) {
          if (!visited[next] && distance(points[current], points[next]) <= radiusM) {
            visited[next] = true;
            queue.push(next);
          }
        }
      }
      components.push(component);
    }
    return components.sort((a, b) => b.length - a.length);
  }

  function spatialMetrics(input) {
    const points = projectPoints(input);
    const n = points.length;
    if (!n) return { sampleSize: 0 };
    const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
    const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
    let xx = 0; let yy = 0; let xy = 0;
    for (const p of points) {
      const dx = p.x - meanX; const dy = p.y - meanY;
      xx += dx * dx; yy += dy * dy; xy += dx * dy;
    }
    xx /= n; yy /= n; xy /= n;
    const trace = xx + yy;
    const rootValue = Math.sqrt(Math.max(0, ((xx - yy) ** 2) + 4 * xy * xy));
    const lambda1 = (trace + rootValue) / 2;
    const lambda2 = (trace - rootValue) / 2;
    const anisotropy = lambda2 > 1 ? lambda1 / lambda2 : (lambda1 > 0 ? 999 : 1);
    const spanX = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
    const spanY = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
    const spanMeters = Math.hypot(spanX, spanY);
    let largestCluster = null;
    if (n <= 1200) {
      const components = connectedComponents(points, 35);
      largestCluster = components[0]?.length || 0;
    }
    return {
      sampleSize: n,
      spanMeters: Math.round(spanMeters),
      anisotropy: round(anisotropy, 2),
      largestCluster35m: largestCluster,
      largestClusterShare: largestCluster === null ? null : round(largestCluster / n),
      exactClusterAnalysis: n <= 1200,
    };
  }

  function findingsForSpatialSubset(points, subsetId, label, detectorId) {
    if (points.length < 3) return [];
    const metrics = spatialMetrics(points);
    const findings = [];
    const scope = { selection: 'active', accidentSubset: subsetId };
    if (metrics.sampleSize >= 5 && metrics.spanMeters >= 150 && metrics.anisotropy >= 4) {
      findings.push(createFinding({
        id: `${subsetId}-linear-corridor-pattern`, detectorId, family: 'spatial',
        label: `${label}: lineares Korridor- statt reines Punktmuster`, classification: 'primary', status: 'observed',
        causalStatus: CAUSAL_STATUS.SPATIAL, confidence: metrics.sampleSize >= 10 ? 0.84 : 0.67,
        scope, metrics, evidence: [evidence('spatialMetrics', metrics)],
        rationale: 'Die räumliche Hauptausdehnung ist deutlich größer als die Querausdehnung; das spricht für einen streckenbezogenen Prüfbedarf.',
        tags: ['linear_corridor'],
        limitations: ['Punktkoordinaten und verbundene 35-m-Nachbarschaften ersetzen keine Rekonstruktion der tatsächlichen Fahrlinie.'],
        requiredVerification: ['Achse segmentweise befahren/begehen und wiederkehrende Geometrie-, Führungs- oder Oberflächenmerkmale dokumentieren.'],
      }));
    }
    if (metrics.largestCluster35m >= 3 && metrics.largestClusterShare >= 0.4) {
      findings.push(createFinding({
        id: `${subsetId}-dominant-local-cluster`, detectorId, family: 'spatial',
        label: `${label}: dominanter räumlicher Teilcluster`, classification: 'primary', status: 'observed',
        causalStatus: CAUSAL_STATUS.SPATIAL, confidence: metrics.sampleSize >= 10 ? 0.82 : 0.65,
        scope, metrics, evidence: [evidence('spatialMetrics.largestCluster35m', metrics.largestCluster35m), evidence('spatialMetrics.largestClusterShare', metrics.largestClusterShare)],
        rationale: 'Ein großer Anteil der Teilmenge liegt in derselben 35-m-Nachbarschaft und sollte ortsgenau untersucht werden.',
        tags: ['tight_cluster'],
        limitations: ['Eine Nachbarschaftskomponente kann entlang einer Kette von Punkten wachsen; sie ist kein amtlicher Unfallschwerpunktbegriff.'],
        requiredVerification: ['Clustergrenze, Straßensegment, Knoten und Bewegungsbeziehungen ortsgenau prüfen.'],
      }));
    }
    return findings;
  }

  function spatialFindings(accidents) {
    if (!Array.isArray(accidents)) return [];
    const findings = findingsForSpatialSubset(accidents, 'all-accidents', 'Gesamtkollektiv', DETECTOR_IDS.SPATIAL);
    const bikeOnly = accidents.filter(item => item.mask === 1);
    findings.push(...findingsForSpatialSubset(bikeOnly, 'bike-only', 'Rad-only-/Fahrradalleinunfall-Teilkohorte', DETECTOR_IDS.SPATIAL));
    return findings;
  }

  function contextKeys(structured) {
    const out = new Set();
    for (const key of array(structured?.contextualMeasures?.contexts)) out.add(clean(key, 100));
    for (const rule of array(structured?.contextualMeasures?.matchedRules)) {
      if (rule?.context) out.add(clean(rule.context, 100));
    }
    const osm = structured?.osmContext?.contexts || {};
    if ((finite(osm.tramTrackWays) || 0) > 0) { out.add('straßenbahn_schienen'); out.add('gleisquerung'); }
    if ((finite(osm.trainStations) || 0) > 0) out.add('bahnhof');
    if ((finite(osm.busStations) || 0) > 0) out.add('busbahnhof');
    if ((finite(osm.cobblestoneWays) || 0) > 0) out.add('kopfsteinpflaster');
    if ((finite(osm.mixedFootCycleWays) || 0) > 0) out.add('gemeinsame_fuss_rad_flaeche');
    const poiText = JSON.stringify(structured?.poi || {}).toLowerCase();
    if (/schule|kindergarten|kita/.test(poiText)) out.add('schulweg');
    if (/bahnhof|haltestelle|öpnv|oepnv|bus/.test(poiText)) out.add('oepnv');
    return out;
  }

  function hasFinding(findings, id) { return array(findings).some(item => item.id === id); }

  function contextCombinationFindings(structured, previousFindings) {
    const contexts = contextKeys(structured);
    const findings = [];
    const bikeOnly = hasFinding(previousFindings, 'bike-only-involvement-pattern');
    const bikeCar = hasFinding(previousFindings, 'bike-car-involvement-pattern');
    const pedCar = hasFinding(previousFindings, 'ped-car-involvement-pattern');
    const bikePed = hasFinding(previousFindings, 'bike-ped-involvement-pattern');

    if (bikeOnly && (contexts.has('straßenbahn_schienen') || contexts.has('gleisquerung'))) {
      findings.push(createFinding({
        id: 'bike-solo-rail-mechanism-candidate', detectorId: DETECTOR_IDS.CONTEXT, family: 'infrastructure',
        label: 'Fahrradalleinunfälle und befahrbare Schiene als zu prüfender Mechanismus',
        classification: 'primary', status: 'candidate', causalStatus: CAUSAL_STATUS.CANDIDATE, confidence: 0.68,
        scope: { selection: 'active', accidentSubset: 'bike-only', context: [...contexts].filter(k => /schiene|gleis/.test(k)) },
        evidence: [evidence('patternFinding', 'bike-only-involvement-pattern'), evidence('contextKeys', [...contexts])],
        rationale: 'Die Kombination aus Fahrradalleinunfall-Teilkohorte und Schienenkontext löst zwingend eine ortsgenaue Schienenhypothese aus.',
        tags: ['bike_alone', 'rail', 'surface'],
        limitations: ['Ko-Präsenz im Auswahlraum beweist noch nicht, dass Unfallpunkte auf derselben befahrbaren Schiene liegen oder dass die Schiene die Ursache war.'],
        requiredVerification: [
          'Abstand jedes Fahrradalleinunfalls zur befahrbaren Schienenachse bestimmen.',
          'Radfahrlinie, Parallelfahrt/Querung, Kurve, Weiche und Querungswinkel prüfen.',
          'Polizeiberichte, Ortsbegehung oder Unfallkommissionsunterlagen zur Mechanismusbestätigung heranziehen.',
        ],
      }));
    }
    if (bikeOnly && contexts.has('kopfsteinpflaster')) {
      findings.push(createFinding({
        id: 'bike-solo-surface-mechanism-candidate', detectorId: DETECTOR_IDS.CONTEXT, family: 'infrastructure',
        label: 'Fahrradalleinunfälle und problematischer Belag als Prüfhinweis', classification: 'secondary',
        status: 'candidate', causalStatus: CAUSAL_STATUS.CANDIDATE, confidence: 0.6,
        evidence: [evidence('patternFinding', 'bike-only-involvement-pattern'), evidence('contextKey', 'kopfsteinpflaster')],
        rationale: 'Rad-only-Unfälle in einem Bereich mit entsprechendem Oberflächenhinweis begründen eine Belags- und Griffigkeitsprüfung.',
        tags: ['bike_alone', 'surface'],
        limitations: ['OSM-/Kartenangabe kann veraltet oder räumlich zu grob sein.'],
        requiredVerification: ['Belag, Fugen, Rinnen, Niveauversätze und Griffigkeit ortsgenau und bei Nässe prüfen.'],
      }));
    }
    if ((pedCar || bikePed) && contexts.has('schulweg')) {
      findings.push(createFinding({
        id: 'school-crossing-mechanism-candidate', detectorId: DETECTOR_IDS.CONTEXT, family: 'context',
        label: 'Schulumfeld mit Querungs- oder Fuß-/Radkonflikt', classification: 'primary', status: 'candidate',
        causalStatus: CAUSAL_STATUS.CANDIDATE, confidence: 0.66,
        evidence: [evidence('contextKey', 'schulweg'), evidence('matchingPatterns', { pedCar, bikePed })],
        rationale: 'Die Kombination aus vulnerablem Verkehrsmuster und Schul-/Kita-Kontext erfordert eine zeit- und wegebezogene Querungsanalyse.',
        tags: ['school_zone', 'crossing'],
        requiredVerification: ['Bring-/Holzeiten, Wunschlinien, Sichtfelder, Halten/Parken und Querungsangebote beobachten.'],
      }));
    }
    if ((bikeCar || bikePed || pedCar) && [...contexts].some(key => /bahnhof|busbahnhof|oepnv/.test(key))) {
      findings.push(createFinding({
        id: 'transit-interchange-conflict-candidate', detectorId: DETECTOR_IDS.CONTEXT, family: 'context',
        label: 'Intermodaler Bahnhof-/Haltestellenkonflikt', classification: 'secondary', status: 'candidate',
        causalStatus: CAUSAL_STATUS.CANDIDATE, confidence: 0.62,
        evidence: [evidence('transitContext', [...contexts]), evidence('matchingPatterns', { bikeCar, bikePed, pedCar })],
        rationale: 'Bahnhof, Busverkehr, Ein-/Ausstieg sowie Fuß- und Radbewegungen können mehrere überlagerte Konfliktsysteme bilden.',
        tags: ['transit', 'crossing'],
        requiredVerification: ['Bussteigkanten, Warteflächen, Querungswunschlinien, Radführung, Taxi-/Lieferverkehr und Sichtbeziehungen getrennt untersuchen.'],
      }));
    }
    return findings;
  }

  function pluginResult(key, value, options) {
    const opts = options || {};
    return {
      producedArtifacts: { [key]: value },
      status: opts.status,
      confidence: opts.confidence,
      completeness: opts.completeness,
      warnings: opts.warnings || [],
    };
  }

  function structuredPlugin(definition) {
    return Object.freeze({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      requiredData: [DATA_KEYS.STRUCTURED],
      optionalData: definition.optionalData || [],
      requiredCapabilities: [], optionalCapabilities: [],
      producedArtifacts: [definition.artifactKey], dependsOn: definition.dependsOn || [],
      supportsPartialData: true,
      run: definition.run,
    });
  }

  const DATA_QUALITY_PLUGIN = structuredPlugin({
    id: DETECTOR_IDS.DATA_QUALITY, name: 'Datenkonsistenz', description: 'Prüft Grundsummen und Teilmengen.',
    artifactKey: ARTIFACT_KEYS.DATA_QUALITY, optionalData: [DATA_KEYS.ACCIDENTS],
    run(ctx) {
      const accidents = ctx.hasData(DATA_KEYS.ACCIDENTS) ? normaliseAccidents(ctx.getData(DATA_KEYS.ACCIDENTS)) : null;
      return pluginResult(ARTIFACT_KEYS.DATA_QUALITY, dataQualityFindings(ctx.getData(DATA_KEYS.STRUCTURED), accidents), {
        status: accidents ? undefined : 'partial', completeness: accidents ? 1 : 0.85,
        warnings: accidents ? [] : ['Rohpunkte fehlen; Punktzahlkonsistenz nicht geprüft.'],
      });
    },
  });

  const SEVERITY_PLUGIN = structuredPlugin({
    id: DETECTOR_IDS.SEVERITY, name: 'Unfallschwere', description: 'Erkennt priorisierungsrelevante Schwerefolgen.',
    artifactKey: ARTIFACT_KEYS.SEVERITY,
    run(ctx) { return pluginResult(ARTIFACT_KEYS.SEVERITY, severityFindings(ctx.getData(DATA_KEYS.STRUCTURED))); },
  });

  const INVOLVEMENT_PLUGIN = structuredPlugin({
    id: DETECTOR_IDS.INVOLVEMENT, name: 'Beteiligungsmuster', description: 'Bewertet lokale Konstellationen und Überrepräsentationen.',
    artifactKey: ARTIFACT_KEYS.INVOLVEMENT,
    run(ctx) { return pluginResult(ARTIFACT_KEYS.INVOLVEMENT, involvementFindings(ctx.getData(DATA_KEYS.STRUCTURED))); },
  });

  const TEMPORAL_PLUGIN = structuredPlugin({
    id: DETECTOR_IDS.TEMPORAL, name: 'Zeit- und Umweltmuster', description: 'Erkennt Trend, Zeitfenster und Fahrbahnzustände.',
    artifactKey: ARTIFACT_KEYS.TEMPORAL, optionalData: [DATA_KEYS.ACCIDENTS],
    run(ctx) {
      const accidents = ctx.hasData(DATA_KEYS.ACCIDENTS) ? normaliseAccidents(ctx.getData(DATA_KEYS.ACCIDENTS)) : null;
      return pluginResult(ARTIFACT_KEYS.TEMPORAL, temporalFindings(ctx.getData(DATA_KEYS.STRUCTURED), accidents), {
        status: accidents ? undefined : 'partial', completeness: accidents ? 1 : 0.5,
        warnings: accidents ? [] : ['Rohpunkte fehlen; Stunden-, Wochenend- und Fahrbahnzustandsmuster nicht geprüft.'],
      });
    },
  });

  const SPATIAL_PLUGIN = structuredPlugin({
    id: DETECTOR_IDS.SPATIAL, name: 'Räumliche Morphologie', description: 'Erkennt Teilcluster und lineare Korridore.',
    artifactKey: ARTIFACT_KEYS.SPATIAL, optionalData: [DATA_KEYS.ACCIDENTS],
    run(ctx) {
      if (!ctx.hasData(DATA_KEYS.ACCIDENTS)) {
        return pluginResult(ARTIFACT_KEYS.SPATIAL, [], { status: 'partial', completeness: 0, warnings: ['Rohpunkte fehlen; räumliche Muster nicht geprüft.'] });
      }
      const accidents = normaliseAccidents(ctx.getData(DATA_KEYS.ACCIDENTS));
      const oversized = accidents.length > 1200;
      return pluginResult(ARTIFACT_KEYS.SPATIAL, spatialFindings(accidents), {
        status: oversized ? 'partial' : undefined, completeness: oversized ? 0.75 : 1,
        warnings: oversized ? ['Mehr als 1.200 Punkte: exakte 35-m-Komponenten wurden aus Laufzeitgründen nicht berechnet.'] : [],
      });
    },
  });

  const CONTEXT_PLUGIN = structuredPlugin({
    id: DETECTOR_IDS.CONTEXT, name: 'Muster-Kontext-Kombination', description: 'Kombiniert Befunde mit Infrastruktur- und Ortskontext.',
    artifactKey: ARTIFACT_KEYS.CONTEXT,
    dependsOn: [DETECTOR_IDS.INVOLVEMENT, DETECTOR_IDS.SEVERITY, DETECTOR_IDS.TEMPORAL, DETECTOR_IDS.SPATIAL],
    run(ctx) {
      const prior = [ARTIFACT_KEYS.INVOLVEMENT, ARTIFACT_KEYS.SEVERITY, ARTIFACT_KEYS.TEMPORAL, ARTIFACT_KEYS.SPATIAL]
        .flatMap(key => array(ctx.getData(key)));
      return pluginResult(ARTIFACT_KEYS.CONTEXT, contextCombinationFindings(ctx.getData(DATA_KEYS.STRUCTURED), prior));
    },
  });

  const DETECTOR_PLUGIN_IDS = Object.freeze([
    DETECTOR_IDS.DATA_QUALITY, DETECTOR_IDS.SEVERITY, DETECTOR_IDS.INVOLVEMENT,
    DETECTOR_IDS.TEMPORAL, DETECTOR_IDS.SPATIAL, DETECTOR_IDS.CONTEXT,
  ]);

  function findingSort(left, right) {
    const classRank = value => value === 'data-quality' ? 0 : value === 'primary' ? 1 : 2;
    const familyRank = value => {
      const index = FAMILY_ORDER.indexOf(value);
      return index < 0 ? FAMILY_ORDER.length : index;
    };
    return classRank(left.classification) - classRank(right.classification)
      || familyRank(left.family) - familyRank(right.family)
      || right.confidence - left.confidence
      || left.id.localeCompare(right.id);
  }

  const AGGREGATE_PLUGIN = structuredPlugin({
    id: DETECTOR_IDS.AGGREGATE, name: 'Kanonischer Musterbefund',
    description: 'Aggregiert deterministische Detektorergebnisse vor der KI.',
    artifactKey: ARTIFACT_KEYS.AGGREGATE, dependsOn: DETECTOR_PLUGIN_IDS,
    run(ctx) {
      const all = [ARTIFACT_KEYS.DATA_QUALITY, ARTIFACT_KEYS.SEVERITY, ARTIFACT_KEYS.INVOLVEMENT,
        ARTIFACT_KEYS.TEMPORAL, ARTIFACT_KEYS.SPATIAL, ARTIFACT_KEYS.CONTEXT]
        .flatMap(key => array(ctx.getData(key))).sort(findingSort);
      const findings = [];
      const seen = new Set();
      for (const item of all) {
        const key = `${item.detector?.id || ''}:${item.id}`;
        if (!seen.has(key)) { seen.add(key); findings.push(item); }
      }
      const detectorRuns = DETECTOR_PLUGIN_IDS.map(pluginId => {
        const result = ctx.getResult(pluginId) || {};
        return {
          pluginId, status: result.status || 'unknown', completeness: result.completeness ?? null,
          confidence: result.confidence ?? null, missingOptionalData: result.missingOptionalData || [],
          warnings: result.warnings || [],
        };
      });
      const blocking = findings.some(item => item.status === 'blocking-data-issue');
      const partial = detectorRuns.some(run => ['partial', 'skipped', 'failed'].includes(run.status));
      const structured = ctx.getData(DATA_KEYS.STRUCTURED) || {};
      const artifact = {
        schemaVersion: PATTERN_DETECTION_SCHEMA,
        status: blocking ? 'blocked-by-data-quality' : partial ? 'partial' : 'complete',
        analysisDate: structured?.meta?.date || null,
        findings,
        summary: {
          totalFindings: findings.length,
          primaryFindings: findings.filter(item => item.classification === 'primary').length,
          candidateFindings: findings.filter(item => item.status === 'candidate').length,
          dataQualityFindings: findings.filter(item => item.family === 'data-quality').length,
          families: [...new Set(findings.map(item => item.family))],
        },
        detectorRuns,
        aiEvaluationContract: {
          schemaVersion: 'unfallwerkbank.patternAiEvaluationContract.v1',
          ordering: 'deterministic-pattern-detection-before-model-evaluation',
          required: [
            'Jeden primären und jeden Kandidatenbefund bestätigen, präzisieren, widerlegen oder offen lassen.',
            'Räumliche Assoziation, mechanistische Plausibilität und bestätigte Ursache getrennt behandeln.',
            'Fehlende Eingaben und übersprungene Detektoren sichtbar in die Einreichungsreife einbeziehen.',
            'Keine deterministische Evidenz ohne begründeten Gegenbefund stillschweigend verwerfen.',
          ],
          prohibited: [
            'Aus Ko-Präsenz im Auswahlraum unmittelbar eine Unfallursache ableiten.',
            'Eine KI-Hypothese als Ersatz für fehlende Geometrie-, Expositions- oder Einzelfalldaten ausgeben.',
            'Nur das erste auffällige Muster betrachten und konkurrierende Muster ignorieren.',
          ],
        },
      };
      return pluginResult(ARTIFACT_KEYS.AGGREGATE, artifact, {
        status: artifact.status === 'complete' ? 'complete' : 'partial',
        completeness: blocking ? 0.5 : partial ? 0.8 : 1,
        confidence: blocking ? 0.5 : 0.9,
      });
    },
  });

  const BUILTIN_PLUGINS = Object.freeze([
    DATA_QUALITY_PLUGIN, SEVERITY_PLUGIN, INVOLVEMENT_PLUGIN,
    TEMPORAL_PLUGIN, SPATIAL_PLUGIN, CONTEXT_PLUGIN, AGGREGATE_PLUGIN,
  ]);

  async function runPatternPipeline(input) {
    const AP = UA.AnalysisPipeline;
    if (!AP || typeof AP.runPipeline !== 'function') throw new Error('AnalysisPipeline is unavailable.');
    const value = input || {};
    if (!value.structured || typeof value.structured !== 'object') throw new Error('structured analysis is required.');
    const seed = { [DATA_KEYS.STRUCTURED]: value.structured };
    if (value.accidents !== undefined && value.accidents !== null) seed[DATA_KEYS.ACCIDENTS] = value.accidents;
    const pipeline = await AP.runPipeline({
      dataRegistry: AP.createDataRegistry(seed),
      pluginRegistry: AP.createPluginRegistry(BUILTIN_PLUGINS),
    });
    return { artifact: AP.getData(pipeline.dataRegistry, ARTIFACT_KEYS.AGGREGATE), pipeline };
  }

  function boundsContains(bounds, point) {
    if (!bounds || !point) return true;
    if (typeof bounds.contains === 'function') {
      try { return !!bounds.contains([point.lat, point.lon]); } catch (_) {
        try { return !!bounds.contains({ lat: point.lat, lng: point.lon }); } catch (_) { /* continue */ }
      }
    }
    const south = finite(typeof bounds.getSouth === 'function' ? bounds.getSouth() : bounds.south);
    const west = finite(typeof bounds.getWest === 'function' ? bounds.getWest() : bounds.west);
    const north = finite(typeof bounds.getNorth === 'function' ? bounds.getNorth() : bounds.north);
    const east = finite(typeof bounds.getEast === 'function' ? bounds.getEast() : bounds.east);
    if ([south, west, north, east].some(value => value === null)) return true;
    return point.lat >= south && point.lat <= north && point.lon >= west && point.lon <= east;
  }

  function selectedAccidents(ctx) {
    const source = Array.isArray(ctx?.filteredAll) ? ctx.filteredAll
      : Array.isArray(ctx?.viewportPts) ? ctx.viewportPts : null;
    if (!source) return null;
    const bounds = ctx?.selectionBounds || null;
    if (!bounds) return source;
    return source.filter(item => {
      const coords = item?.geometry?.type === 'Point' ? item.geometry.coordinates : null;
      const lat = finite(item?.lat ?? (coords && coords[1]));
      const lon = finite(item?.lon ?? item?.lng ?? (coords && coords[0]));
      return lat !== null && lon !== null && boundsContains(bounds, { lat, lon });
    });
  }

  function bridgePatternLabel(item) {
    const metrics = item?.metrics && Object.keys(item.metrics).length
      ? `; metrics=${clean(JSON.stringify(item.metrics), 240)}` : '';
    return `${item.id}: ${item.label} [${item.causalStatus}; confidence=${item.confidenceLabel}${metrics}]`;
  }

  function bridgeToContextualMeasures(current, artifact) {
    const base = current && typeof current === 'object' ? current : {};
    const findings = array(artifact?.findings).filter(item => item.classification !== 'data-quality');
    const patterns = uniqueStrings([
      ...array(base.patterns),
      ...findings.map(bridgePatternLabel),
    ], 80);
    const checks = uniqueStrings([
      ...array(base.pruefauftraege),
      ...findings.flatMap(item => item.requiredVerification || []),
    ], 100);
    const syntheticRules = findings.map(item => ({
      id: `pattern-plugin:${item.id}`, pattern: item.id, context: item.scope?.context || null,
      detectorId: item.detector?.id || null, causalStatus: item.causalStatus,
    }));
    const matchedRules = [...array(base.matchedRules), ...syntheticRules];
    const rationalePrefix = findings.length
      ? 'Deterministische Muster-Plugins wurden vor der KI ausgeführt. Die Befunde unterscheiden Beschreibung, räumliche Assoziation und Mechanismuskandidaten.'
      : '';
    return {
      ...base,
      patterns,
      pruefauftraege: checks,
      matchedRules,
      rationale: [rationalePrefix, clean(base.rationale, 2000)].filter(Boolean).join(' '),
      patternDetectionSchema: artifact?.schemaVersion || null,
      patternDetectionStatus: artifact?.status || null,
      patternFindings: findings,
    };
  }

  function failedArtifact(error) {
    return {
      schemaVersion: PATTERN_DETECTION_SCHEMA, status: 'failed', analysisDate: null, findings: [],
      summary: { totalFindings: 0, primaryFindings: 0, candidateFindings: 0, dataQualityFindings: 0, families: [] },
      detectorRuns: [], warnings: [clean(error?.message || error, 1000)],
      aiEvaluationContract: {
        schemaVersion: 'unfallwerkbank.patternAiEvaluationContract.v1',
        ordering: 'pattern-detection-failed-before-model-evaluation',
        required: ['Fehlgeschlagene Mustererkennung als Datenlücke ausweisen; nicht durch freie KI-Spekulation ersetzen.'],
        prohibited: ['Ein vollständiges deterministisches Musterinventar behaupten.'],
      },
    };
  }

  function wrapExportReport() {
    const original = UA.computeExportReport;
    if (typeof original !== 'function') return false;
    if (original._uaPatternPluginsWrapped) return true;
    const wrapped = async function wrappedPatternReport(ctx, ...args) {
      const report = await original.call(this, ctx, ...args);
      if (report?.structured && typeof report.structured === 'object') {
        try {
          const result = await runPatternPipeline({ structured: report.structured, accidents: selectedAccidents(ctx) });
          report.structured.patternDetection = result.artifact;
          report.structured.contextualMeasures = bridgeToContextualMeasures(
            report.structured.contextualMeasures, result.artifact
          );
        } catch (error) {
          report.structured.patternDetection = failedArtifact(error);
        }
      }
      return report;
    };
    wrapped._uaPatternPluginsWrapped = true;
    wrapped._uaOriginal = original;
    UA.computeExportReport = wrapped;
    return true;
  }

  function install() { return !!(UA.AnalysisPipeline && wrapExportReport()); }

  UA.PatternPlugins = Object.freeze({
    PATTERN_DETECTION_SCHEMA, PATTERN_FINDING_SCHEMA, DETECTOR_VERSION,
    DATA_KEYS, ARTIFACT_KEYS, DETECTOR_IDS, CAUSAL_STATUS, BUILTIN_PLUGINS,
    createFinding, normaliseAccidents, involvementFindings, severityFindings,
    temporalFindings, spatialMetrics, spatialFindings, contextCombinationFindings,
    dataQualityFindings, runPatternPipeline, selectedAccidents, bridgeToContextualMeasures,
    failedArtifact, wrapExportReport, install,
    _internal: Object.freeze({
      clean, finite, clamp, round, evidence, propertyValue, involvementMask,
      maskInfo, projectPoints, connectedComponents, contextKeys, boundsContains, bridgePatternLabel,
    }),
  });

  if (!root.__UA_DISABLE_PATTERN_PLUGIN_AUTOINSTALL__) {
    let attempts = 0;
    const retry = () => {
      if (install()) return;
      if (attempts++ < 400 && typeof root.setTimeout === 'function') root.setTimeout(retry, 25);
    };
    retry();
  }
})();
