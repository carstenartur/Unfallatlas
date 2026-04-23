'use strict';

/**
 * Provider-Abstraktion für KI-Aufrufe.
 *
 * Auswahl über Umgebungsvariable `AI_PROVIDER`:
 *   - `gemini` (Standard)  → `geminiStructuredProvider.callStructuredGemini`
 *   - `null`               → wirft sofort einen RetryableError (keine Netzanfrage),
 *                             nützlich für Tests und „dry mode" ohne Token-Verbrauch.
 *
 * Folge-PR-fähig: ein neuer Provider lässt sich registrieren, indem unten
 * eine weitere Funktion mit der gemeinsamen Signatur ergänzt wird:
 *
 *   ({ system, user, responseSchema, temperature, maxRetries }) => Promise<string>
 *
 * Die Funktion muss einen rohen JSON-Antworttext zurückgeben.
 *
 * @module server/ai/providers/index
 */

const { callStructuredGemini, RetryableError, FatalError } =
  require('./geminiStructuredProvider.js');

/**
 * Stub-Provider, der nichts aufruft. Liefert einen RetryableError, sodass die
 * Service-Schicht ihren deterministischen Fallback ziehen kann.
 */
async function callNullProvider() {
  throw new RetryableError('AI_PROVIDER=null: kein KI-Aufruf konfiguriert.');
}

const PROVIDERS = Object.freeze({
  gemini: callStructuredGemini,
  'null': callNullProvider
});

/**
 * Liefert die Provider-Funktion gemäß Konfiguration.
 *
 * @param {string} [name]   override; sonst process.env.AI_PROVIDER, sonst 'gemini'
 * @returns {Function}
 */
function getProvider(name) {
  const key = String(name || process.env.AI_PROVIDER || 'gemini').toLowerCase();
  return PROVIDERS[key] || PROVIDERS.gemini;
}

/** Liefert den kanonischen Namen des aktiven Providers. */
function activeProviderName() {
  const key = String(process.env.AI_PROVIDER || 'gemini').toLowerCase();
  return PROVIDERS[key] ? key : 'gemini';
}

module.exports = {
  getProvider,
  activeProviderName,
  PROVIDERS,
  RetryableError,
  FatalError
};
