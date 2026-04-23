'use strict';

/**
 * Strukturierter Gemini-Provider mit Retry/Backoff.
 *
 * Unterschiede zum v1-Provider (`geminiProvider.js`):
 *   - akzeptiert ein optionales `responseSchema` (Gemini Structured Output)
 *   - nutzt zwingend `responseMimeType: application/json`
 *   - implementiert Retry mit exponential backoff bei
 *     429 (rate limit), 5xx (transient), Netz-Timeouts
 *   - unterscheidet wiederholbare und endgültige Fehler
 *
 * Konfiguration (Umgebungsvariablen):
 *   GEMINI_API_KEY            – Pflicht
 *   AI_ASSESSMENT_MODEL       – Standard: gemini-2.0-flash
 *   AI_ASSESSMENT_TIMEOUT_MS  – Standard: 30000
 *   AI_ASSESSMENT_MAX_RETRIES – Standard: 2 (also bis zu 3 Versuche)
 *
 * @module server/ai/providers/geminiStructuredProvider
 */

const https = require('https');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
 * Sendet System+User Prompt an Gemini und gibt den Antworttext zurück.
 *
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} [args.responseSchema]    – optional, JSON-Schema-Subset (Gemini-Format)
 * @param {number} [args.temperature]       – Standard 0.2
 * @param {number} [args.maxRetries]        – Standard aus Env
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

  const model       = process.env.AI_ASSESSMENT_MODEL     || 'gemini-2.0-flash';
  const timeoutMs   = Number(process.env.AI_ASSESSMENT_TIMEOUT_MS) || 30_000;
  const retries     = Number.isFinite(maxRetries) ? maxRetries
                     : (Number(process.env.AI_ASSESSMENT_MAX_RETRIES) || 2);
  const temp        = Number.isFinite(temperature) ? temperature : 0.2;

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
  for (let attempt = 0; attempt <= retries; attempt++) {
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
      if (!err || !err.retryable || attempt === retries) {
        throw err;
      }
      // Exponential backoff: 500ms, 1000ms, 2000ms ...
      const delay = 500 * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  // Unreachable, but keeps eslint happy
  throw lastErr;
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
        } else if (status === 429 || (status >= 500 && status < 600)) {
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

module.exports = {
  callStructuredGemini,
  RetryableError,
  FatalError
};
