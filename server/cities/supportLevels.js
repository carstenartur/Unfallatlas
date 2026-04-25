'use strict';

/**
 * Support-Level-Modell für Städte/Regionen.
 *
 * Drei orthogonale Stufen, die unabhängig voneinander pro Ort
 * vorhanden sein können:
 *
 *  - **A (Unfallanalyse)**       – die Werkbank kann für diesen Ort
 *                                  Unfallpunkte aus dem amtlichen
 *                                  Unfallatlas darstellen, filtern und
 *                                  exportieren.  Das ist die Basisstufe;
 *                                  jede Stadt mit Daten im Unfallatlas
 *                                  zwischen 2016 und 2024 erfüllt sie
 *                                  potentiell.
 *  - **B (Politische Recherche)**– zusätzlich existiert ein angebundener
 *                                  Provider zur Recherche politischer
 *                                  Vorgänge (Anträge, Anfragen, Beschlüsse)
 *                                  in einem Ratsinformationssystem.
 *  - **C (Persistenz/Batch)**    – Maßnahmen-Steckbriefe, Priorisierungen
 *                                  und Batch-Rankings stehen für diesen
 *                                  Ort über den separaten Analysis-Service
 *                                  zur Verfügung (Top-N, Persistenz,
 *                                  scheduled jobs).
 *
 * Pro Stadt wird im Katalog jede Stufe als `'supported'`,
 * `'partially_supported'` oder `'unsupported'` ausgewiesen.  Damit
 * können API und UI transparent kommunizieren, was an einem konkreten
 * Ort verfügbar ist – ohne dass eine Stadt erst „komplett" sein muss,
 * um überhaupt im Produkt erscheinen zu dürfen.
 *
 * @module server/cities/supportLevels
 */

/**
 * Bezeichner der drei Support-Stufen.  Werden in API-Antworten und
 * UI-Texten verwendet und sind Bestandteil des stabilen Vertrags.
 *
 * @readonly
 * @enum {string}
 */
const SUPPORT_LEVELS = Object.freeze({
  A: 'supportLevelA',
  B: 'supportLevelB',
  C: 'supportLevelC'
});

/**
 * Mögliche Support-Status pro Stufe.  Bewusst klein gehalten: das
 * Frontend kann darauf abbilden, ohne sich mit Freitext beschäftigen
 * zu müssen.
 *
 *  - `supported`           – vollständig nutzbar
 *  - `partially_supported` – Teilfunktionen verfügbar (z. B. nur eine
 *                            Sub-Region, eingeschränkter Datenstand,
 *                            experimenteller Provider)
 *  - `unsupported`         – nicht verfügbar
 *
 * @readonly
 * @enum {string}
 */
const SUPPORT_STATUS = Object.freeze({
  SUPPORTED:           'supported',
  PARTIALLY_SUPPORTED: 'partially_supported',
  UNSUPPORTED:         'unsupported'
});

/** Erlaubte Werte – für Validierung im Registry-Loader. */
const VALID_STATUSES = Object.freeze(Object.values(SUPPORT_STATUS));

/**
 * Mapping Support-Stufe → Property im Stadt-Eintrag.
 * @readonly
 */
const LEVEL_FIELD = Object.freeze({
  [SUPPORT_LEVELS.A]: 'accidentDataSupport',
  [SUPPORT_LEVELS.B]: 'politicalContextSupport',
  [SUPPORT_LEVELS.C]: 'analysisServiceSupport'
});

/**
 * Liefert den Status einer Stadt für eine konkrete Support-Stufe.
 *
 * @param {object} city  – Stadt-Eintrag aus dem Katalog
 * @param {string} level – einer der `SUPPORT_LEVELS`-Werte
 * @returns {string}     – einer der `SUPPORT_STATUS`-Werte
 */
function getStatus(city, level) {
  if (!city || typeof city !== 'object') return SUPPORT_STATUS.UNSUPPORTED;
  const field = LEVEL_FIELD[level];
  if (!field) return SUPPORT_STATUS.UNSUPPORTED;
  const v = city[field];
  return VALID_STATUSES.includes(v) ? v : SUPPORT_STATUS.UNSUPPORTED;
}

/**
 * Bequemer Boolean-Check: gilt eine Stadt für eine Stufe als nutzbar?
 * Sowohl `supported` als auch `partially_supported` zählen als „hat
 * Support" – für strikte Prüfung bitte `getStatus` direkt vergleichen.
 *
 * @param {object} city
 * @param {string} level
 * @returns {boolean}
 */
function hasSupport(city, level) {
  const s = getStatus(city, level);
  return s === SUPPORT_STATUS.SUPPORTED || s === SUPPORT_STATUS.PARTIALLY_SUPPORTED;
}

/**
 * Liefert ein kompaktes Objekt, das pro Stufe direkt den Status
 * benennt.  Nützlich für API-Antworten und Capability-Anzeige.
 *
 * @param {object} city
 * @returns {{supportLevelA:string, supportLevelB:string, supportLevelC:string}}
 */
function describeSupport(city) {
  return {
    [SUPPORT_LEVELS.A]: getStatus(city, SUPPORT_LEVELS.A),
    [SUPPORT_LEVELS.B]: getStatus(city, SUPPORT_LEVELS.B),
    [SUPPORT_LEVELS.C]: getStatus(city, SUPPORT_LEVELS.C)
  };
}

module.exports = {
  SUPPORT_LEVELS,
  SUPPORT_STATUS,
  VALID_STATUSES,
  LEVEL_FIELD,
  getStatus,
  hasSupport,
  describeSupport
};
