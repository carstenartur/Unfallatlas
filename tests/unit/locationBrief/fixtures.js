'use strict';

/**
 * Shared fixture builders for Location Action Brief tests.
 *
 * Mirrors the shape produced by the frontend's `computeExportReport()`
 * (see `js/ua.export_v2.js`) so the brief service can be exercised with
 * realistic structured inputs without instantiating the browser pipeline.
 */

function buildStructured(opts) {
  const o = Object.assign({
    city: 'Hannover',
    areaName: 'Testbereich',
    total: 20,
    fatal: 0,
    serious: 2,
    slight: 18,
    crossRows: [],
    poiWithin: {},
    poiNear: {},
    yearTable: [
      { year: 2020, total: 4 },
      { year: 2021, total: 5 },
      { year: 2022, total: 5 },
      { year: 2023, total: 6 }
    ],
    accidentRows: 6,
    spread: 0.0001
  }, opts || {});

  return {
    meta: {
      city: o.city, areaName: o.areaName, date: '01.01.2025',
      filters: { severity: 'all', roadCondition: 'all' },
      involvementMode: 'or'
    },
    severity: { total: o.total, bySev: { '1': o.fatal, '2': o.serious, '3': o.slight, other: 0 } },
    deviations: { focus: o.crossRows.map(r => ({ mask: r.mask, label: r.label, localCount: r.total, baselineCount: 1, relativeDiff: 1.0 })), rows: [] },
    yearTable: o.yearTable,
    poi: {
      withinByType: o.poiWithin,
      nearByType:   o.poiNear,
      totalWithin:  Object.values(o.poiWithin).reduce((s, x) => s + x, 0),
      totalNear:    Object.values(o.poiNear).reduce((s, x) => s + x, 0)
    },
    references: [],
    crossTable: {
      rows: o.crossRows,
      totals: { sev1: o.fatal, sev2: o.serious, sev3: o.slight, total: o.total }
    },
    accidentDetails: {
      rows: Array.from({ length: o.accidentRows }, (_, i) => ({
        year: 2022, sevLabel: 'leicht', involved: 'Rad+PKW',
        hour: 16,
        lat: 52.375 + o.spread * i,
        lon: 9.730  + o.spread * i
      })),
      total: o.accidentRows,
      truncated: false
    }
  };
}

/** Convenience: a political-context search result with one or more references. */
function buildPoliticalContext(refs) {
  return {
    meta: { city: 'Hannover' },
    references: refs
  };
}

/** A reference object as it would come from the political-context service. */
function ref({ title, type = 'Antrag', url = 'https://example.org/x', score = 0.8, traffic = 'traffic_safety', date }) {
  return {
    title, type, url,
    relevanceScore: score,
    trafficRelevance: { classification: traffic, score, isRelevant: true },
    date: date || new Date().toISOString()
  };
}

module.exports = { buildStructured, buildPoliticalContext, ref };
