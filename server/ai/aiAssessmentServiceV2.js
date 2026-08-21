'use strict';

/**
 * Kernservice v2 für die KI-gestützte Bewertung eines Unfallatlas-Exports.
 *
 * Unterstützt die fachliche Bewertung (exportAssessment.v2) sowie den
 * kommunalen Maßnahmensteckbrief (proposalBrief.v1). Der Proposal-Pfad bindet
 * seit v2.6 einen serverseitigen Deterministik-vs.-KI-Mehrwertvertrag ein:
 * fehlender Mehrwert, unbelegte politische Recherche oder methodische
 * Überdehnung bleiben sichtbar, dürfen aber nie als einreichungsreif gelten.
 */

const { deriveFeatures }       = require('./features/deriveFeatures.js');
const { preselectMeasures }    = require('./scoring/preselectMeasures.js');
const { MEASURE_BY_ID }        = require('./catalog/measureCatalog.js');
const { getCatalogForCity, normalizeSlug: normalizeCitySlug } = require('./catalog/cityMeasureCatalog.js');
const { buildPrompt, PROMPT_VERSION } = require('./prompts/exportAssessmentPrompt.v2.js');
const { getProvider, activeProviderName } = require('./providers/index.js');
const { sharedCache, AiAssessmentCache } = require('./cache/aiAssessmentCache.js');
const { sharedQueue }          = require('./jobs/aiJobQueue.js');
const {
  buildProposalEvidenceContracts,
  buildProposalValueAddPrompt,
  buildBlockedFallbackContract,
  ensureProposalValueAdd,
  evaluateProposalValueAdd,
} = require('./proposalBriefValueAdd.js');

const schemaAssessmentV2 = require('./schema/exportAssessment.v2.schema.json');
const schemaProposalV1   = require('./schema/proposalBrief.v1.schema.json');

class NotConfiguredError extends Error {
  constructor(msg) {
    super(msg || 'KI nicht konfiguriert (GEMINI_API_KEY fehlt).');
    this.code = 'AI_NOT_CONFIGURED';
  }
}

const VALID_MODES = ['assessment', 'proposal-brief'];

/**
 * Führt eine v2-Bewertung aus.
 *
 * @param {object} args
 * @param {object} args.structured
 * @param {object} [args.contextHints]
 * @param {'assessment'|'proposal-brief'} [args.mode='assessment']
 * @param {boolean} [args.withFallback=true]
 * @param {AiAssessmentCache} [args.cache]
 * @param {Function} [args.providerCall]
 * @returns {Promise<{result: object, source: string, cacheKey: string, error?: string}>}
 */
async function runAssessmentV2(args) {
  const {
    structured,
    contextHints,
    mode = 'assessment',
    withFallback = true,
    cache = sharedCache,
    providerCall = getProvider(),
  } = args || {};

  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    throw new Error('structured fehlt oder ist kein Objekt.');
  }
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Ungültiger mode: ${mode}. Erlaubt: ${VALID_MODES.join(', ')}`);
  }

  const features = deriveFeatures(structured, contextHints);
  const citySlug = normalizeCitySlug(structured?.meta?.city);
  const preselected = preselectMeasures(features, { citySlug });
  const aiInput = buildAiInputV2(structured, features, preselected, contextHints);

  const model = process.env.AI_ASSESSMENT_MODEL || 'gemini-2.0-flash';
  const cacheKey = AiAssessmentCache.buildKey({
    input: aiInput,
    promptVersion: PROMPT_VERSION,
    model,
    mode,
  });

  const cached = cache.get(cacheKey);
  if (cached) return { result: cached, source: 'cache', cacheKey };

  if (!isAvailable()) {
    if (withFallback) {
      return {
        result: buildDeterministicFallback({ aiInput, mode }),
        source: 'fallback',
        cacheKey,
      };
    }
    throw new NotConfiguredError();
  }

  const prompt = buildPrompt(aiInput, mode);
  let system = prompt.system;
  let user = prompt.user;
  if (mode === 'proposal-brief') {
    const valueAddPrompt = buildProposalValueAddPrompt(aiInput);
    system += '\n\nDer nachfolgende Mehrwertvertrag ist verbindlich. Fehlende Pflichtteile müssen als blocked ausgewiesen werden.';
    user += `\n\n${valueAddPrompt}`;
  }

  const responseSchema = toGeminiSchema(
    mode === 'proposal-brief' ? schemaProposalV1 : schemaAssessmentV2
  );

  let parsed;
  let source = 'ai';
  try {
    const rawText = await sharedQueue.enqueue(() => providerCall({ system, user, responseSchema }));
    parsed = parseJsonLoose(rawText);
    if (mode === 'proposal-brief') {
      parsed = ensureProposalValueAdd(
        parsed,
        aiInput,
        'Die erste Modellantwort enthielt keinen vollständigen Mehrwertnachweis.'
      );
    }

    const validation = validateAgainstMode(parsed, mode, {
      aiInput,
      normalizeProposal: false,
    });
    if (!validation.valid) {
      const repaired = await sharedQueue.enqueue(() => providerCall({
        system: `${system}\nReparieren: Antworte erneut, valides JSON gemäß Schema und Mehrwertvertrag.`,
        user: `${user}\n\nDie vorige Antwort war ungültig: ${validation.errors.join('; ')}\nAntworte erneut, ausschließlich gültiges JSON.`,
        responseSchema,
      }));
      let repairedParsed = parseJsonLoose(repaired);
      if (mode === 'proposal-brief') {
        repairedParsed = ensureProposalValueAdd(
          repairedParsed,
          aiInput,
          'Auch die Reparaturantwort enthielt keinen vollständigen Mehrwertnachweis.'
        );
      }
      const repairedValidation = validateAgainstMode(repairedParsed, mode, {
        aiInput,
        normalizeProposal: false,
      });
      if (!repairedValidation.valid) {
        throw new Error(
          `KI-Antwort ungültig auch nach Reparaturversuch: ${repairedValidation.errors.join('; ')}`
        );
      }
      parsed = repairedParsed;
      source = 'ai-repaired';
    }
  } catch (err) {
    if (withFallback) {
      return {
        result: buildDeterministicFallback({ aiInput, mode, reason: err.message }),
        source: 'fallback',
        cacheKey,
        error: err.message,
      };
    }
    throw err;
  }

  const catalogById = buildCatalogIndex(citySlug);
  parsed = mode === 'assessment'
    ? harmonizeAssessment(parsed, catalogById)
    : harmonizeProposal(parsed, catalogById);

  cache.set(cacheKey, parsed);
  return { result: parsed, source, cacheKey };
}

function isAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Erzeugt den kanonischen, cache-relevanten AI-Input. Der deterministische
 * Digest und der Vergleichsvertrag werden für beide Modi transportiert; im
 * Proposal-Modus sind sie zusätzlich Bestandteil der strikten Ausgabe.
 */
function buildAiInputV2(structured, features, preselected, contextHints) {
  const meta = structured?.meta || {};
  const gremium = meta.gremium
    ? { name: meta.gremium.name || '', type: meta.gremium.typ || '' }
    : undefined;
  const filters = meta.filters || {};
  const evidenceContracts = buildProposalEvidenceContracts(structured, features);

  return {
    schemaVersion: 'aiInput.v2',
    meta: {
      city: meta.city || '',
      areaName: meta.areaName || '',
      date: meta.date || '',
      link: meta.link || '',
      gremium,
    },
    filters: {
      severity: filters.severity || '',
      roadCondition: filters.roadCondition || '',
      involvementMode: meta.involvementMode || filters.involvementMode || 'or',
    },
    features,
    contextHints: contextHints || undefined,
    ...evidenceContracts,
    preselectedMeasures: preselected.map(measure => ({
      id: measure.id,
      title: measure.title,
      category: measure.category,
      targetAccidentTypes: measure.targetAccidentTypes,
      implementationEffort: measure.implementationEffort,
      costBand: measure.costBand,
      description: measure.description,
      matchedRiskFactors: measure.matchedRiskFactors || [],
      matchedConflictPatterns: measure.matchedConflictPatterns || [],
      expectedTargetAccidentTypes:
        measure.expectedTargetAccidentTypes || measure.targetAccidentTypes || [],
      reasonForPreselection: measure.reasonForPreselection || '',
      implementationDuration: measure.implementationDuration || undefined,
      measureClass: measure.measureClass || undefined,
      useCases: measure.useCases || [],
      cautions: measure.cautions || [],
    })),
  };
}

/**
 * Validiert gegen das Modusschema. Für bestehende direkte Aufrufer wird ein
 * unvollständiger Proposal zunächst fail-closed ergänzt. `normalizeProposal:
 * false` prüft den bereits normalisierten Rohwert strikt.
 */
function validateAgainstMode(obj, mode, options = {}) {
  const schema = mode === 'proposal-brief' ? schemaProposalV1 : schemaAssessmentV2;
  let candidate = obj;
  if (mode === 'proposal-brief' && options.normalizeProposal !== false) {
    candidate = ensureProposalValueAdd(
      obj,
      options.aiInput || {},
      options.reason || 'Fehlende serverseitige Mehrwertfelder wurden blockierend ergänzt.'
    );
  }
  const schemaValidation = validateBySchema(candidate, schema);
  if (mode !== 'proposal-brief' || !schemaValidation.valid) return schemaValidation;

  const semanticValidation = evaluateProposalValueAdd(candidate);
  // Ein bewusst blockierter Fallback ist schema-valide Arbeitsgrundlage. Nur
  // strukturelle Widersprüche verhindern die Ausgabe; Einreichungsreife wird
  // über filingReadinessVerdict fail-closed abgebildet.
  return {
    valid: true,
    errors: [],
    warnings: semanticValidation.valid
      ? semanticValidation.warnings
      : semanticValidation.errors.concat(semanticValidation.warnings),
  };
}

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
    const type = schema.type;
    if (type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: erwartet object`);
        return;
      }
    } else if (type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`${path}: erwartet array`);
        return;
      }
    } else if (type === 'string') {
      if (typeof value !== 'string') errors.push(`${path}: erwartet string`);
    } else if (type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path}: erwartet integer`);
      }
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: erwartet number`);
      }
    } else if (type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${path}: erwartet boolean`);
    }
  }

  if (typeof value === 'string' && Number.isInteger(schema.minLength)
      && value.length < schema.minLength) {
    errors.push(`${path}: erwartet mindestens ${schema.minLength} Zeichen`);
  }
  if (Array.isArray(value) && Number.isInteger(schema.minItems)
      && value.length < schema.minItems) {
    errors.push(`${path}: erwartet mindestens ${schema.minItems} Einträge`);
  }
  if (typeof value === 'number' && Number.isFinite(schema.minimum)
      && value < schema.minimum) {
    errors.push(`${path}: Wert kleiner als Minimum ${schema.minimum}`);
  }
  if (typeof value === 'number' && Number.isFinite(schema.maximum)
      && value > schema.maximum) {
    errors.push(`${path}: Wert größer als Maximum ${schema.maximum}`);
  }

  if (Array.isArray(schema.required)
      && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required) {
      if (!(required in value)) errors.push(`${path}: Pflichtfeld fehlt: ${required}`);
    }
  }

  if (schema.properties
      && value && typeof value === 'object' && !Array.isArray(value)) {
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
    value.forEach((item, index) => walkValidate(item, schema.items, `${path}[${index}]`, errors));
  }
}

function parseJsonLoose(rawText) {
  if (typeof rawText !== 'string') {
    throw new Error('parseJsonLoose: kein String erhalten.');
  }
  let text = rawText.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    return JSON.parse(text);
  } catch (_) {
    // Fallback: erstes vollständig geklammertes JSON-Objekt extrahieren.
  }

  const startIndex = text.indexOf('{');
  if (startIndex === -1) {
    throw new Error('Keine JSON-Objektklammer im Antworttext gefunden.');
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = startIndex; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (character === '\\') {
        escape = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(startIndex, index + 1));
    }
  }
  throw new Error('Konnte kein vollständiges JSON-Objekt extrahieren.');
}

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);

  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['$schema', '$id', 'additionalProperties', 'description'].includes(key)) continue;
    if (key === 'const') {
      output.enum = [value];
      continue;
    }
    output[key] = typeof value === 'object' ? toGeminiSchema(value) : value;
  }
  return output;
}

function harmonizeAssessment(parsed, byId) {
  if (!Array.isArray(parsed.recommendedMeasures)) return parsed;
  parsed.recommendedMeasures = parsed.recommendedMeasures.map(measure => {
    if (!measure || typeof measure !== 'object' || !measure.id || !byId[measure.id]) {
      return measure;
    }
    const catalog = byId[measure.id];
    return {
      ...measure,
      title: measure.title || catalog.title,
      category: measure.category || catalog.category,
      targetAccidentTypes:
        Array.isArray(measure.targetAccidentTypes) && measure.targetAccidentTypes.length
          ? measure.targetAccidentTypes
          : catalog.targetAccidentTypes,
      implementationEffort:
        measure.implementationEffort || catalog.implementationEffort,
      costBand: measure.costBand || catalog.costBand,
    };
  });
  return parsed;
}

function harmonizeProposal(parsed, byId) {
  if (!Array.isArray(parsed.measureSummary)) return parsed;
  parsed.measureSummary = parsed.measureSummary.map(measure => {
    if (!measure || typeof measure !== 'object' || !measure.id || !byId[measure.id]) {
      return measure;
    }
    const catalog = byId[measure.id];
    return {
      ...measure,
      title: measure.title || catalog.title,
      category: measure.category || catalog.category,
    };
  });
  return parsed;
}

function buildCatalogIndex(citySlug) {
  const index = { ...MEASURE_BY_ID };
  if (citySlug) {
    for (const measure of getCatalogForCity(citySlug)) index[measure.id] = measure;
  }
  return index;
}

/**
 * Erzeugt einen deterministischen, schema-validen Fallback. Im Proposal-Modus
 * enthält er den vollständigen Mehrwertvertrag, aber mit einem ausdrücklich
 * blockierten Readiness-Verdikt. Er behauptet weder einen räumlichen noch einen
 * amtlichen Unfallschwerpunkt und gibt keine Umsetzung ohne Fachprüfung frei.
 */
function buildDeterministicFallback({ aiInput, mode, reason }) {
  const features = aiInput?.features || {};
  const counts = features.counts || {};
  const tags = features.tags || [];
  const patterns = Array.isArray(features.conflictPatterns)
    ? features.conflictPatterns
    : [];
  const preselected = aiInput?.preselectedMeasures || [];
  const lowDataBasis = (counts.total || 0) < 10;
  const area = aiInput?.meta?.areaName || aiInput?.meta?.city || 'markierten Bereich';

  const evidenceLines = [];
  if (counts.total != null) {
    evidenceLines.push({
      statement: `Im Bereich wurden ${counts.total} Unfälle erfasst (${counts.fatal || 0} Getötete, ${counts.serious || 0} Schwerverletzte, ${counts.slight || 0} Leichtverletzte).`,
      source: 'severity.bySev',
    });
  }
  if (Number.isFinite(features.ksiShare) && features.ksiShare > 0) {
    evidenceLines.push({
      statement: `Anteil schwerer Unfälle (KSI): ${(features.ksiShare * 100).toFixed(0)} %.`,
      source: 'severity.bySev',
    });
  }
  if (Array.isArray(features.dominantPatterns) && features.dominantPatterns.length) {
    const top = features.dominantPatterns[0];
    evidenceLines.push({
      statement: `Ranghöchstes Beteiligungsmuster im lokalen Vergleich: ${top.label} (${top.localCount} lokal).`,
      source: 'deviations.focus',
    });
  }
  if (features.trend?.direction && features.trend.direction !== 'unknown') {
    evidenceLines.push({
      statement: `Trend über ${features.trend.rangeYears} Jahre: ${features.trend.direction}.`,
      source: 'yearTable',
    });
  }

  const uncertainty = {
    missingData: [
      'Genaue Unfallhergänge und Erstunfallarten sind nicht im Datensatz enthalten.',
      ...(counts.total === 0
        ? ['Im gewählten Filter/Bereich wurden keine Unfälle erfasst.']
        : []),
      ...(lowDataBasis
        ? ['Fallzahl im Bereich liegt unter 10 – statistische Aussagen sind unsicher.']
        : []),
    ],
    weakDataBasis: lowDataBasis,
    plausibleNotEvidenced: patterns
      .filter(pattern => pattern.classification === 'secondary')
      .map(pattern => pattern.label),
    requiresOnSiteCheck:
      patterns.some(pattern => list(pattern.requiresOnSiteCheck).length) || lowDataBasis,
    alternativeExplanations: [
      'Punktuelle bauliche Mängel sind aus den Unfallattributen allein nicht ableitbar.',
      'Verkehrsstärken und tatsächlich gefahrene Geschwindigkeiten fehlen.',
    ],
  };
  const provenance = {
    derivedFromDeterministicFeatures: [
      'counts', 'severity.bySev', 'crossTable', 'deviations.focus',
      'yearTable', 'spatialDensity', 'poiSummary', 'features.tags',
      'features.conflictPatterns',
    ],
    inferredByModel: [],
    uncertainOrNeedsVerification: patterns
      .flatMap(pattern => pattern.requiresOnSiteCheck || [])
      .slice(0, 8),
  };
  const policyContext = {
    policyReadiness: lowDataBasis
      ? 'low'
      : (patterns.some(pattern => pattern.classification === 'primary') ? 'medium' : 'low'),
    existingPoliticalSignals: [],
    synergyWithKnownRequests: [],
    implementationOpportunityLevel:
      preselected.some(measure => measure.category === 'quickWin') ? 'medium' : 'low',
  };
  const detectedConflictPatterns = patterns.map(pattern => ({
    id: pattern.id,
    label: pattern.label,
    confidence: pattern.confidence,
    rationale: pattern.rationale,
  }));
  const fieldInspectionChecklist = uniq(
    patterns.flatMap(pattern => pattern.requiresOnSiteCheck || [])
  ).concat([
    'Sichtbeziehungen prüfen',
    'Belag und Markierung prüfen',
    'Querungsangebote und Führungswechsel prüfen',
  ]).slice(0, 8);

  if (mode === 'proposal-brief') {
    const valueAdd = buildBlockedFallbackContract(aiInput, reason);
    return {
      schemaVersion: 'proposalBrief.v1',
      title: `Verkehrssicherheitsprüfung im Bereich ${area}`.trim(),
      shortVersion:
        `Im markierten Bereich wurden ${counts.total || 0} Unfälle mit Personenschaden dokumentiert. `
        + 'Die Verwaltung wird gebeten, das Unfallgeschehen, die räumliche Lage und mögliche Konfliktmechanismen fachlich und vor Ort zu prüfen sowie geeignete Optionen mit Erfolgskriterien vorzulegen.',
      longVersion:
        `Die amtlichen Daten dokumentieren im markierten Bereich ${counts.total || 0} Unfälle, davon ${counts.fatal || 0} mit Getöteten und ${counts.serious || 0} mit Schwerverletzten. `
        + 'Aus diesen Zahlen allein folgt weder eine amtliche Einstufung als Unfallschwerpunkt noch der Nachweis eines eigenständigen räumlichen Clusters. '
        + 'Die zuständige Verwaltung beziehungsweise Unfallkommission soll deshalb Unfalltypen, Lage, Infrastruktur und alternative Erklärungen prüfen, Optionen aus der Maßnahmenbibliothek bewerten und dem Gremium berichten.',
      sachverhalt:
        `Im markierten Bereich wurden im Auswertungszeitraum ${counts.total || 0} Unfälle erfasst.`,
      begruendung:
        'Das dokumentierte Unfallgeschehen und seine Schwere rechtfertigen einen nachvollziehbaren fachlichen Prüfauftrag.'
        + (patterns.length
          ? ` Deterministisch erkannte Konflikt- oder Prüfmuster: ${patterns.slice(0, 3).map(pattern => pattern.label).join('; ')}.`
          : ''),
      beschlussvorschlag:
        'Die Verwaltung wird gebeten, das dokumentierte Unfallgeschehen verkehrssicherheitsfachlich zu untersuchen, geeignete Maßnahmen- und Prüfoptionen einschließlich Voraussetzungen und Erfolgskriterien zu bewerten und dem zuständigen Gremium zu berichten.',
      pruefauftrag:
        'Befassung der Unfallkommission beziehungsweise zuständigen Fachstellen; Prüfung von Unfalltypen, räumlicher Lage, Infrastruktur, Gegenhypothesen und kurzfristig prüfbaren Optionen.',
      measureSummary: preselected.slice(0, 5).map(measure => ({
        id: measure.id,
        title: measure.title,
        category: measure.category,
        rationale: measure.reasonForPreselection
          || `Katalogbasierte Vorauswahl anhand der Merkmale: ${tags.slice(0, 4).join(', ') || 'allgemein'}; lokale Passung noch zu prüfen.`,
        matchedRiskFactors: measure.matchedRiskFactors || [],
        matchedConflictPatterns: measure.matchedConflictPatterns || [],
      })),
      confidence: {
        overall: lowDataBasis ? 'low' : 'medium',
        rationale: 'Deterministischer Fallback ohne KI-Mehrwertanalyse.',
      },
      caveats: [
        `Dieser Steckbrief wurde ohne KI-Mehrwertanalyse rein aus deterministischen Kennzahlen erzeugt.${reason ? ` Grund: ${reason}` : ''}`,
        'Der Fallback ist Arbeitsmaterial und nicht einreichungsreif.',
        ...(lowDataBasis
          ? ['Geringe Fallzahl – Interpretation und Maßnahmenpassung sind vorsichtig zu prüfen.']
          : []),
      ],
      shortAdministrativeSummary:
        `${counts.total || 0} dokumentierte Unfälle im Bereich, davon ${(counts.fatal || 0) + (counts.serious || 0)} schwer/tödlich; fachliche Orts- und Konfliktprüfung erforderlich.`,
      recommendedImmediateAction:
        'Verkehrsschau beziehungsweise Ortstermin mit Polizei, Verwaltung und zuständigen Fachstellen vorbereiten.',
      recommendedDetailedExamination:
        'Unfalltypensteckkarte, räumliche Teilbereiche, Infrastruktur, Verkehrsführung und alternative Erklärungen gemeinsam prüfen.',
      expectedSafetyBenefit:
        'Eine Wirkung kann erst nach Wahl einer fachlich bestätigten Option und Festlegung eines messbaren Ausgangswerts belastbar bewertet werden.',
      whyActionIsPlausibleHere: patterns.length
        ? `Die deterministisch erkannten Prüfmuster (${patterns.slice(0, 3).map(pattern => pattern.id).join(', ')}) begründen eine gezielte Untersuchung, nicht automatisch eine konkrete Umsetzung.`
        : 'Das amtlich dokumentierte Unfallgeschehen begründet einen fachlichen Prüfauftrag.',
      whyEvidenceIsLimitedIfApplicable:
        'Unfallursachen, reale Geometrie, Verkehrsmenge und politische Vorbefassung sind im deterministischen Fallback nicht abschließend belegt.',
      suggestedCouncilRequest:
        `Die Verwaltung wird gebeten, im Bereich ${area} das dokumentierte Unfallgeschehen fachlich zu untersuchen, Optionen zu bewerten und dem Gremium mit Evidenz, Voraussetzungen, Frist und Erfolgskriterien zu berichten.`,
      suggestedReviewOrder:
        'Prüfung des dokumentierten Unfallgeschehens durch Verwaltung und Unfallkommission; danach Bericht und Entscheidung im zuständigen Gremium.',
      fieldInspectionChecklist,
      uncertainty,
      provenance,
      policyContext,
      detectedConflictPatterns,
      ...valueAdd,
    };
  }

  return {
    schemaVersion: 'exportAssessment.v2',
    problemProfile: {
      headline: `Dokumentiertes Unfallgeschehen im Bereich ${area}`.trim(),
      summary:
        `Im Bereich wurden ${counts.total || 0} Unfälle erfasst. Die fachliche Bewertung erfolgt im Fallback ohne KI-Auswertung.`,
      dominantPattern: features.dominantPatterns?.[0]?.label || '',
    },
    evidence: evidenceLines,
    primaryRiskFactors: patterns
      .filter(pattern => pattern.classification === 'primary')
      .slice(0, 4)
      .map(pattern => ({
        factor: pattern.label,
        rationale: pattern.rationale,
        confidence: pattern.confidence,
      }))
      .concat(
        patterns.some(pattern => pattern.classification === 'primary')
          ? []
          : tags.slice(0, 3).map(tag => ({
            factor: tagToText(tag),
            rationale: `Ableitung aus Beteiligungsanteilen oder Kontextmerkmalen (Tag: ${tag}); fachlich zu prüfen.`,
            confidence: 'medium',
          }))
      ),
    secondaryRiskFactors: patterns
      .filter(pattern => pattern.classification === 'secondary')
      .slice(0, 4)
      .map(pattern => ({
        factor: pattern.label,
        rationale: pattern.rationale,
        confidence: pattern.confidence === 'high' ? 'medium' : pattern.confidence,
      })),
    recommendedMeasures: preselected.slice(0, 6).map(measure => ({
      id: measure.id,
      title: measure.title,
      category: measure.category,
      whyThisFitsHere: measure.reasonForPreselection
        || `Katalogbasierte Vorauswahl anhand erkannter Merkmale: ${(measure.targetAccidentTypes || []).join(', ') || '—'}`,
      expectedEffect: measure.description,
      targetAccidentTypes: measure.targetAccidentTypes,
      implementationEffort: measure.implementationEffort,
      costBand: measure.costBand,
      confidence: lowDataBasis ? 'low' : 'medium',
      matchedRiskFactors: measure.matchedRiskFactors || [],
      matchedConflictPatterns: measure.matchedConflictPatterns || [],
      expectedTargetAccidentTypes:
        measure.expectedTargetAccidentTypes || measure.targetAccidentTypes || [],
      reasonForPreselection: measure.reasonForPreselection || '',
      ...(measure.implementationDuration
        ? { implementationDuration: measure.implementationDuration }
        : {}),
      ...(measure.measureClass ? { measureClass: measure.measureClass } : {}),
    })),
    quickWins: preselected
      .filter(measure => measure.category === 'quickWin')
      .map(measure => measure.id),
    infrastructureMeasures: preselected
      .filter(measure => measure.category === 'infrastructure')
      .map(measure => measure.id),
    openChecks: uniq([
      'Ortsbegehung mit Polizei und Verwaltung',
      'Befassung der Unfallkommission',
      ...patterns.flatMap(pattern => pattern.requiresOnSiteCheck || []),
    ]).slice(0, 8),
    confidence: {
      overall: lowDataBasis ? 'low' : 'medium',
      rationale: `Deterministischer Fallback ohne KI-Bewertung.${reason ? ` Grund: ${reason}` : ''}`,
    },
    dataGaps: [
      'Keine textuelle KI-Bewertung verfügbar',
      'Genaue Unfallhergänge sind nicht in den Daten enthalten',
      ...(lowDataBasis
        ? ['Geringe Fallzahl im Auswertungszeitraum – statistische Aussagen unsicher.']
        : []),
    ],
    shortAdministrativeSummary:
      `${counts.total || 0} dokumentierte Unfälle im Bereich, davon ${(counts.fatal || 0) + (counts.serious || 0)} schwer/tödlich.`,
    technicalRationale: patterns.length
      ? `Erkannte Prüfmuster: ${patterns.map(pattern => pattern.id).join(', ')}. Maßnahmen sind katalogbasiert vorselektiert und müssen örtlich bestätigt werden.`
      : 'Keine spezifischen Konfliktmuster eindeutig erkannt; Bewertung beschränkt sich auf dokumentierte Unfallzahlen und Schwere.',
    recommendedImmediateAction:
      'Verkehrsschau beziehungsweise Ortstermin mit Polizei und Verwaltung zeitnah anberaumen.',
    recommendedDetailedExamination:
      'Befassung der Unfallkommission mit Unfalltypensteckkarte und realer Ortsprüfung.',
    expectedSafetyBenefit:
      'Wirkung erst nach fachlicher Auswahl einer Option und Festlegung messbarer Indikatoren bewerten.',
    whyActionIsPlausibleHere: patterns.length
      ? `Die deterministisch erkannten Prüfmuster (${patterns.slice(0, 3).map(pattern => pattern.id).join(', ')}) stützen eine vertiefte Untersuchung.`
      : 'Das amtlich dokumentierte Unfallgeschehen rechtfertigt einen fachlichen Prüfauftrag.',
    whyEvidenceIsLimitedIfApplicable: lowDataBasis
      ? 'Geringe Fallzahl; Interpretation und Maßnahmenpassung benötigen eine Vor-Ort-Bestätigung.'
      : '',
    suggestedCouncilRequest:
      `Die Verwaltung wird gebeten, im Bereich ${area} geeignete Prüf- und Maßnahmenoptionen zur Verbesserung der Verkehrssicherheit zu bewerten.`,
    suggestedReviewOrder:
      'Prüfung des dokumentierten Unfallgeschehens durch Verwaltung und Unfallkommission; Bericht im zuständigen Gremium.',
    fieldInspectionChecklist,
    uncertainty,
    provenance,
    policyContext,
    detectedConflictPatterns,
  };
}

function uniq(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function tagToText(tag) {
  const labels = {
    bike_alone: 'Radfahrende ohne Kfz-Beteiligung (Infrastruktur und Oberfläche prüfen)',
    bike_car: 'Konflikt Rad/PKW',
    bike_truck: 'Konflikt Rad/Lkw',
    ped_car: 'Konflikt Fuß/PKW',
    ped_alone: 'Stürze im Fußverkehr',
    car_car: 'Kfz/Kfz-Konflikte',
    motorcycle: 'Motorradunfälle',
    hgv: 'Lkw-Beteiligung',
    junction: 'Knotenpunkt-Konflikte',
    crossing: 'Querungsstellen',
    surface: 'Belag-/Oberflächenprüfung',
    night: 'Nächtliche Unfallverteilung',
    rush_hour: 'Berufsverkehrszeit',
    school_zone: 'Nähe zu Schule oder Kita',
    transit: 'ÖPNV-Umfeld',
    rail: 'Schienen-/Gleisbereich',
  };
  return labels[tag] || tag;
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
  buildCatalogIndex,
  activeProviderName,
  NotConfiguredError,
  VALID_MODES,
};
