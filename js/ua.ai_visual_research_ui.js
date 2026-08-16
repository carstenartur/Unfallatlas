/**
 * Two-stage, evidence-gated AI workflow for the Unfallwerkbank.
 *
 * Stage 1 produces a structured investigation request. The returned JSON is
 * validated locally against the deterministic Unfallwerkbank facts, map-view
 * coverage, pattern coverage, research traceability and filing readiness.
 * Stage 2 (application drafting) is only enabled after that validation passes.
 */
(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});

  const INVESTIGATION_REQUEST_SCHEMA = 'unfallwerkbank.aiInvestigationRequest.v1';
  const INVESTIGATION_RESULT_SCHEMA = 'unfallwerkbank.aiInvestigationResult.v1';
  const VALIDATION_SCHEMA = 'unfallwerkbank.aiInvestigationValidation.v1';
  const APPLICATION_REQUEST_SCHEMA = 'unfallwerkbank.aiApplicationRequest.v1';
  const REQUIRED_MAP_MODES = Object.freeze(['standard', 'hybrid', 'orthophoto', 'analysis']);
  const READY_STATUSES = new Set(['ready', 'conditional']);
  const COMPLETE_POLITICAL_STATUSES = new Set([
    'results-found', 'searched-no-results', 'completed', 'complete',
  ]);
  const OPENED_RESOURCE_STATUSES = new Set(['opened', 'read', 'accessed', 'verified']);

  let observer = null;
  let lastHandoff = null;
  let lastInvestigation = null;
  let lastValidation = null;

  const clean = value => String(value == null ? '' : value).trim();
  const list = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const finite = value => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const unique = values => [...new Set(list(values).map(clean).filter(Boolean))];

  function sortJson(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortJson);
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson(value[key])]));
  }

  function stableJson(value) {
    const shared = UA.aiLinkHandoff?._internal?.stableJson;
    return typeof shared === 'function'
      ? shared(value)
      : JSON.stringify(sortJson(value), null, 2);
  }

  function stripJsonFence(value) {
    return clean(value)
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
  }

  function parseInvestigationResult(value) {
    if (value && typeof value === 'object') return value;
    const text = stripJsonFence(value);
    if (!text) throw new Error('Leere KI-Antwort. Erwartet wird das JSON-Ergebnis der Untersuchungsphase.');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`KI-Antwort ist kein gültiges JSON: ${error?.message || error}`);
    }
  }

  function deterministicFacts(facts) {
    const structured = facts?.structured || {};
    const digest = facts?.deterministicAnalysisDigest
      || structured?.deterministicAnalysisDigest || {};
    const official = digest?.officialAccidentFacts || {};
    const severity = structured?.severity || {};
    const bySeverity = severity?.bySev || {};
    return {
      total: finite(official.total ?? severity.total ?? structured.totalAccidents),
      fatal: finite(official.fatal ?? bySeverity['1']),
      serious: finite(official.serious ?? bySeverity['2']),
      slight: finite(official.slight ?? bySeverity['3']),
      other: finite(official.other ?? bySeverity.other),
    };
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
    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
      for (const finding of list(candidate)) {
        const id = findingId(finding);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          status: clean(finding?.status) || 'detected',
          family: clean(finding?.family),
          detectorId: clean(finding?.detector?.id || finding?.detectorId),
          title: clean(finding?.title || finding?.label || finding?.summary),
        });
      }
    }
    return out;
  }

  function inspectionViews(handoff) {
    const explicit = list(handoff?.visualInspectionViews);
    if (explicit.length) return explicit;
    return list(handoff?.facts?.visualSceneAnalysisContract?.inspectionViews);
  }

  function buildInvestigationRequest(handoff) {
    const facts = handoff?.facts || {};
    const patterns = collectPatternFindings(facts);
    const views = inspectionViews(handoff);
    return {
      schemaVersion: INVESTIGATION_REQUEST_SCHEMA,
      createdAt: handoff?.createdAt || new Date().toISOString(),
      city: handoff?.city || facts?.city || facts?.structured?.meta?.city || null,
      analysisUrl: handoff?.analysisUrl || facts?.mapUrl || null,
      purpose: 'Evidence-based investigation before drafting a municipal road-safety application.',
      hardSeparationOfStages: {
        currentStage: 'investigation-only',
        forbiddenInThisStage: [
          'fertiger Antrag', 'Beschlussvorschlag', 'rhetorische Glättung ohne zusätzliche Prüfung',
        ],
        nextStage: 'application drafting only after local validation of the investigation JSON',
      },
      deterministicAuthority: {
        officialAccidentFacts: deterministicFacts(facts),
        methodology: facts?.analysisMethodology
          || facts?.structured?.analysisMethodology || null,
        digest: facts?.deterministicAnalysisDigest
          || facts?.structured?.deterministicAnalysisDigest || null,
        rule: 'Amtliche Unfalltatsachen und reproduzierbare Berechnungen unverändert bewahren; Unsicherheit betrifft Ableitungen, nicht die dokumentierten Ereignisse.',
      },
      requiredMapViews: views,
      requiredPatternCoverage: patterns,
      visualSceneAnalysisContract: handoff?.visualSceneAnalysisContract
        || facts?.visualSceneAnalysisContract || null,
      accidentBackgroundResearchContract: handoff?.accidentBackgroundResearchContract
        || facts?.accidentBackgroundResearchContract || null,
      politicalResearch: facts?.structured?.politicalContextResearch
        || facts?.evidenceContract?.politicalContext || null,
      aiValueAddContract: facts?.aiAnalysisComparisonContract
        || facts?.structured?.aiAnalysisComparisonContract || null,
      facts,
      expectedResultSchema: INVESTIGATION_RESULT_SCHEMA,
    };
  }

  function investigationResultSkeleton(request) {
    const expected = request?.deterministicAuthority?.officialAccidentFacts || {};
    return {
      schemaVersion: INVESTIGATION_RESULT_SCHEMA,
      investigationId: 'stable-id-or-timestamp',
      verifiedOfficialAccidentFacts: expected,
      methodologyVerification: {
        patternCompositionMethodCorrect: true,
        yearlyTrendMethodCorrect: true,
        notes: [],
      },
      accessedResources: [{
        id: 'analysis-standard', url: request?.analysisUrl || '',
        resourceType: 'interactive-map', mapMode: 'standard',
        status: 'opened', accessedAt: 'ISO-8601', limitations: [],
      }],
      mapObservations: [{
        id: 'map-1', featureClass: 'rails-and-track-interface',
        locationDescription: '', viewIdAndZoom: '', visibleEvidence: '',
        accidentSubset: '', spatialRelationToAccidents: '', proximityOrOverlap: '',
        mechanismHypothesis: '', causalStatus: 'spatial-association',
        confidence: 'medium', alternativeExplanation: '',
        requiredVerification: [], evidenceRefs: [],
      }],
      patternEvaluations: [{
        patternId: request?.requiredPatternCoverage?.[0]?.id || '',
        detectorId: request?.requiredPatternCoverage?.[0]?.detectorId || '',
        status: 'supported|weakened|not-assessable|rejected',
        assessment: '', evidenceRefs: [], counterEvidence: [],
        causalStatus: 'descriptive-association', confidence: 'medium',
        requiredVerification: [],
      }],
      accidentBackgroundResearch: {
        queries: [{ query: '', sourceType: 'official-police', resultCount: 0 }],
        results: [], nullResults: [],
      },
      politicalAdministrativeResearch: {
        status: 'results-found|searched-no-results|failed|unavailable',
        queries: [], proceedings: [], projects: [], gaps: [],
      },
      crossLayerInsights: [{
        id: 'insight-1', statement: '', evidenceRefs: ['map-1', 'pattern-id'],
        decisionRelevance: '', confidence: 'medium',
      }],
      competingHypotheses: [{
        claimOrPattern: '', hypotheses: [], discriminatingChecks: [],
      }],
      candidateMeasures: [{
        findingRefs: [], safetyObjective: '', option: '', prerequisites: [],
        tradeOffs: [], responsibleBody: '', timeHorizon: '', successIndicators: [],
      }],
      unresolvedQuestions: [],
      deterministicVsAiDelta: {
        confirmed: [], clarified: [], added: [], rejected: [], open: [],
      },
      filingReadiness: {
        status: 'ready|conditional|blocked', blockers: [], conditions: [], rationale: '',
      },
      application: null,
    };
  }

  function buildInvestigationPrompt(handoff) {
    const request = buildInvestigationRequest(handoff);
    const views = request.requiredMapViews;
    return [
      '# Unfallwerkbank – Untersuchungsauftrag vor der Antragserstellung',
      '',
      `Vertrag: ${INVESTIGATION_REQUEST_SCHEMA}`,
      `Erwartete Antwort: ${INVESTIGATION_RESULT_SCHEMA}`,
      '',
      '## Verbindliche Prozessgrenze',
      '**Erstelle in dieser Phase keinen Antrag und keinen Beschlussvorschlag.**',
      'Untersuche zuerst die Unfallwerkbank-Analyse, die Karten, Unfallmuster, Unfallhintergründe sowie politische und administrative Vorbefassung.',
      'Antworte ausschließlich mit einem JSON-Objekt des unten beschriebenen Ergebnisschemas. Keine Markdown-Einleitung, keine Schlussprosa.',
      '',
      '## Amtlicher Tatsachenkern',
      'Die verwendeten Unfallatlasdaten beruhen auf der amtlichen Straßenverkehrsunfallstatistik auf Grundlage polizeilicher Meldungen und umfassen veröffentlichte Unfälle mit Personenschaden.',
      'Existenz, veröffentlichte Lage, Zeitraum, Schwere und kodierte Beteiligungsarten sind bestimmt wiederzugeben. Ungewissheit über Ursachen oder Maßnahmen darf diesen Tatsachenkern nicht rhetorisch abschwächen.',
      '',
      '## Pflichtarbeit',
      '1. Öffne den reproduzierbaren Analyse-Link und protokolliere den Zugriff.',
      `2. Öffne alle Kartenmodi: ${REQUIRED_MAP_MODES.join(', ')}. Verwende Übersicht und Detailzoom.`,
      '3. Verifiziere Unfallzahlen, Filter, Anteilvergleich und Mehrjahrestrend gegen den deterministischen Digest.',
      '4. Lies die Karten als Verkehrsszene: Schienen, Kurven, Querungen, Radführungswechsel, Haltestellen, Sicht, Engstellen, Park-/Lieferkonflikte und – nur bei ausreichender Evidenz – Oberflächenmerkmale.',
      '5. Ordne sichtbare Merkmale konkreten Unfallteilmengen, Punkten, Teilclustern oder Korridoren zu. Trenne räumliche Assoziation, mechanistische Plausibilität und bestätigte Ursache.',
      '6. Behandle jeden erkannten oder nicht beurteilbaren deterministischen Musterbefund ausdrücklich; fehlende Capability ist kein Negativbefund.',
      '7. Recherchiere ortsgenaue Unfallmeldungen und Kontext zuerst in amtlichen Quellen. Dokumentiere Suchbegriffe und Nulltreffer.',
      '8. Recherchiere Anträge, Beschlüsse, Verwaltungsantworten, Planungen, Zuständigkeiten und Umsetzungsfenster. Ein Ausfall der Suche darf nicht als fehlende Vorbefassung ausgegeben werden.',
      '9. Liefere mindestens drei Synthesen aus jeweils mindestens zwei unabhängigen Evidenzschichten, Gegenhypothesen und trennende Prüfungen.',
      '10. Entwickle erst Maßnahmenkandidaten als Befund→Ziel→Option→Voraussetzung→Zielkonflikt→Zuständigkeit→Erfolgskriterium. Noch keinen Antrag formulieren.',
      '',
      '## Prüfansichten',
      ...(views.length ? views.map(view => `- ${view.label || view.id}: ${view.url}`) : [`- Analyse-Link: ${request.analysisUrl || '(fehlt)'}`]),
      '',
      '## Antwortschema – alle Pflichtfelder ausfüllen',
      '```json',
      stableJson(investigationResultSkeleton(request)),
      '```',
      '',
      '## Vollständiges Untersuchungs- und Faktenpaket',
      '```json',
      stableJson(request),
      '```',
    ].join('\n');
  }

  function validateInvestigationResult(rawResult, facts) {
    let result;
    const errors = [];
    const warnings = [];
    const checks = [];
    const fail = (code, message, details) => {
      errors.push({ code, message, details: details || null });
      checks.push({ code, passed: false, message });
    };
    const pass = (code, message) => checks.push({ code, passed: true, message });
    const warn = (code, message, details) => warnings.push({ code, message, details: details || null });

    try {
      result = parseInvestigationResult(rawResult);
    } catch (error) {
      fail('invalid-json', error.message);
      return {
        schemaVersion: VALIDATION_SCHEMA, passed: false, readyForApplication: false,
        filingReady: false, score: 0, errors, warnings, checks, result: null,
      };
    }

    if (clean(result.schemaVersion) !== INVESTIGATION_RESULT_SCHEMA) {
      fail('wrong-schema', `Erwartet wird ${INVESTIGATION_RESULT_SCHEMA}.`);
    } else pass('schema', 'Ergebnisschema stimmt.');

    const expectedFacts = deterministicFacts(facts || {});
    const actualFacts = object(result.verifiedOfficialAccidentFacts);
    for (const key of ['total', 'fatal', 'serious', 'slight', 'other']) {
      if (expectedFacts[key] === null) continue;
      const actual = finite(actualFacts[key]);
      if (actual !== expectedFacts[key]) {
        fail(`official-fact-${key}`, `Amtlicher Tatsachenkern verändert: ${key} erwartet ${expectedFacts[key]}, erhalten ${actual}.`);
      } else pass(`official-fact-${key}`, `Amtlicher Wert ${key} unverändert.`);
    }

    const method = object(result.methodologyVerification);
    if (method.patternCompositionMethodCorrect !== true) {
      fail('pattern-method', 'Der lokale/stadtweite Musteranteilsvergleich wurde nicht korrekt bestätigt.');
    } else pass('pattern-method', 'Musteranteilsmethodik bestätigt.');
    const hasTrend = !!(facts?.deterministicAnalysisDigest?.yearlyTrend
      || facts?.structured?.yearlyTrend);
    if (hasTrend && method.yearlyTrendMethodCorrect !== true) {
      fail('trend-method', 'Die relative Mehrjahrestrendmethodik wurde nicht korrekt bestätigt.');
    } else if (hasTrend) pass('trend-method', 'Trendmethodik bestätigt.');

    const resources = list(result.accessedResources);
    const openedModes = new Set(resources
      .filter(resource => OPENED_RESOURCE_STATUSES.has(clean(resource?.status).toLowerCase()))
      .map(resource => clean(resource?.mapMode).toLowerCase())
      .filter(Boolean));
    for (const mode of REQUIRED_MAP_MODES) {
      if (!openedModes.has(mode)) fail(`map-mode-${mode}`, `Kartenmodus ${mode} wurde nicht als geöffnet protokolliert.`);
      else pass(`map-mode-${mode}`, `Kartenmodus ${mode} geöffnet.`);
    }
    if (!resources.some(resource => clean(resource?.url))) {
      fail('resource-log', 'Kein tatsächlich aufgerufener Ressourcen-Link dokumentiert.');
    }

    const observations = list(result.mapObservations);
    if (observations.length < 3) fail('map-observation-count', 'Mindestens drei ortsgenaue Kartenbeobachtungen sind erforderlich.');
    const requiredObservationFields = [
      'featureClass', 'locationDescription', 'viewIdAndZoom', 'visibleEvidence',
      'spatialRelationToAccidents', 'mechanismHypothesis', 'causalStatus',
      'confidence', 'alternativeExplanation',
    ];
    let linkedObservations = 0;
    observations.forEach((observation, index) => {
      const missing = requiredObservationFields.filter(field => !clean(observation?.[field]));
      if (missing.length) fail(`map-observation-${index + 1}`, `Kartenbeobachtung ${index + 1} unvollständig: ${missing.join(', ')}.`);
      if (clean(observation?.accidentSubset)
        && clean(observation?.spatialRelationToAccidents)) linkedObservations += 1;
    });
    if (linkedObservations < 2) {
      fail('map-accident-linkage', 'Mindestens zwei Kartenbeobachtungen müssen ausdrücklich mit Unfallteilmengen oder Punkten verknüpft sein.');
    } else pass('map-accident-linkage', `${linkedObservations} Kartenbefunde sind mit Unfallteilmengen verknüpft.`);

    const expectedPatterns = collectPatternFindings(facts || {})
      .filter(item => ['detected', 'not-assessable', 'supported', 'candidate'].includes(item.status));
    const evaluatedPatterns = new Set(list(result.patternEvaluations).map(findingId).filter(Boolean));
    for (const pattern of expectedPatterns) {
      if (!evaluatedPatterns.has(pattern.id)) {
        fail(`pattern-${pattern.id}`, `Deterministischer Musterbefund ${pattern.id} wurde nicht bewertet.`);
      }
    }
    if (!expectedPatterns.length) warn('no-pattern-contract', 'Das Faktenpaket enthält keine explizit auswertbaren Pattern-Findings.');
    else pass('pattern-coverage', `${expectedPatterns.length} verpflichtende Musterbefunde wurden abgeglichen.`);

    const background = object(result.accidentBackgroundResearch);
    const backgroundQueries = list(background.queries);
    if (backgroundQueries.length < 4) fail('background-query-count', 'Mindestens vier dokumentierte Unfall-/Kontextsuchanfragen sind erforderlich.');
    const officialQueries = backgroundQueries.filter(query => /official|police|feuerwehr|stadt|ris|oparl|operator|amt/i
      .test(`${query?.sourceType || ''} ${query?.source || ''}`));
    if (officialQueries.length < 2) fail('official-query-count', 'Mindestens zwei Primärquellen-/Amtssuchen sind erforderlich.');
    for (const [index, item] of list(background.results).entries()) {
      if (!clean(item?.sourceUrl) || !clean(item?.spatialMatchClass)) {
        fail(`background-result-${index + 1}`, `Recherchetreffer ${index + 1} braucht Quellen-URL und räumliche Passklasse.`);
      }
    }

    const political = object(result.politicalAdministrativeResearch);
    const politicalStatus = clean(political.status).toLowerCase();
    if (!politicalStatus) fail('political-status', 'Status der politischen/administrativen Recherche fehlt.');
    const readiness = object(result.filingReadiness);
    const readinessStatus = clean(readiness.status).toLowerCase();
    if (!['ready', 'conditional', 'blocked'].includes(readinessStatus)) {
      fail('readiness-status', 'filingReadiness.status muss ready, conditional oder blocked sein.');
    }
    if (readinessStatus === 'ready' && !COMPLETE_POLITICAL_STATUSES.has(politicalStatus)) {
      fail('political-readiness-conflict', `Einreichungsreife darf bei politischem Suchstatus „${politicalStatus || 'fehlend'}“ nicht ready sein.`);
    }
    if (!COMPLETE_POLITICAL_STATUSES.has(politicalStatus)) {
      warn('political-research-incomplete', 'Politische Recherche ist nicht vollständig; ein Antrag darf dies nicht als fehlende Vorbefassung darstellen.');
    }

    const insights = list(result.crossLayerInsights);
    if (insights.length < 3) fail('cross-layer-count', 'Mindestens drei schichtenübergreifende Einsichten sind erforderlich.');
    insights.forEach((insight, index) => {
      if (!clean(insight?.statement) || list(insight?.evidenceRefs).filter(Boolean).length < 2) {
        fail(`cross-layer-${index + 1}`, `Einsicht ${index + 1} braucht eine Aussage und mindestens zwei Evidenzreferenzen.`);
      }
    });

    const hypotheses = list(result.competingHypotheses);
    if (!hypotheses.length) fail('competing-hypotheses', 'Mindestens eine Gegenhypothese mit trennender Prüfung ist erforderlich.');
    hypotheses.forEach((entry, index) => {
      if (list(entry?.hypotheses).length < 2 || !list(entry?.discriminatingChecks).length) {
        fail(`hypothesis-${index + 1}`, `Hypothesensatz ${index + 1} braucht mindestens zwei Erklärungen und eine trennende Prüfung.`);
      }
    });

    const measures = list(result.candidateMeasures);
    if (!measures.length) fail('measure-candidates', 'Mindestens ein evidenzgebundener Maßnahmenkandidat ist erforderlich.');
    measures.forEach((measure, index) => {
      const required = ['safetyObjective', 'option', 'responsibleBody', 'timeHorizon'];
      const missing = required.filter(field => !clean(measure?.[field]));
      if (!list(measure?.findingRefs).length) missing.push('findingRefs');
      if (!list(measure?.successIndicators).length) missing.push('successIndicators');
      if (missing.length) fail(`measure-${index + 1}`, `Maßnahmenkandidat ${index + 1} unvollständig: ${missing.join(', ')}.`);
    });

    const delta = object(result.deterministicVsAiDelta);
    for (const key of ['confirmed', 'clarified', 'added', 'rejected', 'open']) {
      if (!Array.isArray(delta[key])) fail(`delta-${key}`, `Delta-Feld ${key} fehlt.`);
    }

    const application = result.application;
    if (application && (typeof application !== 'object' || Object.keys(application).length > 0)) {
      fail('premature-application', 'Die Untersuchungsphase enthält bereits einen Antrag. Die Prozessstufen müssen getrennt bleiben.');
    }

    if (readinessStatus === 'blocked' && !list(readiness.blockers).length) {
      fail('blocked-without-reasons', 'Ein blockierter Status braucht konkrete Blocker.');
    }
    if (readinessStatus === 'conditional' && !list(readiness.conditions).length) {
      fail('conditional-without-conditions', 'Ein bedingter Status braucht konkrete Bedingungen.');
    }

    const passed = errors.length === 0;
    const readyForApplication = passed && READY_STATUSES.has(readinessStatus);
    const filingReady = passed && readinessStatus === 'ready';
    const possible = Math.max(1, checks.length);
    const successful = checks.filter(check => check.passed).length;
    return {
      schemaVersion: VALIDATION_SCHEMA,
      validatedAt: new Date().toISOString(),
      passed,
      readyForApplication,
      filingReady,
      filingReadinessStatus: readinessStatus || 'blocked',
      score: Math.round((successful / possible) * 100),
      deterministicFacts: expectedFacts,
      expectedPatternIds: expectedPatterns.map(item => item.id),
      errors, warnings, checks, result,
    };
  }

  function buildApplicationPrompt(handoff, investigationResult, validation) {
    const check = validation || validateInvestigationResult(investigationResult, handoff?.facts || {});
    if (!check.passed) {
      const reasons = check.errors.map(error => error.message).join(' | ');
      throw new Error(`Untersuchung nicht validiert: ${reasons}`);
    }
    if (!check.readyForApplication) {
      throw new Error('Die validierte Untersuchung ist als blockiert eingestuft; zuerst die dokumentierten Lücken schließen.');
    }

    const conditional = check.filingReadinessStatus === 'conditional';
    const request = {
      schemaVersion: APPLICATION_REQUEST_SCHEMA,
      createdAt: new Date().toISOString(),
      status: conditional ? 'validated-conditional-draft' : 'validated-filing-ready-draft',
      deterministicFacts: handoff?.facts || {},
      validatedInvestigation: check.result,
      validation: {
        score: check.score,
        filingReadinessStatus: check.filingReadinessStatus,
        warnings: check.warnings,
      },
    };

    return [
      '# Unfallwerkbank – Antrag aus validierter Untersuchung erstellen',
      '',
      `Vertrag: ${APPLICATION_REQUEST_SCHEMA}`,
      conditional
        ? '**Erzeuge einen ausdrücklich als bedingt einreichungsreifen Entwurf. Nenne die noch zu erfüllenden Bedingungen sichtbar vor dem Beschlussvorschlag.**'
        : '**Die Untersuchungsphase ist validiert. Erzeuge nun einen einreichungsreifen kommunalpolitischen Antrag.**',
      '',
      '## Verbindliche Qualitätsanforderungen',
      '- Bewahre alle amtlichen Unfalltatsachen und deterministischen Kennzahlen exakt.',
      '- Formuliere amtlich dokumentierte Ereignisse bestimmt; verwende Vorsicht nur bei Ursachen, Kontextdeutungen und Wirkungsprognosen.',
      '- Titel und Beschluss müssen den tatsächlichen Ort und die priorisierten, validierten Konfliktmuster erkennen lassen; keine austauschbare Überschrift.',
      '- Verknüpfe Kartenbefunde, Pattern-Findings, Unfallhintergrund, politische Vorgänge und laufende Planungen. Quellen und Analyse-Deep-Links in die Anlagenliste aufnehmen.',
      '- Übernimm keine generische Maßnahmenliste. Jede Maßnahme braucht Befund, Sicherheitsziel, Voraussetzung, Zielkonflikt, zuständige Stelle, Frist und Erfolgskriterium.',
      '- Erfinde kein Gremium und keine Zuständigkeit. Bei verbleibender Unsicherheit eine klar markierte, vor Einreichung zu ersetzende Angabe verwenden.',
      '- Vermeide einen Doppelantrag: vorhandene Beschlüsse, Planungen und Verwaltungsantworten müssen als Anschluss- oder Änderungsbedarf verarbeitet werden.',
      '- Trenne Sofortmaßnahmen, vertiefte Fachprüfung und dauerhafte bauliche/verkehrsrechtliche Optionen.',
      '- Evaluation nicht nur über seltene Unfallereignisse: geeignete Konflikt-, Geschwindigkeits-, Nutzungs- und Umsetzungsindikatoren ergänzen.',
      '',
      '## Erwartete Ausgabe',
      '1. Adressat/Gremium und Antragstitel',
      '2. Präziser, nummerierter Beschlussvorschlag mit Zuständigkeiten und Fristen',
      '3. Amtlicher Tatsachenkern und reproduzierbare Unfallwerkbank-Befunde',
      '4. Orts- und musterspezifische Synthese der validierten Karten- und Recherchebefunde',
      '5. Politische/administrative Vorbefassung und Anschluss an laufende Verfahren',
      '6. Begründete Maßnahmen- und Prüfmatrix',
      '7. Erfolgskontrolle, Berichtspflicht und Termine',
      '8. Daten-, Methoden-, Unsicherheits- und Quellenhinweise',
      '9. Anlagenliste mit Analyse-Link, Kartenansichten und Quellen',
      '10. Kurzes Delta gegenüber dem deterministischen Ausgangsentwurf',
      '',
      '## Validierte Grundlage',
      '```json',
      stableJson(request),
      '```',
    ].join('\n');
  }

  function rootAnalysisContext(ctx) {
    let current = ctx;
    const seen = new Set();
    for (let depth = 0; current && typeof current === 'object' && depth < 16 && !seen.has(current); depth += 1) {
      seen.add(current);
      const parent = current.__analysisScopeOriginalCtx;
      if (!parent || parent === current) break;
      current = parent;
    }
    return current || ctx || {};
  }

  function exportBounds(ctx) {
    if (ctx?.selectionBounds) return ctx.selectionBounds;
    try { return ctx?.map?.getBounds?.() || null; } catch (_) { return null; }
  }

  function accidentPhrase(count) {
    const number = Number(count || 0);
    return `${number.toLocaleString('de-DE')} ${number === 1 ? 'Unfall' : 'Unfälle'}`;
  }

  function correctCountScopeReport(report, ctxValue) {
    if (!report || typeof report !== 'object') return report;
    const ctx = rootAnalysisContext(ctxValue);
    const scopeApi = UA.AnalysisScope;
    const bounds = exportBounds(ctx);
    if (!scopeApi?.getContextAreaPoints || !bounds) return report;

    const contextCount = scopeApi.getContextAreaPoints(ctx, bounds).length;
    const activeCount = finite(report?.structured?.scopeCounts?.activeInArea
      ?? report?.structured?.severity?.total
      ?? report?.structured?.totalAccidents);
    if (!Number.isFinite(contextCount) || contextCount < 0) return report;
    if (activeCount !== null && contextCount < activeCount) return report;

    const phrase = accidentPhrase(contextCount);
    const structured = report.structured;
    if (structured && typeof structured === 'object') {
      if (structured.scopeCounts && typeof structured.scopeCounts === 'object') {
        structured.scopeCounts = Object.freeze({
          ...structured.scopeCounts,
          areaBeforeInvolvementFilter: contextCount,
        });
      }
      if (structured.meta?.countScope) {
        structured.meta.countScope.areaBeforeInvolvementFilter = contextCount;
      }
      if (structured.methodikScope?.lines?.[1]) {
        structured.methodikScope.lines[1] = structured.methodikScope.lines[1]
          .replace(/Gebietsbestand vor Beteiligungsfilter:\s*[\d.\s]+\s+Unfälle?/, `Gebietsbestand vor Beteiligungsfilter: ${phrase}`);
      }
    }
    if (typeof report.text === 'string') {
      report.text = report.text
        .replace(/Gebietsbestand vor Beteiligungsfilter:\s*[\d.\s]+\s+Unfälle?/, `Gebietsbestand vor Beteiligungsfilter: ${phrase}`)
        .replace(/Vor dem Beteiligungsfilter liegen im selben Gebiet\s*[\d.\s]+\s+Unfälle?/, `Vor dem Beteiligungsfilter liegen im selben Gebiet ${phrase}`);
    }
    if (typeof report.html === 'string') {
      report.html = report.html
        .replace(/(Vor dem Beteiligungsfilter liegen im selben Gebiet\s*<strong>)[^<]*(<\/strong>)/,
          `$1${phrase}$2`)
        .replace(/(Gebietsbestand vor Beteiligungsfilter:\s*(?:<[^>]+>)?)[\d.\s]+\s+Unfälle?/,
          `$1${phrase}`);
    }
    return report;
  }

  function chainContains(fn, marker) {
    let current = fn;
    const seen = new Set();
    for (let depth = 0; typeof current === 'function' && depth < 32 && !seen.has(current); depth += 1) {
      if (current[marker]) return true;
      seen.add(current);
      if (!current._original && current._uaOriginal) {
        try { current._original = current._uaOriginal; } catch (_) { /* metadata only */ }
      }
      current = current._original || current._uaOriginal || current.original || null;
    }
    return false;
  }

  function installCountScopeCorrection() {
    const original = UA.computeExportReport;
    if (typeof original !== 'function') return false;
    if (chainContains(original, '_uaInvestigationCountScopeCorrected')) return true;
    const wrapped = async function investigationCountScopeCorrected(ctx, ...args) {
      return correctCountScopeReport(await original.call(this, ctx, ...args), ctx);
    };
    wrapped._uaInvestigationCountScopeCorrected = true;
    wrapped._original = original;
    wrapped._uaOriginal = original;
    UA.computeExportReport = wrapped;
    return true;
  }

  function setStatus(text, tone) {
    const node = root.document?.getElementById('aiPromptStatus');
    if (node) {
      node.textContent = text || '';
      node.dataset.uaTone = tone || '';
    }
  }

  function runtimeContext() {
    return UA.getRuntimeContext?.() || {};
  }

  async function generateHandoff() {
    const generator = UA.aiVisualResearch?.generateResearchHandoff;
    if (typeof generator !== 'function') throw new Error('Erweiterte KI-Übergabe ist noch nicht geladen.');
    lastHandoff = await generator(UA, runtimeContext());
    return lastHandoff;
  }

  function writeClipboard(text) {
    const writer = UA.aiLinkHandoff?._internal?.writeClipboard;
    if (typeof writer === 'function') return writer(text);
    if (root.navigator?.clipboard?.writeText) return root.navigator.clipboard.writeText(text);
    throw new Error('Zwischenablage nicht verfügbar.');
  }

  function downloadText(filename, mime, text) {
    const downloader = UA.aiLinkHandoff?._internal?.downloadTextFile;
    if (typeof downloader === 'function') return downloader(filename, mime, text);
    throw new Error('Downloadfunktion nicht verfügbar.');
  }

  function safeFilename(value) {
    const shared = UA.aiLinkHandoff?._internal?.safeFilename;
    if (typeof shared === 'function') return shared(value);
    return clean(value || 'unfallwerkbank').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function replaceButtonHandler(id, marker, label, title, action) {
    let button = root.document?.getElementById(id);
    if (!button) return false;
    if (button.dataset[marker] === '1') return true;
    const clone = button.cloneNode(true);
    clone.dataset[marker] = '1';
    clone.textContent = label;
    clone.title = title;
    button.replaceWith(clone);
    button = clone;
    button.addEventListener('click', async () => {
      const oldLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Wird erzeugt …';
      try { await action(button); }
      catch (error) { setStatus(error?.message || String(error), 'error'); }
      finally { button.disabled = false; button.textContent = oldLabel; }
    });
    return true;
  }

  function ensureWorkflowPanel() {
    const documentValue = root.document;
    if (!documentValue || documentValue.getElementById('aiInvestigationWorkflow')) return true;
    const anchor = documentValue.getElementById('aiLinkHandoffNote')
      || documentValue.getElementById('externalAiPromptPanel');
    if (!anchor?.parentNode) return false;

    const panel = documentValue.createElement('section');
    panel.id = 'aiInvestigationWorkflow';
    panel.setAttribute('aria-label', 'Zweistufige KI-Antragserzeugung');
    panel.style.cssText = 'margin-top:12px;padding:12px;border:1px solid #aeb9c5;border-radius:8px;background:#f7f9fb;';
    panel.innerHTML = [
      '<div style="font-weight:800;margin-bottom:6px;">Zweistufige, lokal validierte KI-Antragserzeugung</div>',
      '<div style="font-size:12px;line-height:1.45;margin-bottom:8px;">',
      '1. Untersuchungsauftrag in die KI kopieren. 2. Die reine JSON-Antwort hier einfügen und validieren. ',
      '3. Erst danach wird der Antragsprompt freigeschaltet. Amtliche Fakten, Kartenprüfung, Pattern-Abdeckung, Quellen und politische Recherche werden geprüft.',
      '</div>',
      '<label for="aiInvestigationResultInput" style="display:block;font-weight:700;margin-bottom:4px;">KI-Untersuchungsergebnis (JSON)</label>',
      '<textarea id="aiInvestigationResultInput" rows="12" style="width:100%;box-sizing:border-box;font:12px/1.4 ui-monospace,monospace;" placeholder="JSON aus Phase 1 hier einfügen"></textarea>',
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">',
      '<button type="button" id="btnAiValidateInvestigation">2. Untersuchung validieren</button>',
      '<button type="button" id="btnAiApplicationPromptCopy" disabled>3. Antragsprompt kopieren</button>',
      '</div>',
      '<pre id="aiInvestigationValidationStatus" style="white-space:pre-wrap;margin:8px 0 0;font-size:12px;"></pre>',
    ].join('');
    anchor.insertAdjacentElement('afterend', panel);

    const validateButton = panel.querySelector('#btnAiValidateInvestigation');
    const applicationButton = panel.querySelector('#btnAiApplicationPromptCopy');
    const input = panel.querySelector('#aiInvestigationResultInput');
    const status = panel.querySelector('#aiInvestigationValidationStatus');

    validateButton.addEventListener('click', async () => {
      validateButton.disabled = true;
      try {
        const handoff = lastHandoff || await generateHandoff();
        lastInvestigation = parseInvestigationResult(input.value);
        lastValidation = validateInvestigationResult(lastInvestigation, handoff.facts);
        applicationButton.disabled = !lastValidation.readyForApplication;
        const lines = [
          `${lastValidation.passed ? 'VALIDIERT' : 'NICHT VALIDIERT'} · Score ${lastValidation.score}/100`,
          `Einreichungsstatus: ${lastValidation.filingReadinessStatus}`,
          ...lastValidation.errors.map(error => `FEHLER: ${error.message}`),
          ...lastValidation.warnings.map(warning => `HINWEIS: ${warning.message}`),
        ];
        status.textContent = lines.join('\n');
        setStatus(lastValidation.readyForApplication
          ? 'Untersuchung validiert. Der Antragsprompt ist freigeschaltet.'
          : 'Untersuchung nicht ausreichend; Antragserzeugung bleibt gesperrt.',
        lastValidation.readyForApplication ? 'success' : 'error');
      } catch (error) {
        applicationButton.disabled = true;
        status.textContent = `FEHLER: ${error?.message || error}`;
        setStatus(error?.message || String(error), 'error');
      } finally {
        validateButton.disabled = false;
      }
    });

    applicationButton.addEventListener('click', async () => {
      try {
        const handoff = lastHandoff || await generateHandoff();
        if (!lastInvestigation || !lastValidation) throw new Error('Zuerst Untersuchungsergebnis validieren.');
        const prompt = buildApplicationPrompt(handoff, lastInvestigation, lastValidation);
        await writeClipboard(prompt);
        setStatus('Validierter Antragsprompt kopiert. Dieser zweite KI-Schritt darf nun den Antrag formulieren.', 'success');
      } catch (error) {
        setStatus(error?.message || String(error), 'error');
      }
    });
    return true;
  }

  function bindPrimaryControls() {
    const documentValue = root.document;
    if (!documentValue) return false;
    ensureWorkflowPanel();

    replaceButtonHandler(
      'btnAiResearchLinkCopy', 'uaInvestigation',
      '1. KI-Untersuchungsauftrag kopieren',
      'Kopiert ausschließlich Phase 1: Karten-, Muster-, Unfallhintergrund- und politische Recherche. Noch kein Antrag.',
      async () => {
        const handoff = await generateHandoff();
        await writeClipboard(buildInvestigationPrompt(handoff));
        setStatus('Phase-1-Untersuchungsauftrag kopiert. Die KI soll ausschließlich das JSON-Untersuchungsergebnis liefern.', 'success');
      }
    );

    replaceButtonHandler(
      'btnAiPromptDownloadMd', 'uaInvestigation',
      '1. Untersuchungsauftrag .md',
      'Lädt den Phase-1-Auftrag ohne vorzeitige Antragserstellung herunter.',
      async () => {
        const handoff = await generateHandoff();
        const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
        downloadText(`${safeFilename(handoff.city)}_${date}_ki_untersuchung.md`,
          'text/markdown;charset=utf-8', buildInvestigationPrompt(handoff));
        setStatus('Untersuchungsauftrag heruntergeladen.', 'success');
      }
    );

    replaceButtonHandler(
      'btnAiFactsDownloadJson', 'uaInvestigation',
      'Untersuchungsdaten + Verträge .json',
      'Lädt den deterministischen Tatsachenkern und alle Untersuchungsverträge.',
      async () => {
        const handoff = await generateHandoff();
        const request = buildInvestigationRequest(handoff);
        const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
        downloadText(`${safeFilename(handoff.city)}_${date}_ki_untersuchungsdaten.json`,
          'application/json;charset=utf-8', `${stableJson(request)}\n`);
        setStatus('Untersuchungsdaten und Verträge heruntergeladen.', 'success');
      }
    );

    const note = documentValue.getElementById('aiLinkHandoffNote');
    if (note && note.dataset.uaInvestigation !== '1') {
      note.dataset.uaInvestigation = '1';
      note.textContent += ' Die KI erstellt zunächst nur ein strukturiertes Untersuchungsergebnis. Ein Antragsprompt wird erst nach lokaler Prüfung von amtlichen Fakten, Kartenmodi, Mustern, Quellen und politischer Recherche freigeschaltet.';
    }
    return true;
  }

  function bind() {
    const visualBinder = UA.aiVisualResearch?._internal?.bindEnhancedControls;
    if (typeof visualBinder === 'function') visualBinder();
    installCountScopeCorrection();
    return bindPrimaryControls();
  }

  function install() {
    const documentValue = root.document;
    installCountScopeCorrection();
    if (!documentValue) return false;
    bind();
    if (!observer && typeof root.MutationObserver === 'function') {
      observer = new root.MutationObserver(() => bind());
      observer.observe(documentValue.documentElement, { childList: true, subtree: true });
    }
    if (documentValue.documentElement?.dataset.uaVisualResearchUi !== '2') {
      documentValue.documentElement.dataset.uaVisualResearchUi = '2';
      documentValue.addEventListener('click', event => {
        if (event.target?.closest?.('#btnOpenExport')) root.setTimeout?.(bind, 0);
      }, true);
    }
    return true;
  }

  UA.aiInvestigation = Object.freeze({
    INVESTIGATION_REQUEST_SCHEMA,
    INVESTIGATION_RESULT_SCHEMA,
    VALIDATION_SCHEMA,
    APPLICATION_REQUEST_SCHEMA,
    REQUIRED_MAP_MODES,
    buildInvestigationRequest,
    buildInvestigationPrompt,
    parseInvestigationResult,
    validateInvestigationResult,
    buildApplicationPrompt,
    correctCountScopeReport,
    collectPatternFindings,
    deterministicFacts,
    _internal: Object.freeze({
      stableJson, sortJson, stripJsonFence, investigationResultSkeleton,
      rootAnalysisContext, installCountScopeCorrection, chainContains,
      ensureWorkflowPanel, bindPrimaryControls,
    }),
  });

  UA.aiVisualResearchUi = Object.freeze({ install, bind });
  install();
})();
