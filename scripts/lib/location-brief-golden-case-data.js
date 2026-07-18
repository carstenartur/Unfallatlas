'use strict';

/**
 * Build the deterministic `structured` input used by Location Action Briefs
 * from a real city GeoJSON and a golden-case bounding box.
 *
 * The helper deliberately lives outside Jest/Testcontainers so the exact same
 * data selection can be used by local diagnostics and the full persistence /
 * ranking integration test.  Static data is addressed by its logical raw path;
 * `readJsonMaybeGz` transparently reads the deployed `.gz` representation.
 */

const path = require('path');
const { readJsonMaybeGz } = require('./read-json-maybe-gz');
const { slugify: normalizeCitySlug } = require('./static-data-validation');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

const BIT_MASK = Object.freeze({
  istrad: 1,
  istfuss: 2,
  istpkw: 4,
  istkrad: 8,
  istgkfz: 16,
  istsonstig: 32
});

const BIT_MASK_FIELDS = Object.freeze({
  istrad: ['istrad', 'IstRad'],
  istfuss: ['istfuss', 'IstFuss'],
  istpkw: ['istpkw', 'IstPKW'],
  istkrad: ['istkrad', 'IstKrad'],
  istgkfz: ['istgkfz', 'IstGkfz'],
  istsonstig: ['istsonstig', 'IstSonstig']
});

const CITY_GEOJSON_CACHE = new Map();

function asInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getCaseInsensitiveProp(properties, names) {
  if (!properties || !Array.isArray(names) || names.length === 0) return undefined;
  for (const name of names) {
    if (properties[name] !== undefined) return properties[name];
  }
  const byLowerName = new Map(
    Object.entries(properties).map(([key, value]) => [String(key).toLowerCase(), value])
  );
  for (const name of names) {
    const value = byLowerName.get(String(name).toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

function loadCityGeoJson(city, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const citySlug = normalizeCitySlug(city);
  if (!citySlug) throw new Error('Golden case requires a non-empty city.');

  const logicalPath = path.resolve(repoRoot, `out/output_all_years_${citySlug}.geojson`);
  const cacheKey = `${repoRoot}:${logicalPath}`;
  if (!CITY_GEOJSON_CACHE.has(cacheKey)) {
    const geojson = readJsonMaybeGz(logicalPath, options.dataMode ? { mode: options.dataMode } : undefined);
    if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
      throw new Error(`Golden-case input is not a GeoJSON FeatureCollection: ${logicalPath}`);
    }
    CITY_GEOJSON_CACHE.set(cacheKey, geojson);
  }
  return CITY_GEOJSON_CACHE.get(cacheKey);
}

function validateBoundingBox(bbox, caseId) {
  const fields = ['south', 'west', 'north', 'east'];
  if (!bbox || fields.some((field) => !Number.isFinite(Number(bbox[field])))) {
    throw new Error(`Golden case ${caseId || '<unknown>'} requires a numeric bbox.`);
  }
  if (Number(bbox.south) > Number(bbox.north) || Number(bbox.west) > Number(bbox.east)) {
    throw new Error(`Golden case ${caseId || '<unknown>'} has an inverted bbox.`);
  }
}

function buildStructuredFromCase(caseDef, options = {}) {
  if (!caseDef || !caseDef.city) throw new Error('Golden case requires a city.');
  validateBoundingBox(caseDef.bbox, caseDef.caseId);
  const geojson = loadCityGeoJson(caseDef.city, options);

  const points = geojson.features.filter((feature) => {
    const coordinates = feature && feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
    const [lon, lat] = coordinates.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    return lat >= Number(caseDef.bbox.south)
      && lat <= Number(caseDef.bbox.north)
      && lon >= Number(caseDef.bbox.west)
      && lon <= Number(caseDef.bbox.east);
  });

  const byYear = new Map();
  const byMask = new Map();
  const details = [];
  let fatal = 0;
  let serious = 0;
  let slight = 0;

  for (const feature of points) {
    const properties = feature.properties || {};
    const severity = asInt(getCaseInsensitiveProp(properties, ['ukategorie', 'UKATEGORIE']));
    if (severity === 1) fatal++;
    else if (severity === 2) serious++;
    else slight++;

    const year = asInt(getCaseInsensitiveProp(properties, ['year', 'UJAHR']));
    if (year > 0) byYear.set(year, (byYear.get(year) || 0) + 1);

    let mask = 0;
    for (const [key, bit] of Object.entries(BIT_MASK)) {
      if (asInt(getCaseInsensitiveProp(properties, BIT_MASK_FIELDS[key])) > 0) mask |= bit;
    }
    if (mask > 0) {
      const row = byMask.get(mask) || {
        mask,
        label: String(mask),
        total: 0,
        sev1: 0,
        sev2: 0,
        sev3: 0
      };
      row.total++;
      if (severity === 1) row.sev1++;
      else if (severity === 2) row.sev2++;
      else row.sev3++;
      byMask.set(mask, row);
    }

    const [lon, lat] = feature.geometry.coordinates;
    details.push({
      year,
      sevLabel: severity === 1 ? 'getötet' : severity === 2 ? 'schwer' : 'leicht',
      involved: String(mask),
      hour: asInt(getCaseInsensitiveProp(properties, ['ustunde', 'USTUNDE'])),
      lat,
      lon
    });
  }

  const total = points.length;
  const crossRows = [...byMask.values()].sort((a, b) => b.total - a.total);
  return {
    meta: {
      city: caseDef.city,
      areaName: caseDef.description,
      date: caseDef.reportDate || '01.01.2026',
      filters: { severity: 'all', roadCondition: 'all' },
      involvementMode: 'or'
    },
    severity: { total, bySev: { '1': fatal, '2': serious, '3': slight, other: 0 } },
    deviations: {
      focus: crossRows.map((row) => ({
        mask: row.mask,
        label: row.label,
        localCount: row.total,
        baselineCount: 1,
        relativeDiff: 1
      })),
      rows: []
    },
    yearTable: [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, count]) => ({ year, total: count })),
    poi: {
      withinByType: caseDef.poiWithinByType || {},
      nearByType: caseDef.poiNearByType || {},
      totalWithin: Object.values(caseDef.poiWithinByType || {})
        .reduce((sum, count) => sum + Number(count || 0), 0),
      totalNear: Object.values(caseDef.poiNearByType || {})
        .reduce((sum, count) => sum + Number(count || 0), 0)
    },
    references: [],
    crossTable: {
      rows: crossRows,
      totals: { sev1: fatal, sev2: serious, sev3: slight, total }
    },
    accidentDetails: {
      rows: details.slice(0, 200),
      total: details.length,
      truncated: details.length > 200
    }
  };
}

function clearCityGeoJsonCache() {
  CITY_GEOJSON_CACHE.clear();
}

module.exports = {
  BIT_MASK,
  BIT_MASK_FIELDS,
  asInt,
  getCaseInsensitiveProp,
  normalizeCitySlug,
  loadCityGeoJson,
  buildStructuredFromCase,
  clearCityGeoJsonCache
};
