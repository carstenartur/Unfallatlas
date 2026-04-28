'use strict';

/**
 * Strukturierter Gemini-Provider mit Retry/Backoff.
 *
 * Unterschiede zum v1-Provider (`geminiProvider.js`):
 *   - akzeptiert ein optionales `responseSchema` (Gemini Structured Output)
 *   - nutzt zwingend `responseMimeType: application/json`
 *   - implementiert Retry mit exponential backoff bei
 *     5xx (transient), Netz-Timeouts
 *   - 429 (rate limit) wird getrennt behandelt: kein Retry per Default,
 *     separate Konfiguration über AI_ASSESSMENT_RATELIMIT_RETRIES
 *   - unterscheidet wiederholbare, rate-limited und endgültige Fehler
 *
 * Konfiguration (Umgebungsvariablen):
 *   GEMINI_API_KEY                    – Pflicht
 *   AI_ASSESSMENT_MODEL               – Standard: gemini-2.0-flash
 *   AI_ASSESSMENT_TIMEOUT_MS          – Standard: 30000
 *   AI_ASSESSMENT_MAX_RETRIES         – Standard: 2 (bis zu 3 Versuche bei 5xx/Timeout)
 *   AI_ASSESSMENT_RATELIMIT_RETRIES   – Standard: 0 (kein Retry bei 429)
 *   AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS – Standard: 60000 (60 s Mindestwartezeit bei 429-Retry)
 *
 * @module server/ai/providers/geminiStructuredProvider
 */

const https = require('https');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Hard-Cap für Retry-After-Werte, um endlose Hänger zu vermeiden (5 Minuten). */
const RATE_LIMIT_DELAY_HARD_CAP_MS = 5 * 60 * 1000;

class RetryableError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.retryable = true;
  }
}

class FatalError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

/**
 * Wird geworfen, wenn die Gemini-API HTTP 429 zurückgibt.
 * Enthält optional die vom Server empfohlene Wartezeit in Millisekunden.
 */
class RateLimitError extends RetryableError {
  /**
   * @param {string} message
   * @param {number} [retryAfterMs] – vom Server empfohlene Wartezeit in ms (optional)
   */
  constructor(message, retryAfterMs) {
    super(message, 429);
    this.rateLimit = true;
    this.retryAfterMs = typeof retryAfterMs === 'number' ? retryAfterMs : undefined;
  }
}

/**
 * Sendet System+User Prompt an Gemini und gibt den Antworttext zurück.
 *
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} [args.responseSchema]    – optional, JSON-Schema-Subset (Gemini-Format)
 * @param {number} [args.temperature]       – Standard 0.2
 * @param {number} [args.maxRetries]        – Standard aus Env (AI_ASSESSMENT_MAX_RETRIES)
 * @returns {Promise<string>}                 – roher JSON-String
 */
async function callStructuredGemini({ system, user, responseSchema, temperature, maxRetries } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new FatalError('GEMINI_API_KEY ist nicht konfiguriert.', 0);
  }
  if (!user || typeof user !== 'string') {
    throw new FatalError('Benutzerprompt fehlt oder ist ungültig.', 0);
  }

  const model           = process.env.AI_ASSESSMENT_MODEL     || 'gemini-2.0-flash';
  const timeoutMs       = Number(process.env.AI_ASSESSMENT_TIMEOUT_MS) || 30_000;
  const retries         = Number.isFinite(maxRetries) ? maxRetries
                         : (Number(process.env.AI_ASSESSMENT_MAX_RETRIES) || 2);
  const rlRetries       = Number(process.env.AI_ASSESSMENT_RATELIMIT_RETRIES) || 0;
  const rlMinDelayMs    = Number(process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS) || 60_000;
  const temp            = Number.isFinite(temperature) ? temperature : 0.2;

  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const generationConfig = {
    temperature: temp,
    responseMimeType: 'application/json'
  };
  if (responseSchema && typeof responseSchema === 'object') {
    generationConfig.responseSchema = responseSchema;
  }

  const body = JSON.stringify({
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig
  });

  let lastErr;
  let transientUsed  = 0;
  let rlUsed         = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const rawText = await httpPost(url, body, timeoutMs);
      const parsed  = JSON.parse(rawText);
      const text    = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string' || !text.trim()) {
        const reason = parsed?.candidates?.[0]?.finishReason || 'unknown';
        throw new RetryableError(`Gemini lieferte keine verwertbare Antwort (finishReason: ${reason}).`);
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (!err || !err.retryable) {
        throw err;
      }

      if (err.rateLimit) {
        // 429 Rate Limit – separate Retry-Konfiguration
        if (rlUsed >= rlRetries) {
          throw err;
        }
        rlUsed++;
        const hint = typeof err.retryAfterMs === 'number' ? err.retryAfterMs : rlMinDelayMs;
        const delay = Math.min(Math.max(hint, 0), RATE_LIMIT_DELAY_HARD_CAP_MS);
        console.log(`[gemini] 429 rate-limited, sleeping ${delay}ms before retry ${rlUsed}/${rlRetries}`);
        await sleep(delay);
      } else {
        // 5xx / Netz-/Timeout-Fehler – exponential backoff
        if (transientUsed >= retries) {
          throw err;
        }
        // Exponential backoff: 500ms, 1000ms, 2000ms ...
        const delay = 500 * Math.pow(2, transientUsed);
        transientUsed++;
        await sleep(delay);
      }
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpPost(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          resolve(text);
        } else if (status === 429) {
          reject(new RateLimitError(
            `Gemini-API 429: ${text.slice(0, 200)}`,
            parseRetryAfterMs(res.headers, text)
          ));
        } else if (status >= 500 && status < 600) {
          reject(new RetryableError(`Gemini-API ${status}: ${text.slice(0, 200)}`, status));
        } else {
          reject(new FatalError(`Gemini-API ${status}: ${text.slice(0, 200)}`, status));
        }
      });
      res.on('error', (e) => reject(new RetryableError(e.message)));
    });

    req.on('timeout', () => {
      req.destroy(new RetryableError(`Gemini-Anfrage Timeout nach ${timeoutMs} ms.`));
    });
    req.on('error', (e) => reject(new RetryableError(e.message)));

    req.write(body);
    req.end();
  });
}

/**
 * Liest den Retry-After-Hinweis aus Response-Header und/oder Body.
 *
 * Unterstützte Quellen:
 *   1. `Retry-After` Header (Sekunden als Integer oder HTTP-Datum)
 *   2. `error.details[*].retryDelay` im Body (Format `"<n>s"`)
 *
 * @param {object} headers – Node-HTTP-Response-Headers
 * @param {string} bodyText – roher Antwort-Text
 * @returns {number|undefined} Wartezeit in ms oder undefined
 */
function parseRetryAfterMs(headers, bodyText) {
  // 1. Retry-After Header
  const retryAfterHeader = headers && headers['retry-after'];
  if (retryAfterHeader) {
    const asSeconds = parseInt(retryAfterHeader, 10);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return asSeconds * 1000;
    }
    // HTTP-Date format
    const asDate = Date.parse(retryAfterHeader);
    if (Number.isFinite(asDate)) {
      const ms = asDate - Date.now();
      if (ms > 0) return ms;
      return 0;
    }
  }

  // 2. retryDelay in Body JSON (defensiv)
  try {
    const parsed = JSON.parse(bodyText);
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (typeof detail.retryDelay === 'string') {
          const match = detail.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
          if (match) {
            return Math.round(parseFloat(match[1]) * 1000);
          }
        }
      }
    }
  } catch (_) {
    // Body war kein gültiges JSON – ignorieren
  }

  return undefined;
}

module.exports = {
  callStructuredGemini,
  RetryableError,
  FatalError,
  RateLimitError
};
