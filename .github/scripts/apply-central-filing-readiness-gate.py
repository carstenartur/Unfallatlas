from pathlib import Path


def replace_once(source, old, new, label):
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one anchor, found {count}')
    return source.replace(old, new, 1)


# Load the pure readiness module before the UI that consumes it.
path = Path('js/ua.data_paths.js')
source = path.read_text(encoding='utf-8')
source = replace_once(
    source,
    """  const existingPromises = UA.optionalModulePromises || {};
  UA.optionalModulePromises = Object.freeze({""",
    """  const existingPromises = UA.optionalModulePromises || {};
  const filingReadinessPromise = injectOptionalModuleAfterDomReady(
    'js/ua.filing_readiness.js?v=2026-08-18',
    'data-ua-filing-readiness'
  );
  UA.optionalModulePromises = Object.freeze({""",
    'filing readiness loader declaration',
)
source = replace_once(
    source,
    """    // The export modal may be opened long after the analysis adapter installed.
    // Keep its enhanced copy/download actions bound through modal recreation.
    aiVisualResearchUi: injectOptionalModuleAfterDomReady(
      'js/ua.ai_visual_research_ui.js?v=2026-08-16',
      'data-ua-ai-visual-research-ui'
    ),""",
    """    // Filing readiness is derived locally before the UI may release phase two.
    filingReadiness: filingReadinessPromise,
    // The export modal may be opened long after the analysis adapter installed.
    // Keep its enhanced copy/download actions bound through modal recreation.
    aiVisualResearchUi: filingReadinessPromise.then(() => injectOptionalModuleAfterDomReady(
      'js/ua.ai_visual_research_ui.js?v=2026-08-18',
      'data-ua-ai-visual-research-ui'
    )),""",
    'filing readiness UI dependency',
)
path.write_text(source, encoding='utf-8')

# Keep the UI focused on orchestration; the new module owns readiness logic.
path = Path('js/ua.ai_visual_research_ui.js')
source = path.read_text(encoding='utf-8')
source = replace_once(
    source,
    """      return {
        schemaVersion: VALIDATION_SCHEMA, passed: false, readyForApplication: false,
        filingReady: false, score: 0, errors, warnings, checks, result: null,
      };""",
    """      return {
        schemaVersion: VALIDATION_SCHEMA,
        filingReadinessSchemaVersion: null,
        passed: false,
        readyForApplication: false,
        filingReady: false,
        analysisQaStatus: 'blocked',
        politicalResearchStatus: 'blocked',
        filingReadinessStatus: 'blocked',
        modelFilingReadinessStatus: 'blocked',
        score: 0, errors, warnings, checks, result: null,
      };""",
    'invalid JSON blocked status',
)
start = source.index('    const passed = errors.length === 0;')
end = source.index('\n  function buildApplicationPrompt', start)
if start < 0 or end < 0:
    raise SystemExit('final validation anchors not found')
source = source[:start] + """    const evaluator = UA.filingReadiness?.evaluate;
    if (typeof evaluator !== 'function') {
      fail('filing-readiness-gate-missing',
        'Das zentrale lokale Einreichungsreife-Gate ist nicht geladen; Antragserzeugung bleibt gesperrt.');
    }
    const gate = typeof evaluator === 'function'
      ? evaluator({
        result,
        facts: facts || {},
        expectedPatterns: collectPatternFindings(facts || {}),
        requiredMapModes: REQUIRED_MAP_MODES,
        errors,
        warnings,
        checks,
      })
      : {
        schemaVersion: null,
        passed: false,
        readyForApplication: false,
        filingReady: false,
        analysisQaStatus: 'blocked',
        politicalResearchStatus: 'blocked',
        filingReadinessStatus: 'blocked',
        modelFilingReadinessStatus: readinessStatus || 'blocked',
        score: 0,
        expectedPatternIds: expectedPatterns.map(item => item.id),
        errors, warnings, checks,
      };
    return {
      schemaVersion: VALIDATION_SCHEMA,
      filingReadinessSchemaVersion: gate.schemaVersion || null,
      validatedAt: new Date().toISOString(),
      passed: gate.passed,
      readyForApplication: gate.readyForApplication,
      filingReady: gate.filingReady,
      analysisQaStatus: gate.analysisQaStatus,
      politicalResearchStatus: gate.politicalResearchStatus,
      filingReadinessStatus: gate.filingReadinessStatus,
      modelFilingReadinessStatus: gate.modelFilingReadinessStatus,
      score: gate.score,
      deterministicFacts: expectedFacts,
      expectedPatternIds: gate.expectedPatternIds || expectedPatterns.map(item => item.id),
      errors: gate.errors,
      warnings: gate.warnings,
      checks: gate.checks,
      result,
    };
  }
""" + source[end:]
source = replace_once(
    source,
    """      validation: {
        score: check.score,
        filingReadinessStatus: check.filingReadinessStatus,
        warnings: check.warnings,
      },""",
    """      validation: {
        score: check.score,
        analysisQaStatus: check.analysisQaStatus,
        politicalResearchStatus: check.politicalResearchStatus,
        filingReadinessStatus: check.filingReadinessStatus,
        modelFilingReadinessStatus: check.modelFilingReadinessStatus,
        warnings: check.warnings,
      },""",
    'application validation payload',
)
source = replace_once(
    source,
    """        lastValidation = validateInvestigationResult(lastInvestigation, handoff.facts);
        applicationButton.disabled = !lastValidation.readyForApplication;""",
    """        lastValidation = validateInvestigationResult(lastInvestigation, handoff.facts);
        const structured = handoff?.facts?.structured;
        if (structured && typeof structured === 'object') {
          structured.aiInvestigationResult = lastInvestigation;
          structured.aiInvestigationValidation = lastValidation;
          structured.filingReadiness = {
            schemaVersion: lastValidation.filingReadinessSchemaVersion,
            analysisQaStatus: lastValidation.analysisQaStatus,
            politicalResearchStatus: lastValidation.politicalResearchStatus,
            filingReadinessStatus: lastValidation.filingReadinessStatus,
            modelFilingReadinessStatus: lastValidation.modelFilingReadinessStatus,
            filingReady: lastValidation.filingReady,
          };
        }
        applicationButton.disabled = !lastValidation.readyForApplication;""",
    'persist central readiness result',
)
source = replace_once(
    source,
    """          `Einreichungsstatus: ${lastValidation.filingReadinessStatus}`,
          ...lastValidation.errors.map(error => `FEHLER: ${error.message}`),""",
    """          `Analyse-QA: ${lastValidation.analysisQaStatus}`,
          `Politische Recherche: ${lastValidation.politicalResearchStatus}`,
          `Lokaler Einreichungsstatus: ${lastValidation.filingReadinessStatus}`,
          ...lastValidation.errors.map(error => `FEHLER: ${error.message}`),""",
    'display central readiness statuses',
)
path.write_text(source, encoding='utf-8')

# Unit integration fixture: load the gate first, bind URLs and link political evidence.
path = Path('tests/unit/ua.ai_investigation.test.js')
source = path.read_text(encoding='utf-8')
source = replace_once(
    source,
    """function loadModule(windowValue) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../js/ua.ai_visual_research_ui.js'),
    'utf8'
  );
  (function evaluate(window) { eval(source); })(windowValue);
  return windowValue.UA.aiInvestigation;
}""",
    """function loadModule(windowValue) {
  for (const filename of ['ua.filing_readiness.js', 'ua.ai_visual_research_ui.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../js', filename), 'utf8');
    (function evaluate(window) { eval(source); })(windowValue);
  }
  return windowValue.UA.aiInvestigation;
}""",
    'test module loading order',
)
source = replace_once(
    source,
    """    structured: {
      meta: { city: 'Hannover' },""",
    """    visualSceneAnalysisContract: {
      inspectionViews: ['standard', 'hybrid', 'orthophoto', 'analysis'].map(mapMode => ({
        mapMode,
        url: `https://example.test/werkbank_v2.html?mapMode=${mapMode}`,
      })),
    },
    structured: {
      meta: { city: 'Hannover' },""",
    'test inspection view contract',
)
source = replace_once(
    source,
    """    politicalAdministrativeResearch: {
      status: 'results-found', queries: [], proceedings: [], projects: [], gaps: [],
    },""",
    """    politicalAdministrativeResearch: {
      status: 'results-found',
      queries: [{ query: 'Hannover Verkehrssicherheit', sourceType: 'official-ris' }],
      proceedings: [{
        id: 'political-1',
        title: 'Verkehrssicherheit im Untersuchungsbereich',
        sourceUrl: 'https://example.test/ris/political-1',
      }],
      projects: [], gaps: [],
    },""",
    'linked political fixture',
)
path.write_text(source, encoding='utf-8')

# Extend the investigation result schema with explicit alternative verification.
path = Path('schemas/ai-investigation-result.schema.json')
source = path.read_text(encoding='utf-8')
source = replace_once(
    source,
    '            "results-found", "searched-no-results", "completed", "complete",',
    '            "results-found", "results-found-unusable", "searched-no-results", "completed", "complete",',
    'political status enum',
)
source = replace_once(
    source,
    '        "gaps": { "type": "array", "items": { "type": "string" } }',
    '        "gaps": { "type": "array", "items": { "type": "string" } },\n        "alternativeVerificationCompleted": { "type": "boolean" },\n        "manualVerificationCompleted": { "type": "boolean" }',
    'political verification properties',
)
path.write_text(source, encoding='utf-8')

Path('.github/workflows/apply-central-filing-readiness-gate.yml').unlink()
Path('.github/scripts/apply-central-filing-readiness-gate.py').unlink()
trigger = Path('.github/workflows/central-filing-readiness-trigger.txt')
if trigger.exists():
    trigger.unlink()
