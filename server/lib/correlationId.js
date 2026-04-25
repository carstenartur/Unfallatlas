'use strict';

/**
 * Correlation-ID-Middleware für den Express-Server.
 *
 * Zweck:
 *  - Jede Anfrage erhält eine stabile Korrelations-ID, die in Logs und im
 *    Antwort-Header sichtbar ist und – beim Aufruf des Analysis Service –
 *    als Header weitergereicht werden kann.  Damit lassen sich Vorgänge
 *    aus UI, Node-Server und Spring-Boot-Service über das gleiche Token
 *    nachverfolgen, ohne dass Nutzer-Eingaben in Logs landen.
 *
 *  - Das Modul ist bewusst **abhängigkeitsfrei** (kein `uuid`-Paket): die
 *    erzeugten IDs sind 16 Hex-Zeichen lang (8 Byte Zufall) und werden
 *    ausschließlich für Tracing/Logging verwendet, nicht als Sicherheits­
 *    Token.  Aus `crypto.randomBytes` gewonnen, also kryptographisch
 *    stark genug für diesen Zweck.
 *
 *  - Zusätzlich legt die Middleware die ID in einem
 *    {@link AsyncLocalStorage}-Kontext ab, damit nachgelagerter Code
 *    (z. B. der Forwarder zum Analysis Service) sie ohne explizites
 *    Durchreichen lesen und als Header weiterreichen kann.
 *
 * Verwendung:
 *   const { correlationIdMiddleware, HEADER_NAME, getCurrentCorrelationId }
 *     = require('./lib/correlationId');
 *   app.use(correlationIdMiddleware());
 *   ...
 *   const id = getCurrentCorrelationId(); // innerhalb des Anfrage-Kontexts
 *
 * Vertrag:
 *  - Eingehender Header `X-Correlation-Id` wird übernommen, sofern er dem
 *    Whitelisting-Muster (`/^[A-Za-z0-9._:-]{4,128}$/`) entspricht – sonst
 *    wird er verworfen und eine neue ID generiert.  Dies verhindert, dass
 *    Clients beliebige Strings in Logs schmuggeln (Log-Injection).
 *  - `req.correlationId` und `res.locals.correlationId` werden gesetzt.
 *  - Der Antwort-Header `X-Correlation-Id` wird gespiegelt.
 *
 * @module server/lib/correlationId
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

/** Header-Name (Pascal-Case in Logs, Express normalisiert eingehend zu lower-case). */
const HEADER_NAME = 'X-Correlation-Id';

/**
 * Erlaubte Zeichen in einer eingehenden Korrelations-ID.  Bewusst eng
 * gefasst (alphanumerisch + `. _ : -`), damit eingehende Header nicht
 * als Vehikel für Log-Injection oder Header-Smuggling dienen können.
 *
 * @type {RegExp}
 */
const ID_PATTERN = /^[A-Za-z0-9._:-]{4,128}$/;

/**
 * Per-Anfrage-Kontext (Node `async_hooks`).  Der gespeicherte Wert ist
 * die aktuelle Korrelations-ID als String.  Außerhalb eines `run()`-
 * Aufrufs liefert {@link getCurrentCorrelationId} `null`.
 *
 * @type {AsyncLocalStorage<string>}
 */
const correlationStorage = new AsyncLocalStorage();

/**
 * Erzeugt eine neue Korrelations-ID (16 Hex-Zeichen, kryptographisch stark).
 *
 * @returns {string}
 */
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Prüft, ob eine eingehende Korrelations-ID akzeptiert werden darf.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isAcceptableId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * Liefert die Korrelations-ID des aktuellen Async-Kontexts oder
 * {@code null}, wenn kein {@link AsyncLocalStorage}-Frame aktiv ist
 * (z. B. außerhalb einer Anfrage, oder wenn die Middleware nicht
 * gebunden ist).
 *
 * @returns {string|null}
 */
function getCurrentCorrelationId() {
  return correlationStorage.getStore() || null;
}

/**
 * Liefert eine Express-Middleware, die `req.correlationId` und den
 * Antwort-Header setzt.  Akzeptiert eine eingehende ID nur, wenn sie
 * dem Whitelisting-Muster entspricht – andernfalls wird eine neue
 * generiert.  Die Middleware ist idempotent: bei doppelter Verwendung
 * bleibt die zuvor gesetzte ID erhalten.
 *
 * Zusätzlich startet die Middleware einen {@link AsyncLocalStorage}-
 * Frame über die restliche Verarbeitung, damit
 * {@link getCurrentCorrelationId} aus tieferen Aufrufen ohne explizites
 * Durchreichen gelesen werden kann.
 *
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => void}
 */
function correlationIdMiddleware() {
  return function correlationIdHandler(req, res, next) {
    // Idempotent: wenn upstream-Middleware bereits eine ID gesetzt hat,
    // übernehmen wir sie unverändert.
    let id = req.correlationId;
    if (!id) {
      const incoming = req.get(HEADER_NAME);
      id = isAcceptableId(incoming) ? incoming : generateId();
    }
    req.correlationId = id;
    res.locals.correlationId = id;
    res.setHeader(HEADER_NAME, id);
    correlationStorage.run(id, () => next());
  };
}

module.exports = {
  HEADER_NAME,
  ID_PATTERN,
  generateId,
  isAcceptableId,
  getCurrentCorrelationId,
  correlationIdMiddleware
};

