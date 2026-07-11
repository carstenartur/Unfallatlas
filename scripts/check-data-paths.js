#!/usr/bin/env node
/**
 * scripts/check-data-paths.js
 *
 * Build-time validator: every city listed in cities.txt must have a
 * corresponding `out/output_all_years_<slug>.geojson` or `.geojson.gz` file.
 *
 * Failures:
 *   - Exit 2 if cities.txt is missing or empty.
 *   - Exit 1 if both .geojson and .geojson.gz are absent.
 *
 * Why this exists
 * ---------------
 * The data-generating workflows (generate-and-commit.yml, enrich.yml)
 * can silently succeed even when one city's GeoJSON was not produced
 * (e.g. due to a download timeout or a skipped converter step). Without
 * this gate the JavaScript would silently 404 at runtime for that city.
 *
 * Usage (from repo root):
 *   node scripts/check-data-paths.js
 *   node scripts/check-data-paths.js --warn   # print but do not fail
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');
const CITIES_TXT = path.join(ROOT, 'cities.txt');
const OUT_DIR    = path.join(ROOT, 'out');

// ── Slugify (mirrors convertAmt2gmaps.sh + ua.core.js normKey) ──────────────
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── Read cities ──────────────────────────────────────────────────────────────
if (!fs.existsSync(CITIES_TXT)) {
  console.error(`check-data-paths: cities.txt not found at ${CITIES_TXT}`);
  process.exit(2);
}

const cities = fs.readFileSync(CITIES_TXT, 'utf8')
  .split('\n')
  .map(l => l.replace(/#.*$/, '').trim())  // strip comments
  .filter(Boolean);

if (cities.length === 0) {
  console.error('check-data-paths: cities.txt is empty');
  process.exit(2);
}

// ── Check expected files ─────────────────────────────────────────────────────
const warnOnly = process.argv.includes('--warn');

const missing = [];
for (const city of cities) {
  const slug = slugify(city);
  // Accept either the raw .geojson or its .gz counterpart; in production
  // workflows gzip-static-data.js normalises everything to .geojson.gz.
  const rawPath = path.join(OUT_DIR, `output_all_years_${slug}.geojson`);
  const gzPath  = path.join(OUT_DIR, `output_all_years_${slug}.geojson.gz`);
  if (!fs.existsSync(rawPath) && !fs.existsSync(gzPath)) {
    missing.push({ city, slug, expected: `out/output_all_years_${slug}.geojson[.gz]` });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`check-data-paths: checked ${cities.length} cities from cities.txt`);

if (missing.length === 0) {
  console.log('check-data-paths: all expected GeoJSON files are present ✓');
  process.exit(0);
}

console.error(`check-data-paths: ${missing.length} missing GeoJSON file(s):`);
for (const { city, expected } of missing) {
  console.error(`  - ${city} → ${expected}`);
}

if (warnOnly) {
  console.warn('check-data-paths: running in --warn mode; not failing the build.');
  process.exit(0);
}

process.exit(1);
