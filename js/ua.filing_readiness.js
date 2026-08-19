/**
 * Local, evidence-bound filing-readiness gate for the two-stage AI workflow.
 * The model may make this result stricter, but can never upgrade it.
 */
(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const SCHEMA_VERSION = 'unfallwerkbank.filingReadiness.v1';
  const REQUIRED_MAP_MODES = Object.freeze(['standard', 'hybrid', 'orthophoto', 'analysis']);
  const OPENED_RESOURCE_STATUSES = new Set(['opened', 'read', 'accessed', 'verified']);
  const IGNORED_PATTERN_STATUSES = new Set([
    'not-detected', 'not_detected', 'not-applicable', 'irrelevant', 'dismissed', 'skipped',
  ]);
  const CONDITIONAL_POLITICAL_STATUSES = new Set([
    'searched-no-results', 'results-found-unusable',
  ]);
  const POLITICAL_ERROR_CODES = new Set([
    'political-status', 'political-readiness-conflict', 'political-research-blocked',
    'political-evidence-missing', 'political-status-unknown',
  ]);
  const POLITICAL_WARNING_CODES = new Set([
    'political-research-incomplete', 'political-research-conditional',
    'model-readiness-overstated',
  ]);

  const clean = value => String(value == null ? '' : value).trim();
  const list = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const unique = values => [...new Set(list(values).map(clean).filter(Boolean))];

  function normaliseUrl(value) {
    const raw = clean(value);
    if (!raw) return '';
    try {
      const url = new URL(raw, 'https://unfallwerkbank.invalid/');
      url.hash = '';
      const entries = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
        aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
      url.search = '';
      entries.forEach(([key, item]) => url.searchParams.append(key, item));
      return url.href;
    } catch (_) {
      return raw;
    }
  }

  function absoluteHttpUrl(value) {
    const raw = clean(value);
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return normaliseUrl(url.href);
    } catch (_) {
      return '';
    }
  }

  function findingId(finding) {
    return clean(finding?.patternId || finding?.id || finding?.detectorId || finding?.key);
  }

  function collectPatternFindings(facts) {
    const structured = facts?.structured || {};
    const candidates = [
      structured.patternDetection?.findings,
      structured.patternAnalysis?.findings,
      structured.features?.patternAnalysis?.findings,
      structured.features?.patternDetection?.findings,
      facts?.patternDetection?.findings,
      facts?.patternAnalysis?.findings,
    ];
    const findings = [];
    const seen = new Set();
    for (const candidate of candidates) {
      for (const finding of list(candidate)) {
        const id = findingId(finding);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        findings.push({ id, status: clean(finding?.status).toLowerCase() || 'detected' });
      }
    }
    return findings;
  }

  function expectedInspectionViews(facts) {
    const structured = facts?.structured || {};
    const candidates = [
      facts?.visualSceneAnalysisContract?.inspectionViews,
      structured?.visualSceneAnalysisContract?.inspectionViews,
      facts?.aiResearchHandoff?.visualSceneAnalysisContract?.inspectionViews,
      structured?.aiResearchHandoff?.visualSceneAnalysisContract?.inspectionViews,
    ];
    const views = candidates.find(candidate => list(candidate).length) || [];
    return new Map(list(views)
      .map(view => [clean(view?.mapMode).toLowerCase(), normaliseUrl(view?.url)])
      .filter(([mode, url]) => mode && url));
  }

  function politicalEvidenceUrl(item) {
    return absoluteHttpUrl(item?.sourceUrl || item?.url || item?.link);
  }

  function linkedPoliticalEvidence(political) {
    return [...list(political?.proceedings), ...list(political?.projects)]
      .filter(item => politicalEvidenceUrl(item));
  }

  function documentedPoliticalQueries(political) {
    return list(political?.queries).filter(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const query = clean(item.query || item.searchTerm || item.term);
      const namedSource = clean(
        item.sourceType || item.source || item.provider || item.portal || item.system
      );
      const sourceUrl = absoluteHttpUrl(item.url || item.endpoint || item.sourceUrl);
      return Boolean(query && (namedSource || sourceUrl));
    });
  }

  function classifyPoliticalResearch(political) {
    const status = clean(political?.status).toLowerCase();
    const claimedLinkedCount = [...list(political?.proceedings), ...list(political?.projects)]
      .filter(item => clean(item?.sourceUrl || item?.url || item?.link)).length;
    const linked = linkedPoliticalEvidence(political);
    const queries = documentedPoliticalQueries(political);
    const manualVerificationClaimed = political?.alternativeVerificationCompleted === true
      || political?.manualVerificationCompleted === true;

    if (!queries.length) {
      return {
        status: 'blocked', sourceStatus: status || 'missing', linkedCount: linked.length,
        claimedLinkedCount, queryCount: 0,
        reason: 'Zur politischen oder administrativen Recherche fehlt ein nachvollziehbares Suchprotokoll mit Suchbegriff und Quelle beziehungsweise Portal.',
      };
    }

    if (status === 'results-found') {
      return linked.length
        ? {
          status: 'complete', sourceStatus: status, linkedCount: linked.length,
          claimedLinkedCount, queryCount: queries.length,
        }
        : {
          status: 'blocked', sourceStatus: status, linkedCount: 0,
          claimedLinkedCount, queryCount: queries.length,
          reason: 'Politische Treffer wurden behauptet, aber kein direkt verifizierbarer HTTP(S)-Link zu einem Vorgang oder Verwaltungsprojekt übergeben.',
        };
    }
    if (status === 'completed' || status === 'complete') {
      return linked.length
        ? {
          status: 'complete', sourceStatus: status, linkedCount: linked.length,
          claimedLinkedCount, queryCount: queries.length, manualVerificationClaimed,
        }
        : {
          status: 'blocked', sourceStatus: status, linkedCount: 0,
          claimedLinkedCount, queryCount: queries.length, manualVerificationClaimed,
          reason: manualVerificationClaimed
            ? 'Eine manuelle oder alternative Prüfung wurde nur behauptet; ohne direkt verlinkte HTTP(S)-Evidenz darf sie das Einreichungs-Gate nicht freigeben.'
            : 'Die Recherche wurde als vollständig bezeichnet, ohne direkt verlinkte HTTP(S)-Treffer.',
        };
    }
    if (CONDITIONAL_POLITICAL_STATUSES.has(status)) {
      return {
        status: 'conditional', sourceStatus: status, linkedCount: linked.length,
        claimedLinkedCount, queryCount: queries.length,
        reason: 'Die politische Vorbefassung ist nicht abschließend belegt; eine alternative Portal- oder manuelle Prüfung bleibt erforderlich.',
      };
    }
    return {
      status: 'blocked', sourceStatus: status || 'missing', linkedCount: linked.length,
      claimedLinkedCount, queryCount: queries.length,
      reason: 'Politische Recherche ist nicht belastbar abgeschlossen (' + (status || 'Status fehlt') + ').',
    };
  }

  function addRegistryValue(registry, value) {
    const id = clean(value);
    if (!id) return;
    registry.add(id);
    const normalised = normaliseUrl(id);
    if (normalised) registry.add(normalised);
  }

  function buildEvidenceRegistry(result, options = {}) {
    const ids = new Set();
    const includeMapObservationIds = options.includeMapObservationIds !== false;
    list(result?.accessedResources).forEach(item => {
      addRegistryValue(ids, item?.id);
      addRegistryValue(ids, item?.url);
    });
    if (includeMapObservationIds) {
      list(result?.mapObservations).forEach(item => addRegistryValue(ids, item?.id));
    }
    list(result?.patternEvaluations).forEach(item => {
      addRegistryValue(ids, findingId(item));
      addRegistryValue(ids, item?.detectorId);
    });
    list(result?.accidentBackgroundResearch?.results).forEach(item => {
      addRegistryValue(ids, item?.id);
      addRegistryValue(ids, item?.sourceUrl);
      addRegistryValue(ids, item?.url);
    });
    [...list(result?.politicalAdministrativeResearch?.proceedings),
      ...list(result?.politicalAdministrativeResearch?.projects)]
      .filter(item => politicalEvidenceUrl(item))
      .forEach(item => {
        addRegistryValue(ids, item?.id);
        addRegistryValue(ids, politicalEvidenceUrl(item));
      });
    return ids;
  }

  function buildFindingRegistry(result) {
    const ids = new Set();
    list(result?.mapObservations).forEach(item => addRegistryValue(ids, item?.id));
    list(result?.patternEvaluations).forEach(item => {
      addRegistryValue(ids, findingId(item));
      addRegistryValue(ids, item?.detectorId);
    });
    list(result?.crossLayerInsights).forEach(item => addRegistryValue(ids, item?.id));
    return ids;
  }

  function resourceLayer(resource) {
    if (clean(resource?.mapMode)) return 'map';
    const type = clean(resource?.resourceType).toLowerCase();
    if (/ris|oparl|politic|administr/.test(type)) return 'political-administrative';
    if (/police|official|research|document|article|report|source/.test(type)) {
      return 'accident-background';
    }
    return 'external-resource';
  }

  function addLayerValue(registry, value, layer) {
    const id = clean(value);
    if (!id || !layer) return;
    const keys = unique([id, normaliseUrl(id)]);
    for (const key of keys) {
      if (!registry.has(key)) registry.set(key, new Set());
      registry.get(key).add(layer);
    }
  }

  function buildEvidenceLayerRegistry(result, options = {}) {
    const layers = new Map();
    const includeMapObservationIds = options.includeMapObservationIds !== false;
    list(result?.accessedResources).forEach(item => {
      const layer = resourceLayer(item);
      addLayerValue(layers, item?.id, layer);
      addLayerValue(layers, item?.url, layer);
    });
    if (includeMapObservationIds) {
      list(result?.mapObservations).forEach(item => addLayerValue(layers, item?.id, 'map'));
    }
    list(result?.patternEvaluations).forEach(item => {
      addLayerValue(layers, findingId(item), 'pattern');
      addLayerValue(layers, item?.detectorId, 'pattern');
    });
    list(result?.accidentBackgroundResearch?.results).forEach(item => {
      addLayerValue(layers, item?.id, 'accident-background');
      addLayerValue(layers, item?.sourceUrl, 'accident-background');
      addLayerValue(layers, item?.url, 'accident-background');
    });
    [...list(result?.politicalAdministrativeResearch?.proceedings),
      ...list(result?.politicalAdministrativeResearch?.projects)]
      .filter(item => politicalEvidenceUrl(item))
      .forEach(item => {
        addLayerValue(layers, item?.id, 'political-administrative');
        addLayerValue(layers, politicalEvidenceUrl(item), 'political-administrative');
      });
    return layers;
  }

  function evidenceLayersForRefs(refs, registry) {
    const layers = new Set();
    for (const ref of unique(refs)) {
      const direct = registry.get(ref);
      const normalised = registry.get(normaliseUrl(ref));
      for (const layer of direct || []) layers.add(layer);
      for (const layer of normalised || []) layers.add(layer);
    }
    return layers;
  }

  function unresolvedEvidenceRefs(refs, registry) {
    return unique(refs).filter(ref => !registry.has(ref) && !registry.has(normaliseUrl(ref)));
  }

  function evaluate(options = {}) {
    const result = object(options.result);
    const facts = object(options.facts);
    const errors = list(options.errors).map(item => ({ ...item }));
    const warnings = list(options.warnings).map(item => ({ ...item }));
    const checks = list(options.checks).map(item => ({ ...item }));
    const errorCodes = new Set(errors.map(item => clean(item?.code)));
    const warningCodes = new Set(warnings.map(item => clean(item?.code)));
    const checkCodes = new Set(checks.map(item => clean(item?.code)));
    const fail = (code, message, details) => {
      if (!errorCodes.has(code)) {
        errors.push({ code, message, details: details || null });
        errorCodes.add(code);
      }
      if (!checkCodes.has(code)) {
        checks.push({ code, passed: false, message });
        checkCodes.add(code);
      }
    };
    const pass = (code, message) => {
      if (!checkCodes.has(code)) {
        checks.push({ code, passed: true, message });
        checkCodes.add(code);
      }
    };
    const warn = (code, message, details) => {
      if (!warningCodes.has(code)) {
        warnings.push({ code, message, details: details || null });
        warningCodes.add(code);
      }
    };

    const requiredModes = list(options.requiredMapModes).length
      ? unique(options.requiredMapModes).map(mode => mode.toLowerCase())
      : [...REQUIRED_MAP_MODES];
    const expectedViews = expectedInspectionViews(facts);
    const resources = list(result.accessedResources);
    for (const mode of requiredModes) {
      const opened = resources.filter(resource =>
        OPENED_RESOURCE_STATUSES.has(clean(resource?.status).toLowerCase())
        && clean(resource?.mapMode).toLowerCase() === mode);
      if (!opened.length) {
        fail('map-mode-' + mode, 'Kartenmodus ' + mode + ' wurde nicht als geöffnet protokolliert.');
        continue;
      }
      const expectedUrl = expectedViews.get(mode);
      if (!expectedUrl) {
        fail('map-url-contract-' + mode,
          'Für Kartenmodus ' + mode + ' fehlt die snapshotgebundene Soll-URL im Faktenpaket.');
        continue;
      }
      const observedUrls = opened.map(resource => normaliseUrl(resource?.url));
      if (!observedUrls.includes(expectedUrl)) {
        fail('map-url-' + mode,
          'Kartenmodus ' + mode + ' wurde nicht mit der für diesen Analysesnapshot gebundenen URL geöffnet.',
          { expectedUrl, observedUrls });
      } else {
        pass('map-url-' + mode, 'Kartenmodus ' + mode + ' ist an die erwartete Analyse-URL gebunden.');
      }
    }

    const allFindings = list(options.expectedPatterns).length
      ? list(options.expectedPatterns).map(item => ({ id: findingId(item), status: clean(item?.status).toLowerCase() }))
      : collectPatternFindings(facts);
    const expectedPatterns = allFindings.filter(item =>
      item.id && !IGNORED_PATTERN_STATUSES.has(item.status));
    const evaluated = new Set(list(result.patternEvaluations).map(findingId).filter(Boolean));
    for (const pattern of expectedPatterns) {
      if (!evaluated.has(pattern.id)) {
        fail('pattern-' + pattern.id,
          'Deterministischer Muster- oder Datenqualitätsbefund ' + pattern.id + ' wurde nicht bewertet.');
      }
    }
    if (expectedPatterns.length) {
      pass('filing-pattern-coverage',
        expectedPatterns.length + ' relevante Muster- und Datenqualitätsbefunde wurden in den Gate-Vertrag aufgenommen.');
    }

    const evidenceRegistry = buildEvidenceRegistry(result);
    const nonObservationEvidenceRegistry = buildEvidenceRegistry(result, {
      includeMapObservationIds: false,
    });
    const evidenceLayerRegistry = buildEvidenceLayerRegistry(result);
    const findingRegistry = buildFindingRegistry(result);
    const checkRefs = (items, field, prefix, label, registry, minimumRefs, minimumLayers = 0) => {
      list(items).forEach((item, index) => {
        const refs = unique(item?.[field]);
        const code = prefix + '-' + (index + 1);
        if (refs.length < minimumRefs) {
          fail(code,
            label + ' ' + (index + 1) + ' benötigt mindestens '
              + minimumRefs + ' auflösbare Evidenzreferenz'
              + (minimumRefs === 1 ? '' : 'en') + '.',
            { required: minimumRefs, actual: refs.length });
          return;
        }
        const unresolved = unresolvedEvidenceRefs(refs, registry);
        if (unresolved.length) {
          fail(code,
            label + ' ' + (index + 1) + ' verweist auf unbekannte Evidenz: ' + unresolved.join(', ') + '.');
          return;
        }
        if (minimumLayers) {
          const layers = evidenceLayersForRefs(refs, evidenceLayerRegistry);
          if (layers.size < minimumLayers) {
            fail(code,
              label + ' ' + (index + 1) + ' benötigt Evidenz aus mindestens '
                + minimumLayers + ' unabhängigen Schichten; erkannt: '
                + ([...layers].join(', ') || 'keine') + '.',
              { requiredLayers: minimumLayers, observedLayers: [...layers] });
          }
        }
      });
    };
    checkRefs(
      result.mapObservations,
      'evidenceRefs',
      'map-observation-evidence',
      'Kartenbeobachtung',
      nonObservationEvidenceRegistry,
      1
    );
    checkRefs(
      result.crossLayerInsights,
      'evidenceRefs',
      'cross-layer-evidence',
      'Einsicht',
      evidenceRegistry,
      2,
      2
    );
    checkRefs(
      result.candidateMeasures,
      'findingRefs',
      'measure-evidence',
      'Maßnahmenkandidat',
      findingRegistry,
      1
    );

    const politicalGate = classifyPoliticalResearch(object(result.politicalAdministrativeResearch));
    if (politicalGate.status === 'blocked') {
      fail('political-research-blocked', politicalGate.reason, politicalGate);
    } else if (politicalGate.status === 'conditional') {
      warn('political-research-conditional', politicalGate.reason, politicalGate);
    } else {
      pass('political-research-complete',
        'Politische Recherche ist nachvollziehbar abgeschlossen (' + politicalGate.linkedCount + ' verlinkte Treffer).');
    }

    const modelStatus = clean(result?.filingReadiness?.status).toLowerCase();
    const analysisErrors = errors.filter(error => !POLITICAL_ERROR_CODES.has(clean(error?.code)));
    const analysisWarnings = warnings.filter(warning => !POLITICAL_WARNING_CODES.has(clean(warning?.code)));
    const analysisQaStatus = analysisErrors.length
      ? 'blocked'
      : (analysisWarnings.length ? 'conditional' : 'ready');
    const politicalResearchStatus = politicalGate.status;
    let filingReadinessStatus = analysisQaStatus === 'blocked' || politicalResearchStatus === 'blocked'
      ? 'blocked'
      : (analysisQaStatus === 'conditional' || politicalResearchStatus === 'conditional'
        ? 'conditional' : 'ready');

    if (modelStatus === 'blocked') filingReadinessStatus = 'blocked';
    else if (modelStatus === 'conditional' && filingReadinessStatus === 'ready') {
      filingReadinessStatus = 'conditional';
    } else if (modelStatus === 'ready' && filingReadinessStatus !== 'ready') {
      warn('model-readiness-overstated',
        'Die KI hat „ready“ angegeben; das lokale Evidenz-Gate stuft den Zustand strenger ein.');
    }

    const passed = errors.length === 0;
    const readyForApplication = passed && filingReadinessStatus !== 'blocked';
    const filingReady = passed && filingReadinessStatus === 'ready';
    const possible = Math.max(1, checks.length);
    const successful = checks.filter(check => check.passed).length;
    return {
      schemaVersion: SCHEMA_VERSION,
      evaluatedAt: new Date().toISOString(),
      passed,
      readyForApplication,
      filingReady,
      analysisQaStatus,
      politicalResearchStatus,
      filingReadinessStatus,
      modelFilingReadinessStatus: ['ready', 'conditional', 'blocked'].includes(modelStatus)
        ? modelStatus : 'blocked',
      score: Math.round((successful / possible) * 100),
      expectedPatternIds: expectedPatterns.map(item => item.id),
      errors,
      warnings,
      checks,
    };
  }

  UA.filingReadiness = Object.freeze({
    SCHEMA_VERSION,
    REQUIRED_MAP_MODES,
    evaluate,
    classifyPoliticalResearch,
    normaliseUrl,
    absoluteHttpUrl,
    collectPatternFindings,
    buildEvidenceRegistry,
    buildEvidenceLayerRegistry,
    buildFindingRegistry,
    documentedPoliticalQueries,
    evidenceLayersForRefs,
    unresolvedEvidenceRefs,
  });
})();
