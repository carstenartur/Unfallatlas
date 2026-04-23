'use strict';

/**
 * Kernservice für die KI-gestützte Bewertung eines Unfallatlas-Exports.
 *
 * Ablauf:
 *  1. Reduziert den vollständigen strukturierten Export auf ein kompaktes
 *     ExportAssessmentInput-Objekt.
 *  2. Baut System- und Nutzerprompt auf.
 *  3. Ruft den konfigurierten KI-Anbieter auf.
 *  4. Validiert die Antwort gegen das JSON-Schema.
 *  5. Gibt das validierte ExportAssessmentOutput-Objekt zurück.
 *
 * Die Funktion ist fail-safe: Fehler werden geworfen und sollen im aufrufenden
 * Controller abgefangen und geloggt werden.
 *
 * @module server/ai/aiAssessmentService
 */

const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompts/exportAssessmentPrompt.js');
const { callGemini }                     = require('./providers/geminiProvider.js');
const schema                             = require('./schema/exportAssessment.schema.json');

// ── Schema-Validierung (ohne externe Abhängigkeit) ─────────────────────────────

/**
 * Minimale JSON-Schema-Validierung für das ExportAssessmentOutput-Objekt.
 * Prüft nur die im Schema definierten `required`-Felder und Typen.
 *
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateOutput(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['Antwort ist kein Objekt.'] };
  }

  for (const field of (schema.required || [])) {
    if (!(field in obj)) {
      errors.push(`Pflichtfeld fehlt: ${field}`);
    }
  }

  const strFields = ['summary', 'assessment'];
  for (const f of strFields) {
    if (f in obj && typeof obj[f] !== 'string') {
      errors.push(`Feld "${f}" muss ein String sein.`);
    }
  }

  const arrFields = ['hypotheses', 'measures', 'openPoints'];
  for (const f of arrFields) {
    if (f in obj && !Array.isArray(obj[f])) {
      errors.push(`Feld "${f}" muss ein Array sein.`);
    }
  }

  if ('formulations' in obj && obj.formulations !== undefined) {
    if (typeof obj.formulations !== 'object' || Array.isArray(obj.formulations)) {
      errors.push('Feld "formulations" muss ein Objekt sein.');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

/**
 * Extrahiert ein kompaktes ExportAssessmentInput-Objekt aus den vollständigen
 * strukturierten Exportdaten.  Sendet nur das, was die KI fachlich braucht.
 *
 * @param {object} structured  Vollständiges structured-Objekt aus computeExportReport()
 * @param {object} [contextHints]  Optionale manuelle Kontext-Hinweise
 * @returns {ExportAssessmentInput}
 */
function buildAiInput(structured, contextHints) {
  const meta    = structured.meta    || {};
  const sev     = structured.severity || {};
  const dev     = structured.deviations || {};
  const yr      = structured.yearTable || [];
  const patterns = structured.patterns || [];
  const poi     = structured.poi || null;
  const refs    = structured.references || [];
  const filters = meta.filters || {};

  // Severity summary
  const bySev = sev.bySev || {};
  const severitySummary = {
    fatal:   bySev['1'] ?? null,
    serious: bySev['2'] ?? null,
    slight:  bySev['3'] ?? null
  };

  // Top deviations (max 10 for token budget)
  const deviations = (Array.isArray(dev.focus) ? dev.focus : (dev.rows || []))
    .slice(0, 10)
    .map(d => ({
      label:        d.label || String(d.mask || ''),
      localCount:   d.localCount  ?? d.localCnt  ?? 0,
      baselineCount: d.baselineCount ?? d.baselineCnt ?? 0,
      relativeDiff: d.relativeDiff ?? d.relDiff ?? null
    }));

  // Year table (at most 10 years)
  const yearTable = yr.slice(-10).map(y => ({ year: y.year, total: y.total }));

  // POI summary
  let poiSummary = null;
  if (poi) {
    const withinByType = poi.withinByType || {};
    const nearByType   = poi.nearByType   || {};
    poiSummary = {
      totalWithin: poi.totalWithin ?? 0,
      totalNear:   poi.totalNear   ?? 0,
      withinArea:  Object.keys(withinByType).filter(k => withinByType[k] > 0),
      nearArea:    Object.keys(nearByType).filter(k => nearByType[k] > 0)
    };
  }

  // References (title only)
  const referenceSummary = refs.slice(0, 5).map(r =>
    (typeof r === 'string') ? r : (r.title || r.name || String(r))
  );

  // Gremium info (subset) – note: source field is `.typ`, output field is `.type`
  const gremium = meta.gremium
    ? { name: meta.gremium.name || '', type: meta.gremium.typ || '' }
    : undefined;

  return {
    meta: {
      city:     meta.city     || '',
      areaName: meta.areaName || '',
      date:     meta.date     || '',
      link:     meta.link     || '',
      gremium
    },
    filters: {
      severity:        filters.severity        || '',
      roadCondition:   filters.roadCondition   || '',
      involvementMode: meta.involvementMode    || filters.involvementMode || 'or'
    },
    statistics: {
      totalAccidents: sev.total ?? 0,
      severitySummary,
      deviations,
      yearTable,
      patterns: patterns.slice(0, 10)
    },
    poi: poiSummary,
    references: referenceSummary,
    contextHints: contextHints || {}
  };
}

/**
 * Parst JSON aus dem Rohtext der KI-Antwort.
 * Toleriert Markdown-Codeblöcke (```json … ```).
 *
 * @param {string} rawText
 * @returns {unknown}
 */
function parseJsonResponse(rawText) {
  let text = rawText.trim();
  // Strip optional markdown code fences
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  return JSON.parse(text);
}

// ── Öffentliche API ────────────────────────────────────────────────────────────

/**
 * Führt die vollständige KI-Bewertung durch.
 *
 * @param {object} structured     Strukturierter Export (aus computeExportReport)
 * @param {object} [contextHints] Optionale manuelle Kontext-Hinweise
 * @returns {Promise<ExportAssessmentOutput>}
 */
async function runAssessment(structured, contextHints) {
  const input      = buildAiInput(structured, contextHints);
  const userPrompt = buildUserPrompt(input);
  const rawText    = await callGemini(SYSTEM_PROMPT, userPrompt);
  const parsed     = parseJsonResponse(rawText);

  const { valid, errors } = validateOutput(parsed);
  if (!valid) {
    throw new Error(`KI-Antwort entspricht nicht dem Schema: ${errors.join('; ')}`);
  }

  return parsed;
}

/**
 * Gibt true zurück, wenn die KI-Funktion konfiguriert ist (API-Key vorhanden).
 *
 * @returns {boolean}
 */
function isAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

module.exports = { runAssessment, isAvailable, buildAiInput, validateOutput };

/**
 * @typedef {object} ExportAssessmentInput
 * @property {object} meta
 * @property {object} filters
 * @property {object} statistics
 * @property {object|null} poi
 * @property {string[]} references
 * @property {object} contextHints
 */

/**
 * @typedef {object} ExportAssessmentOutput
 * @property {string}   summary
 * @property {string}   assessment
 * @property {string[]} hypotheses
 * @property {string[]} measures
 * @property {string[]} openPoints
 * @property {object}   [formulations]
 */
