#!/usr/bin/env node
'use strict';

const fs = require('fs');

const { readJsonMaybeGz } = require('./read-json-maybe-gz');

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readCitiesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    const err = new Error(`cities file not found: ${filePath}`);
    err.code = 'ENOENT';
    throw err;
  }

  const cities = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);

  if (cities.length === 0) {
    const err = new Error(`cities file is empty: ${filePath}`);
    err.code = 'EEMPTY';
    throw err;
  }

  return cities;
}

function normalizeRequiredYears(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((year) => Number.parseInt(String(year), 10)))].filter(
    Number.isInteger
  );
}

function validateFeatureCollection(json, options) {
  const opts = options || {};
  const minFeatures = Number.isFinite(opts.minFeatures) ? opts.minFeatures : 0;
  const requiredYears = normalizeRequiredYears(opts.requiredYears);
  const errors = [];

  if (!json || json.type !== 'FeatureCollection') {
    errors.push('Not a GeoJSON FeatureCollection');
    return { ok: false, featureCount: null, errors };
  }

  if (!Array.isArray(json.features)) {
    errors.push('GeoJSON FeatureCollection.features is not an array');
    return { ok: false, featureCount: null, errors };
  }

  const featureCount = json.features.length;
  if (featureCount < minFeatures) {
    errors.push(`GeoJSON features.length ${featureCount} is below required minimum ${minFeatures}`);
  }

  if (requiredYears.length > 0) {
    const availableYears = new Set(
      json.features
        .map((feature) => Number.parseInt(String(feature?.properties?.year), 10))
        .filter(Number.isInteger)
    );
    const missingYears = requiredYears.filter((year) => !availableYears.has(year));
    if (missingYears.length > 0) {
      errors.push(`GeoJSON is missing required accident years: ${missingYears.join(', ')}`);
    }
  }

  return {
    ok: errors.length === 0,
    featureCount,
    errors,
  };
}

function validateGeoJsonArtifact(logicalPath, options) {
  const opts = options || {};
  const mode = opts.gzipOnly ? 'gzip-only' : 'raw-ok';

  let json;
  try {
    json = readJsonMaybeGz(logicalPath, { mode });
  } catch (error) {
    return {
      ok: false,
      featureCount: null,
      errors: [error.message],
    };
  }

  return validateFeatureCollection(json, {
    minFeatures: opts.minFeatures,
    requiredYears: opts.requiredYears,
  });
}

module.exports = {
  slugify,
  readCitiesFile,
  normalizeRequiredYears,
  validateFeatureCollection,
  validateGeoJsonArtifact,
};
