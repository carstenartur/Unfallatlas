'use strict';

/**
 * Lädt stadt-spezifische Maßnahmenerweiterungen aus
 *   templates/measures_<citySlug>.json
 *
 * und kombiniert sie mit dem Basiskatalog.  Das spiegelt das bestehende
 * Muster für Gremien (`templates/gremien_<slug>.json`).
 *
 * Datei-Format (JSON):
 *   {
 *     "measures": [
 *       {
 *         "id": "qw_xy",
 *         "title": "...",
 *         "category": "quickWin",
 *         "targetAccidentTypes": ["bike_car"],
 *         "implementationEffort": "low",
 *         "costBand": "low",
 *         "description": "..."
 *       }
 *     ]
 *   }
 *
 * Verhalten:
 *   - existiert keine Datei → Basiskatalog unverändert
 *   - gleiche `id` wie im Basiskatalog → Stadt-Eintrag überschreibt Basis (Override)
 *   - neue `id` → wird angefügt
 *   - ungültige Einträge werden ausgefiltert (Validierung wie in measureCatalog)
 *
 * Cached pro citySlug, damit das File-IO nicht bei jedem Request anfällt.
 *
 * @module server/ai/catalog/cityMeasureCatalog
 */

const fs   = require('fs');
const path = require('path');
const { MEASURE_CATALOG } = require('./measureCatalog.js');

const VALID_CATEGORIES = ['quickWin', 'infrastructure', 'organizational', 'monitoring'];
const VALID_BANDS      = ['low', 'medium', 'high'];

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATES_DIR = path.join(ROOT, 'templates');

/** @type {Map<string, Array<object>>} cached merged catalogs per slug ('' = base) */
const cache = new Map();

/**
 * Liefert den Maßnahmenkatalog – ggf. erweitert um stadt-spezifische Einträge.
 *
 * @param {string} [citySlug]  z. B. "hannover", "berlin"; leer/undefined → Basis
 * @returns {Array<object>}
 */
function getCatalogForCity(citySlug) {
  const slug = normalizeSlug(citySlug);
  if (cache.has(slug)) return cache.get(slug);

  if (!slug) {
    const arr = [...MEASURE_CATALOG];
    cache.set('', arr);
    return arr;
  }

  const file = path.join(TEMPLATES_DIR, `measures_${slug}.json`);
  let cityMeasures = [];
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.measures)) {
        cityMeasures = obj.measures.filter(isValidMeasure);
      }
    }
  } catch (_) {
    cityMeasures = [];
  }

  // Merge: city overrides base by id, then append new
  const byId = new Map(MEASURE_CATALOG.map(m => [m.id, m]));
  for (const m of cityMeasures) byId.set(m.id, m);
  const merged = [...byId.values()];
  cache.set(slug, merged);
  return merged;
}

/** Test-Hilfsfunktion: Cache leeren (nur intern verwendet). */
function _clearCache() { cache.clear(); }

function normalizeSlug(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function isValidMeasure(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.id !== 'string' || !m.id) return false;
  if (typeof m.title !== 'string' || !m.title) return false;
  if (!VALID_CATEGORIES.includes(m.category)) return false;
  if (!VALID_BANDS.includes(m.implementationEffort)) return false;
  if (!VALID_BANDS.includes(m.costBand)) return false;
  if (!Array.isArray(m.targetAccidentTypes)) return false;
  if (typeof m.description !== 'string') return false;
  return true;
}

module.exports = { getCatalogForCity, _clearCache };
