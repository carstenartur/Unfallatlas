'use strict';

/**
 * Deterministische Merkmalsableitung aus dem strukturierten Export.
 *
 * Dieses Modul rechnet sämtliche fachlichen Kennzahlen, die der KI als
 * Vorverdauung mitgegeben werden, OHNE die Statistiklogik der App zu ersetzen.
 * Die Ergebnisse sind:
 *   - Eingabe für das v2-AI-Input-Objekt
 *   - Eingabe für die Maßnahmenvorselektion
 *
 * Erkannte Merkmale (semantische Tags):
 *   bike_alone, bike_car, bike_truck, ped_car, ped_alone,
 *   car_car, motorcycle, hgv, junction, crossing, surface,
 *   night, rush_hour, school_zone, transit, rail
 *
 * @module server/ai/features/deriveFeatures
 */

// 6-Bit-Maske: Rad=1, Fuß=2, PKW=4, Krad=8, Gkfz=16, Sonstig=32
const BIT_BIKE  = 1;
const BIT_PED   = 2;
const BIT_CAR   = 4;
const BIT_MOTO  = 8;
const BIT_TRUCK = 16;
// const BIT_OTHER = 32; // not used directly

const { detectConflictPatterns } = require('./conflictPatterns.js');

/**
 * Berechnet aggregierte Anteile / Trends / Tags aus structured.
 *
 * @param {object} structured  vollständiges structured-Objekt aus computeExportReport()
 * @param {object} [contextHints]  optionale manuelle Kontextnotizen
 * @returns {DerivedFeatures}
 */
function deriveFeatures(structured, contextHints) {
  const meta     = structured?.meta     || {};
  const sev      = structured?.severity || {};
  const dev      = structured?.deviations || {};
  const yr       = structured?.yearTable || [];
  const poi      = structured?.poi || null;
  const cross    = structured?.crossTable || null;
  const details  = structured?.accidentDetails || null;

  const total = Number(sev.total || 0);
  const bySev = sev.bySev || {};
  const fatal   = Number(bySev['1'] ?? 0);
  const serious = Number(bySev['2'] ?? 0);
  const slight  = Number(bySev['3'] ?? 0);
  const knownSev = fatal + serious + slight;

  // ── Anteil schwere Unfälle (KSI = killed + serious injured) ──────────────────
  const ksiShare = knownSev > 0 ? (fatal + serious) / knownSev : 0;

  // ── Beteiligungsanteile aus crossTable.rows (mask → totals) ─────────────────
  const involvement = computeInvolvementShares(cross, total);

  // ── Dominantes Beteiligungsmuster aus deviations + crossTable ───────────────
  const dominantPatterns = pickDominantPatterns(dev, cross);

  // ── Trend über Jahre (linear: simpler change between first/last) ────────────
  const trend = computeYearTrend(yr);

  // ── Räumliche Verdichtung: Hinweis aus accidentDetails (sehr einfach) ───────
  const spatialDensity = computeSpatialDensityHint(details, total);

  // ── Tags ableiten ──────────────────────────────────────────────────────────
  const tags = new Set();

  if (involvement.bike >= 0.30)   tags.add('bike_car');
  if (involvement.bike >= 0.50)   tags.add('bike_alone');
  if (involvement.ped  >= 0.20)   tags.add('ped_car');
  if (involvement.truck >= 0.10)  tags.add('hgv');
  if (involvement.truck >= 0.05 && involvement.bike >= 0.20) tags.add('bike_truck');
  if (involvement.moto >= 0.10)   tags.add('motorcycle');
  if (involvement.car  >= 0.40)   tags.add('car_car');

  // KSI-Anteil → Hinweis auf Knotenpunkt-/Querungsproblematik
  if (ksiShare >= 0.20) tags.add('junction');
  if (ksiShare >= 0.30) tags.add('crossing');

  // POI-Tags
  if (poi) {
    const within = poi.withinByType || {};
    const near   = poi.nearByType   || {};
    const both   = mergeKeys(within, near);
    if (both.has('Schule') || both.has('schule') || both.has('Kindergarten') || both.has('kindergarten')) {
      tags.add('school_zone');
    }
    if (both.has('Haltestelle') || both.has('haltestelle') || both.has('OEPNV') || both.has('Bahnhof')) {
      tags.add('transit');
    }
    if (both.has('Bahn') || both.has('Schiene') || both.has('rail')) {
      tags.add('rail');
    }
  }

  // ── contextHints normalisieren und für Tags nutzen ──────────────────────────
  const normalizedHints = normalizeContextHints(contextHints);
  for (const hint of [...normalizedHints.knownHazards, ...normalizedHints.surfaceHints, ...normalizedHints.locationHints, ...normalizedHints.notes]) {
    const h = hint.toLowerCase();
    if (h.includes('schiene') || h.includes('gleis') || h.includes('tram')) tags.add('rail');
    if (h.includes('kopfstein') || h.includes('belag') || h.includes('pflaster') || h.includes('spurrille') || h.includes('rutsch')) tags.add('surface');
    if (h.includes('schule') || h.includes('kita')) tags.add('school_zone');
    if (h.includes('lkw') || h.includes('truck') || h.includes('schwerverkehr')) tags.add('hgv');
    if (h.includes('haltestelle') || h.includes('bus ') || h.includes('öpnv')) tags.add('transit');
    if (h.includes('nacht') || h.includes('dunk')) tags.add('night');
    if (h.includes('berufsverkehr') || h.includes('rush') || h.includes('hauptverkehr')) tags.add('rush_hour');
  }

  // Surface-Tag ggf. aus deviations (hoher Anteil Bike-Alleinunfälle)
  if (tags.has('bike_alone') && (involvement.car < 0.20)) {
    tags.add('surface');
  }

  const features = {
    counts: { total, fatal, serious, slight, knownSev },
    ksiShare,
    involvement,
    dominantPatterns,
    trend,
    spatialDensity,
    tags: Array.from(tags),
    normalizedHints,
    poiSummary: summarizePoi(poi),
    references: summarizeReferences(structured?.references || [])
  };
  // Konfliktmuster werden auf Basis aller obigen Features berechnet
  // und als zusätzliches Feld angehängt. Sie sind ein Spezialfall von
  // Tags – weiterführend für KI-Bewertung und Maßnahmenvorselektion.
  features.conflictPatterns = detectConflictPatterns(features, normalizedHints);
  // Tags um Pattern-Tags ergänzen (Set-Semantik), damit Vorselektion
  // automatisch davon profitiert, ohne dass jeder Aufrufer das tun muss.
  for (const p of features.conflictPatterns) {
    for (const t of (p.tags || [])) tags.add(t);
  }
  features.tags = Array.from(tags);
  return features;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function computeInvolvementShares(cross, total) {
  const acc = { bike: 0, ped: 0, car: 0, moto: 0, truck: 0 };
  if (!cross || !Array.isArray(cross.rows) || total <= 0) {
    return Object.assign(acc, { share: 'unknown' });
  }
  let counted = 0;
  for (const row of cross.rows) {
    const m = Number(row.mask || 0);
    const t = Number(row.total || 0);
    if (!m || !t) continue;
    counted += t;
    if (m & BIT_BIKE)  acc.bike  += t;
    if (m & BIT_PED)   acc.ped   += t;
    if (m & BIT_CAR)   acc.car   += t;
    if (m & BIT_MOTO)  acc.moto  += t;
    if (m & BIT_TRUCK) acc.truck += t;
  }
  if (counted <= 0) return Object.assign(acc, { share: 'unknown' });
  return {
    bike:  round2(acc.bike  / counted),
    ped:   round2(acc.ped   / counted),
    car:   round2(acc.car   / counted),
    moto:  round2(acc.moto  / counted),
    truck: round2(acc.truck / counted),
    sampleSize: counted
  };
}

function pickDominantPatterns(dev, cross) {
  const out = [];
  // From deviations.focus (positive relative deviation = local overrepresentation)
  const focus = Array.isArray(dev?.focus) ? dev.focus : [];
  const sorted = focus
    .map(d => ({
      label:        d.label || String(d.mask || ''),
      mask:         Number(d.mask || 0),
      relativeDiff: Number(d.relativeDiff ?? d.relDiff ?? 0),
      localCount:   Number(d.localCount ?? d.localCnt ?? 0)
    }))
    .filter(d => d.localCount > 0)
    .sort((a, b) => b.relativeDiff - a.relativeDiff);

  for (const d of sorted.slice(0, 5)) {
    out.push({
      label: d.label,
      mask: d.mask,
      relativeDiff: round2(d.relativeDiff),
      localCount: d.localCount
    });
  }

  // Also include top crossTable rows by total (if no deviations available)
  if (out.length === 0 && cross && Array.isArray(cross.rows)) {
    const top = [...cross.rows].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 3);
    for (const r of top) {
      out.push({ label: r.label, mask: Number(r.mask || 0), localCount: Number(r.total || 0) });
    }
  }
  return out;
}

function computeYearTrend(yearTable) {
  if (!Array.isArray(yearTable) || yearTable.length < 2) {
    return { direction: 'unknown', rangeYears: yearTable?.length || 0 };
  }
  const sorted = [...yearTable].filter(y => y && y.year != null).sort((a, b) => a.year - b.year);
  if (sorted.length < 2) return { direction: 'unknown', rangeYears: sorted.length };

  // Compare averages of first half vs second half
  const mid = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);
  const avg = arr => arr.reduce((s, y) => s + (Number(y.total) || 0), 0) / Math.max(1, arr.length);
  const a = avg(firstHalf);
  const b = avg(secondHalf);
  const diff = b - a;
  const relDiff = a > 0 ? diff / a : 0;

  let direction = 'stable';
  if (relDiff >  0.20) direction = 'rising';
  else if (relDiff < -0.20) direction = 'falling';

  return {
    direction,
    rangeYears: sorted.length,
    firstYear: sorted[0].year,
    lastYear:  sorted[sorted.length - 1].year,
    relativeChange: round2(relDiff)
  };
}

function computeSpatialDensityHint(details, total) {
  // Only produce a hint, do not pretend full clustering.
  if (!details || !Array.isArray(details.rows) || details.rows.length < 5) {
    return { hint: 'insufficient_data', sampleSize: details?.rows?.length || 0 };
  }
  const lats = details.rows.map(r => Number(r.lat)).filter(n => Number.isFinite(n));
  const lons = details.rows.map(r => Number(r.lon)).filter(n => Number.isFinite(n));
  if (lats.length < 5 || lons.length < 5) {
    return { hint: 'insufficient_coords', sampleSize: lats.length };
  }
  const latRange = Math.max(...lats) - Math.min(...lats);
  const lonRange = Math.max(...lons) - Math.min(...lons);
  // Rough span in meters (1° lat ≈ 111 km, 1° lon ≈ 70 km in DE)
  const spanMeters = Math.max(latRange * 111000, lonRange * 70000);
  let hint = 'distributed';
  if (spanMeters < 80)       hint = 'tight_cluster';
  else if (spanMeters < 200) hint = 'cluster';
  else if (spanMeters < 500) hint = 'localized';
  return {
    hint,
    spanMeters: Math.round(spanMeters),
    sampleSize: lats.length,
    totalAccidents: total
  };
}

function summarizePoi(poi) {
  if (!poi) return null;
  const within = poi.withinByType || {};
  const near   = poi.nearByType   || {};
  const filter = obj => Object.entries(obj).filter(([, v]) => v > 0).map(([k, v]) => ({ type: k, count: v }));
  return {
    totalWithin: Number(poi.totalWithin ?? 0),
    totalNear:   Number(poi.totalNear   ?? 0),
    within: filter(within),
    near:   filter(near)
  };
}

function summarizeReferences(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.slice(0, 8).map(r => {
    if (typeof r === 'string') return { title: r };
    return {
      title: r.title || r.name || '',
      type:  r.type  || r.kind || '',
      url:   r.url   || ''
    };
  }).filter(r => r.title);
}

function normalizeContextHints(hints) {
  const safe = hints && typeof hints === 'object' ? hints : {};
  const cap = (arr, max = 10) => Array.isArray(arr) ? arr
    .map(s => String(s || '').trim())
    .filter(s => s.length > 0 && s.length <= 200)
    .slice(0, max) : [];
  return {
    knownHazards:  cap(safe.knownHazards),
    locationHints: cap(safe.locationHints),
    surfaceHints:  cap(safe.surfaceHints),
    notes:         cap(safe.notes)
  };
}

function mergeKeys(a, b) {
  const set = new Set();
  for (const k of Object.keys(a || {})) if (a[k] > 0) set.add(k);
  for (const k of Object.keys(b || {})) if (b[k] > 0) set.add(k);
  return set;
}

function round2(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

module.exports = { deriveFeatures, normalizeContextHints };

/**
 * @typedef {object} DerivedFeatures
 * @property {object} counts
 * @property {number} ksiShare
 * @property {object} involvement
 * @property {Array}  dominantPatterns
 * @property {object} trend
 * @property {object} spatialDensity
 * @property {string[]} tags
 * @property {object} normalizedHints
 * @property {object|null} poiSummary
 * @property {Array}  references
 */
