'use strict';

/**
 * Einheitliche Fehler-/Antwort-Struktur für die optionalen Server-Features.
 *
 * Bisher hat jeder Endpunkt eigene `{ error: '…' }`-Antworten geliefert.  Das
 * Frontend kann damit zwar arbeiten, hat aber Schwierigkeiten, zwischen
 * "Feature nicht verfügbar" (graceful degradation, UI ausgrauen) und
 * "kurzfristiger Upstream-Fehler" (Retry sinnvoll) zu unterscheiden.
 *
 * Diese kleine Helfer-Schicht ergänzt jede Fehlerantwort um zwei zusätzliche
 * Felder und lässt das bestehende `error`-Feld aus Kompatibilitätsgründen
 * unverändert:
 *
 *   {
 *     error:    "Klartext für UI-Toasts",
 *     code:     "FEATURE_UNAVAILABLE",
 *     category: "feature_unavailable"
 *   }
 *
 * Damit kann das Frontend nach wie vor `body.error` anzeigen, aber zusätzlich
 * pro `category` reagieren.
 *
 * @module server/lib/errors
 */

/**
 * Maschinenlesbare Kategorien.  Bewusst flach gehalten.
 *
 * @readonly
 * @enum {string}
 */
const CATEGORIES = Object.freeze({
  FEATURE_UNAVAILABLE: 'feature_unavailable',
  UPSTREAM_ERROR:      'upstream_error',
  INVALID_REQUEST:     'invalid_request',
  INTERNAL_ERROR:      'internal_error',
  RATE_LIMITED:        'rate_limited',
  FALLBACK_RETURNED:   'fallback_returned'
});

/**
 * Standard-HTTP-Statuscodes pro Kategorie (Empfehlung; Aufrufer kann
 * überschreiben).
 */
const DEFAULT_STATUS = Object.freeze({
  [CATEGORIES.FEATURE_UNAVAILABLE]: 503,
  [CATEGORIES.UPSTREAM_ERROR]:      502,
  [CATEGORIES.INVALID_REQUEST]:     400,
  [CATEGORIES.INTERNAL_ERROR]:      500,
  [CATEGORIES.RATE_LIMITED]:        429,
  [CATEGORIES.FALLBACK_RETURNED]:   200
});

/**
 * Erzeugt ein einheitliches Fehler-Body-Objekt.  Wird vom HTTP-Layer
 * verwendet, lässt sich aber auch für interne Fehlerketten nutzen.
 *
 * @param {object} args
 * @param {string} args.category   – einer der CATEGORIES-Werte
 * @param {string} args.code       – kurzer maschinenlesbarer Schlüssel
 *                                    (z. B. "AI_NOT_CONFIGURED")
 * @param {string} args.message    – Klartext für UI/Logs
 * @param {object} [args.details]  – optionale Zusatzinfos
 * @returns {{ error: string, code: string, category: string, details?: object }}
 */
function buildErrorBody({ category, code, message, details } = {}) {
  const cat = CATEGORIES[category] || category || CATEGORIES.INTERNAL_ERROR;
  const validCategory = Object.values(CATEGORIES).includes(cat)
    ? cat
    : CATEGORIES.INTERNAL_ERROR;

  /** @type {{error:string,code:string,category:string,details?:object}} */
  const body = {
    error:    String(message || 'Unbekannter Fehler.'),
    code:     String(code || 'UNKNOWN'),
    category: validCategory
  };
  if (details && typeof details === 'object') body.details = details;
  return body;
}

/**
 * Schreibt eine standardisierte Fehlerantwort und gibt sie zurück.
 * Verwendet `DEFAULT_STATUS[category]`, wenn `status` nicht angegeben.
 *
 * @param {import('express').Response} res
 * @param {object} args
 * @param {number} [args.status]
 * @param {string}  args.category
 * @param {string}  args.code
 * @param {string}  args.message
 * @param {object} [args.details]
 * @returns {import('express').Response}
 */
function sendError(res, args = {}) {
  const status = Number.isFinite(args.status)
    ? args.status
    : (DEFAULT_STATUS[args.category] || 500);
  return res.status(status).json(buildErrorBody(args));
}

/**
 * Spezielle Variante: erfolgreicher Response, aber semantisch ein Fallback
 * (z. B. KI-Fallback ohne API-Key).  Ergänzt das Antwortobjekt zusätzlich um
 * eine `fallback`-Beschreibung, ohne bestehende Felder zu verändern.
 *
 * @template T
 * @param {T & object}            payload    – ursprüngliche Erfolgs­antwort
 * @param {{code: string, message: string, details?: object}} info
 * @returns {T & {fallback: { code: string, message: string, category: string, details?: object }}}
 */
function attachFallbackInfo(payload, info) {
  const out = Object.assign({}, payload || {});
  out.fallback = {
    code:     String(info?.code     || 'FALLBACK'),
    message:  String(info?.message  || 'Fallback wurde verwendet.'),
    category: CATEGORIES.FALLBACK_RETURNED
  };
  if (info?.details && typeof info.details === 'object') {
    out.fallback.details = info.details;
  }
  return out;
}

module.exports = {
  CATEGORIES,
  DEFAULT_STATUS,
  buildErrorBody,
  sendError,
  attachFallbackInfo
};
