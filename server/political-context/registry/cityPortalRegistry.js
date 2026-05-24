'use strict';

/**
 * Registry: Stadt → Portal-Provider
 *
 * Jeder Eintrag verknüpft einen (normalisierten) Stadtnamen mit dem
 * passenden Provider-Modul.
 *
 * @module server/political-context/registry/cityPortalRegistry
 */

const hannoverSimProvider     = require('../providers/hannoverSimProvider.js');
const berlinAllrisProvider    = require('../providers/berlinAllrisProvider.js');
const bonnAllrisProvider      = require('../providers/bonnAllrisProvider.js');
const hamburgParldokProvider  = require('../providers/hamburgParldokProvider.js');
const { createSessionNetProvider } = require('../providers/sessionNetProvider.js');

const cityRegistry      = require('../../cities/cityRegistry.js');
const { SUPPORT_LEVELS, SUPPORT_STATUS, getStatus } =
  require('../../cities/supportLevels.js');

/**
 * Konfiguration der per generischem SessionNet-Provider angebundenen Städte.
 *
 * WICHTIG:
 * Die Recherche-Endpunkte unterscheiden sich je Installation deutlich.
 * Die Pfade unten wurden anhand real erreichbarer Recherche-/Trefferseiten
 * überprüft und nicht nur aus der Portal-Startseite abgeleitet.
 */
const SESSIONNET_CITIES = Object.freeze([
  {
    cityKey: 'bielefeld',
    providerKey: 'bielefeld-sessionnet',
    baseUrl: 'https://anwendungen.bielefeld.de',
    // Portal nutzt recherche.asp / suchen01.asp statt klassischem yw010.asp
    searchPath: '/bi/suchen01.asp',
    searchParams: { smcrecherche: '7020' }
  },
  {
    cityKey: 'chemnitz',
    providerKey: 'chemnitz-sessionnet',
    baseUrl: 'https://sessionnet.owl-it.de',
    // noch nicht vollständig validiert → konservativ beim alten Pfad bleiben
    searchPath: '/chemnitz/bi/yw010.asp'
  },
  {
    cityKey: 'halle_saale',
    providerKey: 'halle-sessionnet',
    baseUrl: 'https://buergerinfo.halle.de',
    // reale Recherchepfade wirken installation-spezifisch;
    // aktueller Pfad noch nicht sicher widerlegt
    searchPath: '/bi/yw010.asp'
  },
  {
    cityKey: 'magdeburg',
    providerKey: 'magdeburg-sessionnet',
    baseUrl: 'https://ratsinfo.magdeburg.de',
    // Magdeburg verwendet Pfade ohne /bi/
    searchPath: '/yw010.asp'
  },
  {
    cityKey: 'nuernberg',
    providerKey: 'nuernberg-sessionnet',
    baseUrl: 'https://online-service2.nuernberg.de',
    // reales Rechercheportal nutzt suchen01.asp
    searchPath: '/buergerinfo/suchen01.asp',
    searchParams: { smcrecherche: '7020' }
  }
]);

/** @type {Map<string, object>} */
const REGISTRY = new Map([
  ['hannover', hannoverSimProvider],
  ['berlin',   berlinAllrisProvider],
  ['bonn',     bonnAllrisProvider],
  ['hamburg',  hamburgParldokProvider],
  ...SESSIONNET_CITIES.map((cfg) => [cfg.cityKey, createSessionNetProvider(cfg)])
]);

function normalizeCity(city) {
  if (!city || typeof city !== 'string') return '';
  return city
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getProviderForCity(city) {
  const provider = getProviderForCityRaw(city);
  if (!provider) return null;

  let catalogCity = null;
  try {
    catalogCity = cityRegistry.findCity(city);
  } catch (_) { /* Katalog nicht verfügbar */ }

  if (catalogCity) {
    const status = getStatus(catalogCity, SUPPORT_LEVELS.B);
    if (status === SUPPORT_STATUS.UNSUPPORTED) return null;
  }

  return provider;
}

function getProviderForCityRaw(city) {
  const key = normalizeCity(city);
  return REGISTRY.get(key) || null;
}

function listSupportedCities() {
  return [...REGISTRY.keys()];
}

module.exports = {
  getProviderForCity,
  getProviderForCityRaw,
  listSupportedCities,
  normalizeCity
};
