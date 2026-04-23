'use strict';

/**
 * Gemini-Anbieter-Adapter für die KI-Bewertungsfunktion.
 *
 * Liest Konfiguration aus Umgebungsvariablen:
 *   GEMINI_API_KEY          – Pflicht; fehlt → Fehler
 *   AI_ASSESSMENT_MODEL     – optional; Standard: gemini-2.0-flash
 *   AI_ASSESSMENT_TIMEOUT_MS – optional; Standard: 30000
 *
 * Gibt strukturiertes JSON zurück, das vom aiAssessmentService gegen
 * das exportAssessment.schema.json validiert wird.
 *
 * @module server/ai/providers/geminiProvider
 */

const https = require('https');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Sendet System- und Nutzerprompt an die Gemini-API und gibt den
 * generierten Text zurück.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>}  roher Antworttext (JSON-String)
 */
async function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY ist nicht konfiguriert.');
  }

  const model   = process.env.AI_ASSESSMENT_MODEL     || 'gemini-2.0-flash';
  const timeout = Number(process.env.AI_ASSESSMENT_TIMEOUT_MS) || 30_000;

  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const body = JSON.stringify({
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json'
    }
  });

  const rawText = await httpPost(url, body, timeout);
  const parsed  = JSON.parse(rawText);

  // Gemini response structure: candidates[0].content.parts[0].text
  const candidate = parsed?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) {
    const reason = candidate?.finishReason || 'unknown';
    throw new Error(`Gemini lieferte keine verwertbare Antwort (finishReason: ${reason}).`);
  }

  return text;
}

/**
 * Einfacher HTTP-POST-Helfer (ohne externe Abhängigkeit).
 *
 * @param {string} url
 * @param {string} body   serialisiertes JSON
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
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
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Gemini-API Fehler ${res.statusCode}: ${text.slice(0, 200)}`));
        } else {
          resolve(text);
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Gemini-Anfrage Timeout nach ${timeoutMs} ms.`));
    });
    req.on('error', reject);

    req.write(body);
    req.end();
  });
}

module.exports = { callGemini };
