'use strict';

/**
 * Registry: Stadt → Portal-Provider
 *
 * Jeder Eintrag verknüpft einen (normalisierten) Stadtnamen mit dem
 * passenden Provider-Modul. Neue Städte können hier ergänzt werden, ohne
 * andere Teile des Systems zu verändern.
 *
 * Schlüssel: normalisierter Stadtschlüssel (Kleinbuchstaben, Umlaute →
 *   ae/oe/ue/ss, Leerzeichen/Sonderzeichen → '_', führende/folgende '_'
 *   entfernt) – identisch zur UA.normKey-Logik im Frontend.
 *
 * @module server/political-context/registry/cityPortalRegistry
 */

const hannoverSimProvider = require('../providers/hannoverSimProvider.js');

/**
 * @typedef {object} PoliticalContextProvider
 * @property {function(string): boolean}             supportsCity
 * @property {function(import('../services/portalSearchService').SearchParams): Promise<import('../services/portalSearchService').RawProviderResult[]>} search
 */

/** @type {Map<string, PoliticalContextProvider>} */
const REGISTRY = new Map([
  ['hannover', hannoverSimProvider]
]);

/**
 * Normalisiert einen Stadtnamen auf einen Registry-Schlüssel.
 * Identisch zur UA.normKey-Logik (js/ua.core.js:54-62).
 *
 * @param {string} city
 * @returns {string}
 */
function normalizeCity(city) {
  if (!city || typeof city !== 'string') return '';
  return city
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Gibt den Provider für eine Stadt zurück oder null, wenn keine
 * Unterstützung vorliegt.
 *
 * @param {string} city
 * @returns {PoliticalContextProvider|null}
 */
function getProviderForCity(city) {
  const key = normalizeCity(city);
  return REGISTRY.get(key) || null;
}

/**
 * Gibt alle registrierten Stadtschlüssel zurück.
 *
 * @returns {string[]}
 */
function listSupportedCities() {
  return [...REGISTRY.keys()];
}

module.exports = { getProviderForCity, listSupportedCities, normalizeCity };
