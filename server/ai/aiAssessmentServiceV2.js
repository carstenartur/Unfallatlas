'use strict';

/**
 * Kernservice v2 für die KI-gestützte Bewertung eines Unfallatlas-Exports.
 *
 * Verbesserungen gegenüber v1 (`aiAssessmentService.js`):
 *   - reichhaltigere Eingabe (deriveFeatures: dominante Typen, Trend, Cluster)
 *   - Maßnahmenvorselektion aus interner Bibliothek (preselectMeasures)
 *   - zwei Modi: "assessment" und "proposal-brief"
 *   - strenge Schema-Validierung (v2-Schema bzw. proposalBrief.v1-Schema)
 *   - einmaliger Reparaturversuch bei ungültiger Antwort
 *   - Cache (sha256 über kanonischem Input) → schont Free-Tier
 *   - Retry/Backoff im Provider
 *   - sauberer Fallback: deterministischer „dry mode" ohne KI-Aufruf
 *
 * Fallback-Verhalten:
 *   1. Kein API-Key → `runAssessmentV2` wirft NotConfiguredError;
 *      Aufrufer kann `buildDeterministicFallback()` nutzen,
 *      um einen gültigen, datengestützten Output (ohne KI-Texte) zu liefern.
 *   2. Provider-Fehler / Schema-Fehler nach Reparaturversuch
 *      → ebenfalls deterministischer Fallback (wenn `withFallback: true`).
 *
 * @module server/ai/aiAssessmentServiceV2
 */

const { deriveFeatures }       = require('./features/deriveFeatures.js');
const { preselectMeasures }    = require('./scoring/preselectMeasures.js');
const { MEASURE_BY_ID }        = require('./catalog/measureCatalog.js');
const { buildPrompt, PROMPT_VERSION } = require('./prompts/exportAssessmentPrompt.v2.js');
const { callStructuredGemini } = require('./providers/geminiStructuredProvider.js');
const { sharedCache, AiAssessmentCache } = require('./cache/aiAssessmentCache.js');
const { sharedQueue }          = require('./jobs/aiJobQueue.js');

const schemaAssessmentV2 = require('./schema/exportAssessment.v2.schema.json');
const schemaProposalV1   = require('./schema/proposalBrief.v1.schema.json');

class NotConfiguredError extends Error {
  constructor(msg) { super(msg || 'KI nicht konfiguriert (GEMINI_API_KEY fehlt).'); this.code = 'AI_NOT_CONFIGURED'; }
}

const VALID_MODES = ['assessment', 'proposal-brief'];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Hauptfunktion: führt eine v2-Bewertung durch.
 *
 * @param {object}  args
 * @param {object}  args.structured                  – aus computeExportReport()
 * @param {object}  [args.contextHints]
 * @param {string}  [args.mode='assessment']         – 'assessment' | 'proposal-brief'
 * @param {boolean} [args.withFallback=true]         – bei Fehlern deterministisch antworten?
 * @param {AiAssessmentCache} [args.cache]           – Override für Tests
 * @param {Function} [args.providerCall]             – Override für Tests (callStructuredGemini)
 * @returns {Promise<{ result: object, source: 'cache'|'ai'|'ai-repaired'|'fallback', cacheKey: string }>}
 */
async function runAssessmentV2(args) {
  const {
    structured,
    contextHints,
    mode = 'assessment',
    withFallback = true,
    cache = sharedCache,
    providerCall = callStructuredGemini
  } = args || {};

  if (!structured || typeof structured !== 'object') {
    throw new Error('structured fehlt oder ist kein Objekt.');
  }
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Ungültiger mode: ${mode}. Erlaubt: ${VALID_MODES.join(', ')}`);
  }

  // Build deterministic input
  const features    = deriveFeatures(structured, contextHints);
  const preselected = preselectMeasures(features.tags);
  const aiInput     = buildAiInputV2(structured, features, preselected, contextHints);

  // Cache key
  const model = process.env.AI_ASSESSMENT_MODEL || 'gemini-2.0-flash';
  const cacheKey = AiAssessmentCache.buildKey({
    input: aiInput,
    promptVersion: PROMPT_VERSION,
    model,
    mode
  });

  // Cache hit?
  const cached = cache.get(cacheKey);
  if (cached) {
    return { result: cached, source: 'cache', cacheKey };
  }

  // Without API key → fallback or fatal
  if (!isAvailable()) {
    if (withFallback) {
      const fb = buildDeterministicFallback({ aiInput, mode });
      return { result: fb, source: 'fallback', cacheKey };
    }
    throw new NotConfiguredError();
  }

  // Build prompt and call provider via queue
  const { system, user } = buildPrompt(aiInput, mode);
  const responseSchema = toGeminiSchema(mode === 'proposal-brief' ? schemaProposalV1 : schemaAssessmentV2);

  let parsed;
  let source = 'ai';
  try {
    const rawText = await sharedQueue.enqueue(() => providerCall({ system, user, responseSchema }));
    parsed = parseJsonLoose(rawText);
    const v = validateAgainstMode(parsed, mode);
    if (!v.valid) {
      // Repair attempt: ask the model to fix the JSON to match the errors
      const repaired = await sharedQueue.enqueue(() => providerCall({
        system: system + '\nReparieren: Antworte erneut, valides JSON gemäß Schema.',
        user: user + `\n\nDie vorige Antwort war ungültig: ${v.errors.join('; ')}\nAntworte erneut, ausschließlich gültiges JSON.`,
        responseSchema
      }));
      const repairedParsed = parseJsonLoose(repaired);
      const v2 = validateAgainstMode(repairedParsed, mode);
      if (!v2.valid) {
        throw new Error(`KI-Antwort ungültig auch nach Reparaturversuch: ${v2.errors.join('; ')}`);
      }
      parsed = repairedParsed;
      source = 'ai-repaired';
    }
  } catch (err) {
    if (withFallback) {
      const fb = buildDeterministicFallback({ aiInput, mode, reason: err.message });
      return { result: fb, source: 'fallback', cacheKey, error: err.message };
    }
    throw err;
  }

  // Post-process: enforce that recommendedMeasures with id resolve to catalog
  if (mode === 'assessment') {
    parsed = harmonizeAssessment(parsed, preselected);
  } else {
    parsed = harmonizeProposal(parsed, preselected);
  }

  cache.set(cacheKey, parsed);
  return { result: parsed, source, cacheKey };
}

/** True wenn GEMINI_API_KEY gesetzt. */
function isAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// ── Input-Aufbereitung ────────────────────────────────────────────────────────

/**
 * Erzeugt das v2-AI-Input-Objekt aus structured + features + preselected.
 * Wird von Tests separat geprüft.
 */
function buildAiInputV2(structured, features, preselected, contextHints) {
  const meta = structured?.meta || {};
  const gremium = meta.gremium
    ? { name: meta.gremium.name || '', type: meta.gremium.typ || '' }
    : undefined;

  const filters = meta.filters || {};

  return {
    schemaVersion: 'aiInput.v2',
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
    features,
    preselectedMeasures: preselected.map(m => ({
      id: m.id,
      title: m.title,
      category: m.category,
      targetAccidentTypes: m.targetAccidentTypes,
      implementationEffort: m.implementationEffort,
      costBand: m.costBand,
      description: m.description
    }))
  };
}

// ── Schema-Validierung (leichtgewichtig) ───────────────────────────────────────

function validateAgainstMode(obj, mode) {
  const schema = mode === 'proposal-brief' ? schemaProposalV1 : schemaAssessmentV2;
  return validateBySchema(obj, schema);
}

/**
 * Sehr leichtgewichtige JSON-Schema-Validierung (Draft-7 Subset).
 * Unterstützt: required, type, enum, const, items.type/required, additionalProperties=false.
 *
 * @param {unknown} obj
 * @param {object}  schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateBySchema(obj, schema) {
  const errors = [];
  walkValidate(obj, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

function walkValidate(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: erwartet const "${schema.const}", erhalten "${value}"`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: Wert "${value}" nicht in enum [${schema.enum.join(', ')}]`);
  }

  if (schema.type) {
    const t = schema.type;
    if (t === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: erwartet object`); return;
      }
    } else if (t === 'array') {
      if (!Array.isArray(value)) { errors.push(`${path}: erwartet array`); return; }
    } else if (t === 'string') {
      if (typeof value !== 'string') errors.push(`${path}: erwartet string`);
    } else if (t === 'number' || t === 'integer') {
      if (typeof value !== 'number') errors.push(`${path}: erwartet number`);
    } else if (t === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${path}: erwartet boolean`);
    }
  }

  if (Array.isArray(schema.required) && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required) {
      if (!(req in value)) errors.push(`${path}: Pflichtfeld fehlt: ${req}`);
    }
  }

  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(schema.properties)) {
      if (key in value) {
        walkValidate(value[key], schema.properties[key], `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: unerlaubtes Zusatzfeld "${key}"`);
        }
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => walkValidate(item, schema.items, `${path}[${i}]`, errors));
  }
}

// ── Loose JSON parsing (recovery) ──────────────────────────────────────────────

/**
 * Parst rohen Antworttext.  Toleriert leichte Abweichungen wie Markdown-Fences,
 * vor-/nachgestellten Fließtext oder ein einleitendes "json" Wort.
 *
 * @param {string} rawText
 * @returns {unknown}
 */
function parseJsonLoose(rawText) {
  if (typeof rawText !== 'string') throw new Error('parseJsonLoose: kein String erhalten.');
  let text = rawText.trim();

  // Strip markdown code fences
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  // First straight try
  try { return JSON.parse(text); } catch { /* fall through */ }

  // Find first { ... matching } – brace counting
  const startIdx = text.indexOf('{');
  if (startIdx === -1) throw new Error('Keine JSON-Objektklammer im Antworttext gefunden.');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"')  { inString = false; continue; }
    } else {
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(startIdx, i + 1);
          return JSON.parse(candidate);
        }
      }
    }
  }
  throw new Error('Konnte kein vollständiges JSON-Objekt extrahieren.');
}

// ── Schema → Gemini-responseSchema ─────────────────────────────────────────────

/**
 * Wandelt unser JSON-Schema in das von Gemini akzeptierte Subset um.
 * Gemini unterstützt keine `$schema`, `$id`, `const`, `additionalProperties`.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === '$id' || k === 'additionalProperties' || k === 'description') continue;
    if (k === 'const') {
      // Express as enum with single value
      out.enum = [v];
      continue;
    }
    if (k === 'properties' || k === 'items') {
      out[k] = toGeminiSchema(v);
    } else if (typeof v === 'object') {
      out[k] = toGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Harmonization (clean catalog references) ───────────────────────────────────

function harmonizeAssessment(parsed, preselected) {
  if (!Array.isArray(parsed.recommendedMeasures)) return parsed;
  parsed.recommendedMeasures = parsed.recommendedMeasures.map(m => {
    if (m && typeof m === 'object' && m.id && MEASURE_BY_ID[m.id]) {
      const cat = MEASURE_BY_ID[m.id];
      return {
        ...m,
        title: m.title || cat.title,
        category: m.category || cat.category,
        targetAccidentTypes: Array.isArray(m.targetAccidentTypes) && m.targetAccidentTypes.length
          ? m.targetAccidentTypes : cat.targetAccidentTypes,
        implementationEffort: m.implementationEffort || cat.implementationEffort,
        costBand: m.costBand || cat.costBand
      };
    }
    return m;
  });
  return parsed;
}

function harmonizeProposal(parsed, preselected) {
  if (!Array.isArray(parsed.measureSummary)) return parsed;
  parsed.measureSummary = parsed.measureSummary.map(m => {
    if (m && typeof m === 'object' && m.id && MEASURE_BY_ID[m.id]) {
      const cat = MEASURE_BY_ID[m.id];
      return {
        ...m,
        title: m.title || cat.title,
        category: m.category || cat.category
      };
    }
    return m;
  });
  return parsed;
}

// ── Deterministic fallback ─────────────────────────────────────────────────────

/**
 * Erzeugt einen *gültigen*, deterministischen Output ohne KI-Aufruf.
 * Wird genutzt, wenn die KI nicht konfiguriert ist oder Fehler auftreten.
 *
 * @param {object} args
 * @param {object} args.aiInput
 * @param {string} args.mode
 * @param {string} [args.reason]
 * @returns {object}
 */
function buildDeterministicFallback({ aiInput, mode, reason }) {
  const f = aiInput?.features || {};
  const counts = f.counts || {};
  const inv = f.involvement || {};
  const tags = f.tags || [];
  const pre = aiInput?.preselectedMeasures || [];

  const evidenceLines = [];
  if (counts.total != null) evidenceLines.push({
    statement: `Im Bereich wurden ${counts.total} Unfälle erfasst (${counts.fatal || 0} Getötete, ${counts.serious || 0} Schwerverletzte, ${counts.slight || 0} Leichtverletzte).`,
    source: 'severity.bySev'
  });
  if (Number.isFinite(f.ksiShare) && f.ksiShare > 0) evidenceLines.push({
    statement: `Anteil schwerer Unfälle (KSI): ${(f.ksiShare * 100).toFixed(0)} %.`,
    source: 'severity.bySev'
  });
  if (Array.isArray(f.dominantPatterns) && f.dominantPatterns.length) {
    const top = f.dominantPatterns[0];
    evidenceLines.push({
      statement: `Auffälligstes Beteiligungsmuster: ${top.label} (${top.localCount} lokal).`,
      source: 'deviations.focus'
    });
  }
  if (f.trend && f.trend.direction && f.trend.direction !== 'unknown') {
    evidenceLines.push({
      statement: `Trend über ${f.trend.rangeYears} Jahre: ${f.trend.direction}.`,
      source: 'yearTable'
    });
  }

  if (mode === 'proposal-brief') {
    return {
      schemaVersion: 'proposalBrief.v1',
      title: `Verkehrssicherheit im Bereich ${aiInput?.meta?.areaName || aiInput?.meta?.city || ''}`.trim(),
      shortVersion: 'Im markierten Bereich liegt eine auffällige Unfallhäufung vor (siehe Kennzahlen). '
        + 'Die Verwaltung wird gebeten, den Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen.',
      longVersion: 'Die statistischen Daten zum markierten Bereich zeigen eine Häufung mit ' + (counts.total || 0) + ' Unfällen, davon ' + (counts.fatal || 0) + ' getötet und ' + (counts.serious || 0) + ' schwerverletzt. '
        + 'Eine fachliche Bewertung mit konkreten Maßnahmenvorschlägen sollte durch die zuständige Stelle (z. B. Unfallkommission) erfolgen.',
      sachverhalt: 'Im markierten Bereich wurden im Auswertungszeitraum ' + (counts.total || 0) + ' Unfälle erfasst.',
      begruendung: 'Die Häufung und die Schwere der Unfälle rechtfertigen eine vertiefte fachliche Prüfung.',
      beschlussvorschlag: 'Die Verwaltung wird gebeten, den Bereich verkehrssicherheitsfachlich zu prüfen und Maßnahmen vorzuschlagen bzw. umzusetzen.',
      pruefauftrag: 'Bitte um Befassung der Unfallkommission und Prüfung kurzfristig umsetzbarer Maßnahmen.',
      measureSummary: pre.slice(0, 5).map(p => ({
        id: p.id,
        title: p.title,
        category: p.category,
        rationale: 'Ausgewählt anhand der erkannten Merkmale: ' + (tags.slice(0, 4).join(', ') || 'allgemein')
      })),
      confidence: { overall: counts.total >= 10 ? 'medium' : 'low', rationale: 'Deterministischer Fallback ohne KI-Bewertung.' },
      caveats: [
        'Dieser Steckbrief wurde ohne KI-Analyse rein aus den Kennzahlen erzeugt.' + (reason ? ' Grund: ' + reason : '')
      ]
    };
  }

  // assessment fallback
  return {
    schemaVersion: 'exportAssessment.v2',
    problemProfile: {
      headline: `Auffällige Unfallhäufung im Bereich ${aiInput?.meta?.areaName || aiInput?.meta?.city || ''}`.trim(),
      summary: `Im Bereich wurden ${counts.total || 0} Unfälle erfasst. Die fachliche Bewertung erfolgt im Fallback ohne KI-Auswertung.`,
      dominantPattern: f.dominantPatterns?.[0]?.label || ''
    },
    evidence: evidenceLines,
    primaryRiskFactors: tags.slice(0, 3).map(t => ({
      factor: tagToText(t),
      rationale: `Ableitung aus Beteiligungsanteilen / POIs (Tag: ${t}).`,
      confidence: 'medium'
    })),
    secondaryRiskFactors: [],
    recommendedMeasures: pre.slice(0, 6).map(p => ({
      id: p.id,
      title: p.title,
      category: p.category,
      whyThisFitsHere: `Ausgewählt anhand erkannter Merkmale: ${(p.targetAccidentTypes || []).join(', ') || '—'}`,
      expectedEffect: p.description,
      targetAccidentTypes: p.targetAccidentTypes,
      implementationEffort: p.implementationEffort,
      costBand: p.costBand,
      confidence: 'medium'
    })),
    quickWins: pre.filter(p => p.category === 'quickWin').map(p => p.id),
    infrastructureMeasures: pre.filter(p => p.category === 'infrastructure').map(p => p.id),
    openChecks: [
      'Ortsbegehung mit Polizei und Verwaltung',
      'Befassung der Unfallkommission'
    ],
    confidence: { overall: counts.total >= 10 ? 'medium' : 'low', rationale: 'Deterministischer Fallback ohne KI-Bewertung.' + (reason ? ' Grund: ' + reason : '') },
    dataGaps: [
      'Keine textuelle KI-Bewertung verfügbar',
      'Genaue Unfallhergänge sind nicht in den Daten enthalten'
    ]
  };
}

function tagToText(t) {
  const map = {
    bike_alone: 'Radfahrende ohne Kfz-Beteiligung (Hinweis auf Infrastruktur/Belag)',
    bike_car:   'Konflikt Rad/PKW',
    bike_truck: 'Konflikt Rad/Lkw (besonders schwerwiegend)',
    ped_car:    'Konflikt Fuß/PKW',
    ped_alone:  'Stürze Fußverkehr',
    car_car:    'Kfz/Kfz-Konflikte',
    motorcycle: 'Motorradunfälle',
    hgv:        'Hoher Lkw-Anteil',
    junction:   'Knotenpunkt-Konflikte',
    crossing:   'Querungsstellen',
    surface:    'Belag-/Oberflächenprobleme',
    night:      'Nächtliche Häufung',
    rush_hour:  'Berufsverkehrszeit',
    school_zone:'Nähe zu Schule/Kita',
    transit:    'ÖPNV-Umfeld',
    rail:       'Schienen-/Gleisbereich'
  };
  return map[t] || t;
}

module.exports = {
  runAssessmentV2,
  isAvailable,
  buildAiInputV2,
  buildDeterministicFallback,
  validateAgainstMode,
  validateBySchema,
  parseJsonLoose,
  toGeminiSchema,
  NotConfiguredError,
  VALID_MODES
};
