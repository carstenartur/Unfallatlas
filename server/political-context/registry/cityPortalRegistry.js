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

const hannoverSimProvider     = require('../providers/hannoverSimProvider.js');
const berlinAllrisProvider    = require('../providers/berlinAllrisProvider.js');
const bonnAllrisProvider      = require('../providers/bonnAllrisProvider.js');
const hamburgParldokProvider  = require('../providers/hamburgParldokProvider.js');

// Zentraler Städte-/Regionen-Katalog: Quelle der Wahrheit für die
// Frage „welche Orte hat das Produkt überhaupt im Visier und was ist
// für sie als ‚politische Recherche' versprochen?".  Die Portal-Provider
// liefern weiterhin das *Wie* (HTTP-Aufrufe, Parsing); der Katalog
// liefert das *Ob* und das *Was* pro Stadt.
const cityRegistry      = require('../../cities/cityRegistry.js');
const { SUPPORT_LEVELS, SUPPORT_STATUS, getStatus } =
  require('../../cities/supportLevels.js');

/**
 * Lokale JSDoc-Typen für die Provider-Schnittstelle.
 *
 * Frühere Versionen referenzierten `import('../services/portalSearchService').SearchParams`
 * und `RawProviderResult`; letzteres ist dort nicht definiert und ersteres
 * nicht exportiert, was zu kaputten Type-Hints führte.  Wir definieren die
 * benötigten Typen hier lokal.
 *
 * @typedef {object} ProviderSearchParams
 * @property {string}   [city]         – Stadtname
 * @property {string[]} [searchTerms]  – Suchbegriffe (je ein HTTP-Request)
 * @property {object}   [context]      – optionaler Kontext (Gremium, Ort …)
 *
 * @typedef {object} ProviderRawResult
 * @property {string}      title
 * @property {string}      url
 * @property {string|null} [date]
 * @property {string|null} [gremium]
 * @property {string|null} [number]
 * @property {string|null} [snippet]
 * @property {string}      [rawType]
 *
 * @typedef {object} PoliticalContextProvider
 * @property {string}                                                [_key]         Provider-Kürzel (z. B. `hannover-sim`)
 * @property {function(string): boolean}                             supportsCity
 * @property {function(ProviderSearchParams): Promise<ProviderRawResult[]>} search
 */

/** @type {Map<string, PoliticalContextProvider>} */
const REGISTRY = new Map([
  ['hannover', hannoverSimProvider],
  ['berlin',   berlinAllrisProvider],
  ['bonn',     bonnAllrisProvider],
  ['hamburg',  hamburgParldokProvider]
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
 * Die Auswahl ist an den zentralen Städte-Katalog gekoppelt: existiert
 * für die Stadt ein Katalog-Eintrag, wird der Provider nur dann
 * ausgeliefert, wenn ihr `politicalContextSupport` nicht explizit
 * `'unsupported'` ist.  Damit lässt sich politische Recherche pro Ort
 * deaktivieren, ohne den Provider physisch zu entfernen (z. B. bei
 * Portal-Wartungsarbeiten oder bekannten Datenproblemen).
 *
 * Fehlt dagegen ein Katalog-Eintrag oder ist der Katalog nicht
 * verfügbar, bleibt die Funktion aus Kompatibilitätsgründen beim
 * bisherigen Fallback-Verhalten und gibt den per Registry aufgelösten
 * Provider zurück.
 *
 * Aufrufer, die einen Provider ohne Katalog-Gating brauchen (Tests,
 * Migrationen), können direkt {@link getProviderForCityRaw} verwenden.
 *
 * @param {string} city
 * @returns {PoliticalContextProvider|null}
 */
function getProviderForCity(city) {
  const provider = getProviderForCityRaw(city);
  if (!provider) return null;

  // Katalog-Gate: politische Recherche ist nur erlaubt, wenn der
  // zentrale Katalog die Stadt mindestens als „partially_supported"
  // ausweist.  Fehlt der Eintrag (z. B. weil der Katalog gerade nicht
  // geladen werden kann), bleiben wir aus Kompatibilitätsgründen
  // großzügig und geben den Provider zurück – das alte Verhalten.
  let catalogCity = null;
  try {
    catalogCity = cityRegistry.findCity(city);
  } catch (_) { /* Katalog nicht verfügbar – Provider durchreichen */ }
  if (catalogCity) {
    const status = getStatus(catalogCity, SUPPORT_LEVELS.B);
    if (status === SUPPORT_STATUS.UNSUPPORTED) return null;
  }
  return provider;
}

/**
 * Direkter Provider-Lookup ohne Katalog-Gating – Provider-Auflösung
 * rein nach Stadtname.  Vor allem für interne Tests und Migrationen
 * gedacht.
 *
 * @param {string} city
 * @returns {PoliticalContextProvider|null}
 */
function getProviderForCityRaw(city) {
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

module.exports = { getProviderForCity, getProviderForCityRaw, listSupportedCities, normalizeCity };
