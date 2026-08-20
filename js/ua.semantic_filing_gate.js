/**
 * Fail-closed semantic extension for the central filing-readiness gate.
 *
 * Statistical composition findings, spatial clusters and officially designated
 * accident black spots are different claims. This module keeps them separate
 * and prevents generic templates or an AI result from upgrading exploratory or
 * synthetic evidence into an application-ready statement.
 */
(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const SCHEMA_VERSION = 'unfallwerkbank.semanticFilingGate.v1';

  const OFFICIAL_HOTSPOT_PATTERN = /\b(?:amtlich(?:e[rsn]?|er)?\s+)?unfallschwerpunkt\b/i;
  const SPATIAL_CLUSTER_PATTERN = /\b(?:häufungspunkt|unfallhäufung|räumlich(?:e[rsn]?|er)?\s+(?:cluster|schwerpunkt)|schwerpunkt\s+der\s+häufung)\b/i;
  const CORRIDOR_PATTERN = /\b(?:unfallkorridor|korridor(?:problem|häufung|schwerpunkt)|streckenbezogen(?:e[rsn]?|er)?\s+unfall(?:cluster|häufung))\b/i;
  const PATTERN_OVERCLAIM_PATTERN = /\b(?:schwerpunktmuster|statistisch(?:e[rsn]?|er)?\s+(?:abgesichert|signifikant)|signifikante\s+(?:häufung|überrepräsentation)|gesichert(?:e[rsn]?|er)?\s+überrepräsentation)\b/i;
  const SYNTHETIC_PATTERN = /\b(?:synthetic|synthetisch|fixture|mock|placeholder|qa-only|testkarte|deterministic-map-fixture)\b/i;
  const QUALIFIED_MEASURE_PATTERN = /\b(?:prüf(?:en|ung|auftrag)|untersuch(?:en|ung)|vor[- ]ort|fachprüfung|fachplanung|machbarkeit|variantenprüfung|verkehrsversuch|zu\s+klären|bedarf\s+einer\s+prüfung|evaluier)\b/i;
  const IMPLEMENTATION_ACTION_PATTERN = /\b(?:errichten|bauen|umbauen|anordnen|installieren|einrichten|entfernen|verlegen|markieren|signalisieren|umsetzen|ausweisen|sperren|aufheben)\b/i;
  const CONCRETE_MEASURE_PATTERN = /\b(?:poller|schutzstreifen|radfahrstreifen|radweg|tempo\s*30|lichtsignalanlage|mittelinsel|zebrastreifen|querungshilfe)\b/i;

  const clean = value => String(value == null ? '' : value).trim();
  const list = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const finite = value => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const plainText = value => clean(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const unique = values => [...new Set(list(values).map(clean).filter(Boolean))];

  function structuredFacts(facts) {
    return object(facts?.structured || facts?.report?.structured || facts);
  }

  function focusRows(facts) {
    const structured = structuredFacts(facts);
    return list(
      structured?.deviations?.focus
      || structured?.patternComposition?.focus
      || structured?.patternAnalysis?.focus
    );
  }

  function rowIsSignificant(row) {
    return row?.isSignificant === true;
  }

  function rowFactor(row) {
    return finite(row?.factor ?? row?.ratio ?? row?.relativeFactor);
  }

  function unnegatedMatch(value, pattern) {
    const text = plainText(value);
    if (!text) return false;
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const matcher = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(matcher)) {
      const before = text.slice(Math.max(0, match.index - 96), match.index);
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 96);
      const postposedNegation = /^\s+(?:ist|sei|bleibt)\b[^.!?]{0,48}\b(?:nicht\s+(?:belegt|nachgewiesen|bestätigt|festgestellt|gegeben)|unbelegt|ungeklärt)\b/i.test(after)
        || /^\s+(?:gilt|wird)\b[^.!?]{0,48}\bnicht\s+(?:als\s+)?(?:belegt|nachgewiesen|bestätigt|festgestellt|eingestuft)\b/i.test(after)
        || /^\s+(?:liegt|lag)\b[^.!?]{0,24}\bnicht\s+vor\b/i.test(after);
      if (/\b(?:kein(?:e[rsn]?|er)?|nicht|ohne|unbelegt|ungeklärt|weder|ob|falls|möglicherweise|potenziell|verdacht)\b(?:\s+\S+){0,9}\s*$/i.test(before)
          || /\b(?:zu\s+prüfen|zu\s+klären|prüf(?:en|ung)|untersuch(?:en|ung))\b[^.!?]{0,72}$/i.test(before)
          || postposedNegation) {
        continue;
      }
      return true;
    }
    return false;
  }

  function flattenText(value, output, depth = 0) {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = plainText(value);
      if (text) output.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => flattenText(item, output, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(item => flattenText(item, output, depth + 1));
    }
  }

  function collectTexts(values) {
    const output = [];
    values.forEach(value => flattenText(value, output));
    return unique(output);
  }

  function claimTextGroups(facts) {
    const structured = structuredFacts(facts);
    const summary = object(structured.executiveSummary);
    const summaryTexts = collectTexts([
      summary.classification,
      summary.bullets,
      summary.urgency,
    ]);
    const staticTexts = collectTexts([
      structured.title,
      structured.subject,
      structured.applicationTitle,
      structured.resolution,
      structured.beschluss,
      structured.intro,
      structured.meta?.title,
      structured.meta?.subject,
      structured.meta?.applicationTitle,
      facts?.title,
      facts?.subject,
    ]);
    const bodyTexts = collectTexts([
      structured.mapReferences,
      facts?.text,
      facts?.html,
      facts?.report?.text,
      facts?.report?.html,
    ]);
    return {
      summary: summaryTexts,
      static: staticTexts,
      body: bodyTexts,
      all: unique([...summaryTexts, ...staticTexts, ...bodyTexts]),
    };
  }

  function claimTexts(facts) {
    return claimTextGroups(facts).all;
  }

  function claimProfile(values) {
    const texts = list(values);
    return {
      officialHotspot: texts.some(text => unnegatedMatch(text, OFFICIAL_HOTSPOT_PATTERN)),
      spatialCluster: texts.some(text => unnegatedMatch(text, SPATIAL_CLUSTER_PATTERN)),
      corridorProblem: texts.some(text => unnegatedMatch(text, CORRIDOR_PATTERN)),
      patternComposition: texts.some(text => unnegatedMatch(text, PATTERN_OVERCLAIM_PATTERN)),
    };
  }

  function explicitTruth(values) {
    for (const value of values) {
      if (value === true) return true;
      const text = clean(value).toLowerCase();
      if (['true', 'yes', 'confirmed', 'supported', 'official', 'designated', 'nachgewiesen', 'bestätigt'].includes(text)) {
        return true;
      }
    }
    return false;
  }

  function officialHotspotEstablished(facts) {
    const structured = structuredFacts(facts);
    return explicitTruth([
      structured.officialAccidentHotspot,
      structured.isOfficialAccidentHotspot,
      structured.meta?.officialAccidentHotspot,
      structured.meta?.isOfficialAccidentHotspot,
      structured.spatialClassification?.officialHotspot,
      structured.spatialClassification?.officialStatus,
      facts?.officialAccidentHotspot,
    ]);
  }

  function spatialClusterEstablished(facts) {
    const structured = structuredFacts(facts);
    return explicitTruth([
      structured.spatialClusterSupported,
      structured.spatialAnalysis?.clusterSupported,
      structured.spatialClassification?.clusterSupported,
      structured.spatialClassification?.clusterStatus,
      facts?.spatialClusterSupported,
    ]);
  }

  function corridorEstablished(facts) {
    const structured = structuredFacts(facts);
    return explicitTruth([
      structured.corridorProblemSupported,
      structured.spatialAnalysis?.corridorSupported,
      structured.spatialAnalysis?.corridorStatus,
      structured.spatialClassification?.corridorSupported,
      structured.spatialClassification?.corridorStatus,
      facts?.corridorProblemSupported,
    ]);
  }

  function forcedByActiveFilter(row, facts) {
    const structured = structuredFacts(facts);
    const activeMask = finite(
      structured?.meta?.activeFilterMask
      ?? structured?.activeFilterScope?.activeFilterMask
    );
    const rowMask = finite(row?.mask ?? row?.involvementMask);
    const mode = clean(
      structured?.meta?.involvementMode
      || structured?.activeFilterScope?.involvementMode
    ).toLowerCase() || 'or';
    if (!activeMask || !rowMask) return false;

    if (mode === 'and') return (rowMask & activeMask) === activeMask;
    if (mode === 'solo') {
      const single = rowMask > 0 && (rowMask & (rowMask - 1)) === 0;
      return single && (rowMask & activeMask) !== 0;
    }
    // With exactly one selected OR bit, every matching row necessarily contains
    // that bit. With several OR bits, no individual feature is forced.
    const singleActive = activeMask > 0 && (activeMask & (activeMask - 1)) === 0;
    return singleActive && (rowMask & activeMask) !== 0;
  }

  function mapReality(facts, result) {
    const structured = structuredFacts(facts);
    const contract = object(
      facts?.visualSceneAnalysisContract
      || structured?.visualSceneAnalysisContract
      || facts?.aiResearchHandoff?.visualSceneAnalysisContract
      || structured?.aiResearchHandoff?.visualSceneAnalysisContract
    );
    const views = list(contract.inspectionViews);
    const modelResources = [
      ...list(result?.accessedResources),
      ...list(result?.mapObservations),
    ];
    const descriptors = [];
    const booleans = [
      facts?.isSyntheticMap,
      facts?.syntheticMap,
      structured?.isSyntheticMap,
      structured?.syntheticMap,
      structured?.meta?.isSyntheticMap,
      structured?.meta?.syntheticMap,
      contract?.isSynthetic,
      contract?.synthetic,
      contract?.fixture,
    ];
    const values = [
      facts?.mapReality,
      facts?.mapSource?.reality,
      structured?.mapReality,
      structured?.meta?.mapReality,
      structured?.meta?.mapSource,
      contract?.mapReality,
      contract?.sourceType,
      contract?.dataOrigin,
    ];
    views.forEach(view => {
      booleans.push(view?.isSynthetic, view?.synthetic, view?.fixture);
      values.push(view?.mapReality, view?.sourceType, view?.dataOrigin, view?.fixtureId, view?.url);
    });
    // Model output may only make the local result stricter. A model-side
    // synthetic/fixture marker is therefore accepted as a downgrade signal,
    // while model claims can never establish real-map, cluster or official
    // hotspot evidence.
    modelResources.forEach(resource => {
      booleans.push(resource?.isSynthetic, resource?.synthetic, resource?.fixture);
      values.push(
        resource?.mapReality,
        resource?.sourceType,
        resource?.resourceType,
        resource?.dataOrigin,
        resource?.fixtureId,
        resource?.url,
        resource?.observation
      );
    });
    values.forEach(value => {
      const text = plainText(value);
      if (text) descriptors.push(text);
    });
    const synthetic = booleans.some(value => value === true)
      || descriptors.some(value => SYNTHETIC_PATTERN.test(value));
    return {
      status: synthetic ? 'synthetic' : 'not-explicitly-synthetic',
      synthetic,
      descriptors: unique(descriptors),
    };
  }

  function measureText(measure) {
    const values = [
      measure?.option,
      measure?.safetyObjective,
      measure?.description,
      measure?.label,
      measure?.prerequisites,
      measure?.requiredVerification,
    ];
    const output = [];
    values.forEach(value => flattenText(value, output));
    return output.join(' ');
  }

  function concreteMeasures(result) {
    return list(result?.candidateMeasures).filter(measure => {
      const text = measureText(measure);
      const implementationAction = IMPLEMENTATION_ACTION_PATTERN.test(text);
      const concreteObject = CONCRETE_MEASURE_PATTERN.test(text);
      const qualifiedInvestigation = QUALIFIED_MEASURE_PATTERN.test(text);
      return implementationAction || (concreteObject && !qualifiedInvestigation);
    });
  }

  function recommendedSummary(classification) {
    if (classification.officialAccidentHotspot === 'confirmed') {
      return 'Amtlich bestätigter Unfallschwerpunkt; Beteiligungsmuster, räumliche Lage und Maßnahmen werden getrennt begründet.';
    }
    if (classification.spatialCluster === 'supported') {
      return 'Eigenständig belegter räumlicher Unfallcluster; eine amtliche Einstufung als Unfallschwerpunkt ist nicht belegt.';
    }
    if (classification.corridorProblem === 'supported') {
      return 'Eigenständig belegtes streckenbezogenes Korridorproblem; eine amtliche Einstufung als Unfallschwerpunkt ist nicht belegt.';
    }
    if (classification.patternComposition === 'supported-anomaly') {
      return 'Signifikante Abweichung in der lokalen Beteiligungsmuster-Zusammensetzung; kein räumlicher oder amtlicher Unfallschwerpunkt belegt.';
    }
    if (classification.patternComposition === 'exploratory') {
      return 'Explorative Abweichung in der Beteiligungsmuster-Zusammensetzung; kein räumlicher oder amtlicher Unfallschwerpunkt belegt.';
    }
    return 'Keine belastbare lokale Musterabweichung; räumliche, streckenbezogene und amtliche Einstufungen sind gesondert zu prüfen.';
  }

  function evaluate(options = {}) {
    const facts = object(options.facts);
    const result = object(options.result);
    const rows = focusRows(facts);
    const significantRows = rows.filter(rowIsSignificant);
    const exploratoryRows = rows.filter(row => !rowIsSignificant(row));
    const nearOneRows = rows.filter(row => {
      const factor = rowFactor(row);
      return factor !== null && factor >= 0.9 && factor <= 1.1;
    });
    const forcedRows = rows.filter(row => forcedByActiveFilter(row, facts));
    const groups = claimTextGroups(facts);
    const allClaims = claimProfile(groups.all);
    const summaryClaims = claimProfile(groups.summary);
    const staticClaims = claimProfile(groups.static);
    const officialClaim = allClaims.officialHotspot;
    const spatialClaim = allClaims.spatialCluster;
    const corridorClaim = allClaims.corridorProblem;
    const patternClaim = allClaims.patternComposition;
    const officialEvidence = officialHotspotEstablished(facts);
    const spatialEvidence = spatialClusterEstablished(facts);
    const corridorEvidence = corridorEstablished(facts);
    const reality = mapReality(facts, result);
    const concrete = concreteMeasures(result);

    const errors = [];
    const warnings = [];
    const checks = [];
    const seenErrors = new Set();
    const seenWarnings = new Set();
    const seenChecks = new Set();
    const fail = (code, message, details) => {
      if (!seenErrors.has(code)) {
        errors.push({ code, message, details: details || null });
        seenErrors.add(code);
      }
      if (!seenChecks.has(code)) {
        checks.push({ code, passed: false, message });
        seenChecks.add(code);
      }
    };
    const warn = (code, message, details) => {
      if (!seenWarnings.has(code)) {
        warnings.push({ code, message, details: details || null });
        seenWarnings.add(code);
      }
    };
    const pass = (code, message) => {
      if (!seenChecks.has(code)) {
        checks.push({ code, passed: true, message });
        seenChecks.add(code);
      }
    };

    const classification = {
      patternComposition: significantRows.length
        ? 'supported-anomaly'
        : (rows.length ? 'exploratory' : 'not-established'),
      spatialCluster: spatialEvidence ? 'supported' : 'not-established',
      corridorProblem: corridorEvidence ? 'supported' : 'not-established',
      officialAccidentHotspot: officialEvidence ? 'confirmed' : 'not-established',
      mapReality: reality.status,
      significantFocusCount: significantRows.length,
      exploratoryFocusCount: exploratoryRows.length,
      forcedByFilterCount: forcedRows.length,
      nearOneFocusCount: nearOneRows.length,
    };

    if (rows.length && !significantRows.length) {
      warn(
        'semantic-focus-exploratory',
        'Die lokale Musterzusammensetzung ist nur explorativ; keine Fokuszeile ist statistisch signifikant.',
        { focusCount: rows.length }
      );
    } else if (significantRows.length) {
      pass(
        'semantic-pattern-composition-supported',
        significantRows.length + ' signifikante Abweichung(en) der Musterzusammensetzung sind belegt.'
      );
    } else {
      pass('semantic-no-pattern-focus', 'Es wird keine lokale Musterabweichung als Fokus geführt.');
    }

    const staticSummaryConflict = (
      (staticClaims.officialHotspot && !summaryClaims.officialHotspot)
      || (staticClaims.spatialCluster && !summaryClaims.spatialCluster)
      || (staticClaims.corridorProblem && !summaryClaims.corridorProblem)
      || (staticClaims.patternComposition && !summaryClaims.patternComposition)
    );
    if (staticSummaryConflict) {
      fail(
        'semantic-static-summary-conflict',
        'Statischer Titel, Betreff oder Beschluss behauptet eine stärkere Einordnung als die Kurzbewertung.',
        { staticClaims, summaryClaims }
      );
    }

    if (officialClaim && !officialEvidence) {
      fail(
        'semantic-official-hotspot-overclaim',
        'Der Bericht behauptet einen Unfallschwerpunkt, ohne eine amtliche Einstufung als Unfallschwerpunkt zu belegen.'
      );
    }
    if (spatialClaim && !spatialEvidence) {
      fail(
        'semantic-spatial-cluster-overclaim',
        'Der Bericht behauptet einen räumlichen Häufungspunkt, ohne einen eigenständigen räumlichen Clusternachweis zu belegen.'
      );
    }
    if (corridorClaim && !corridorEvidence) {
      fail(
        'semantic-corridor-overclaim',
        'Der Bericht behauptet ein Korridorproblem, ohne einen eigenständigen streckenbezogenen Nachweis zu belegen.'
      );
    }
    if (patternClaim && !significantRows.length) {
      fail(
        'semantic-pattern-composition-overclaim',
        'Der Bericht bezeichnet ein Beteiligungsmuster als statistisch oder als Schwerpunktmuster, obwohl keine signifikante Fokuszeile vorliegt.'
      );
    }
    if (nearOneRows.length && (patternClaim || spatialClaim || corridorClaim || officialClaim)) {
      fail(
        'semantic-near-one-overclaim',
        'Ein Faktor nahe 1 darf keine Schwerpunkt- oder Signifikanzbehauptung tragen.',
        { rows: nearOneRows.map(row => ({ label: clean(row?.label), factor: rowFactor(row) })) }
      );
    }
    if (forcedRows.length && (patternClaim || spatialClaim || corridorClaim || officialClaim)) {
      fail(
        'semantic-filter-scope-tautology',
        'Ein durch den aktiven Beteiligungsfilter erzwungenes Merkmal wird fälschlich als zusätzliche lokale Auffälligkeit beschrieben.',
        { rows: forcedRows.map(row => clean(row?.label)).filter(Boolean) }
      );
    }

    if (reality.synthetic) {
      warn(
        'semantic-synthetic-map-context',
        'Die Kartenbasis ist als synthetisch beziehungsweise als QA-Fixture gekennzeichnet; Einreichungsreife bleibt höchstens bedingt.',
        { descriptors: reality.descriptors }
      );
      if (concrete.length) {
        fail(
          'semantic-synthetic-map-concrete-measure',
          'Eine synthetische oder QA-Karte darf keine konkrete bauliche oder verkehrsrechtliche Maßnahme freigeben; erforderlich ist zunächst eine reale Orts- und Fachprüfung.',
          { measures: concrete.map(measure => clean(measure?.option || measure?.label)) }
        );
      }
    } else {
      pass('semantic-map-not-explicitly-synthetic', 'Die Kartenbasis ist nicht als synthetische QA-Fixture gekennzeichnet.');
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      classification,
      errors,
      warnings,
      checks,
      recommendedExecutiveSummary: recommendedSummary(classification),
    };
  }

  function replaceLiteral(value, before, after) {
    if (typeof value !== 'string' || !before || before === after) return value;
    return value.split(before).join(after);
  }

  function normalisedSummaryBullets(bullets, classification) {
    const supported = classification.patternComposition === 'supported-anomaly';
    return list(bullets).map(value => {
      const text = clean(value);
      if (!/^Schwerpunktmuster\b/i.test(text)) return text;
      const remainder = text.replace(/^Schwerpunktmuster\s*/i, '').replace(/\.$/, '');
      const prefix = supported
        ? 'Signifikante Abweichung der Musterzusammensetzung'
        : 'Explorative Abweichung der Musterzusammensetzung';
      return `${prefix} ${remainder}; Anteilvergleich, keine absolute Unfallrate.`;
    });
  }

  function recommendedUrgency(classification) {
    if (classification.officialAccidentHotspot === 'confirmed') {
      return 'Zeitnahe fachliche Befassung und nachvollziehbare Maßnahmenableitung sind geboten.';
    }
    if (classification.spatialCluster === 'supported'
        || classification.corridorProblem === 'supported') {
      return 'Zeitnahe fachliche Prüfung des räumlich belegten Befunds ist geboten.';
    }
    if (classification.patternComposition === 'supported-anomaly') {
      return 'Zeitnahe fachliche Prüfung der signifikanten Musterabweichung; der räumliche Konfliktmechanismus ist gesondert nachzuweisen.';
    }
    if (classification.patternComposition === 'exploratory') {
      return 'Explorativer Befund; vor konkreten Maßnahmen sind räumliche und fachliche Prüfungen erforderlich.';
    }
    return 'Beobachtungsmodus und regelmäßige, methodisch konsistente Auswertung.';
  }

  function normaliseReport(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return report;
    const output = { ...report };
    const sourceStructured = structuredFacts(report);
    const structured = { ...sourceStructured };
    const previousSummary = object(sourceStructured.executiveSummary);
    const semantic = evaluate({ facts: report, result: {} });
    const classification = semantic.classification;
    const nextSummary = {
      ...previousSummary,
      classification: semantic.recommendedExecutiveSummary,
      bullets: normalisedSummaryBullets(previousSummary.bullets, classification),
      urgency: recommendedUrgency(classification),
    };

    structured.executiveSummary = nextSummary;
    structured.semanticFilingGateSchemaVersion = SCHEMA_VERSION;
    structured.semanticAnalysisClassification = classification;

    const mapReferenceLabel = classification.spatialCluster === 'supported'
      ? 'Räumlich belegter Schwerpunkt:'
      : (classification.corridorProblem === 'supported'
        ? 'Räumlich belegter Korridorbezug:'
        : 'Räumlicher Bezugspunkt der Auswahl:');
    if (Array.isArray(sourceStructured.mapReferences)) {
      structured.mapReferences = sourceStructured.mapReferences.map(value =>
        replaceLiteral(value, 'Schwerpunkt der Häufung:', mapReferenceLabel));
    }

    for (const key of ['title', 'subject', 'applicationTitle', 'resolution', 'beschluss', 'intro']) {
      if (typeof structured[key] === 'string') {
        structured[key] = replaceLiteral(
          structured[key],
          'Auffälliger Unfallschwerpunkt im markierten Bereich',
          'Verkehrssicherheitsprüfung im markierten Bereich'
        );
      }
      if (typeof output[key] === 'string') {
        output[key] = replaceLiteral(
          output[key],
          'Auffälliger Unfallschwerpunkt im markierten Bereich',
          'Verkehrssicherheitsprüfung im markierten Bereich'
        );
      }
    }

    const replacements = [
      [previousSummary.classification, nextSummary.classification],
      [previousSummary.urgency, nextSummary.urgency],
      ['Auffälliger Unfallschwerpunkt im markierten Bereich',
        'Verkehrssicherheitsprüfung im markierten Bereich'],
      ['Schwerpunkt der Häufung:', mapReferenceLabel],
    ];
    list(previousSummary.bullets).forEach((before, index) => {
      replacements.push([before, nextSummary.bullets[index]]);
    });
    for (const key of ['text', 'html']) {
      let value = output[key];
      for (const [before, after] of replacements) {
        value = replaceLiteral(value, before, after);
      }
      output[key] = value;
    }

    output.structured = structured;
    const residual = evaluate({ facts: output, result: {} });
    structured.semanticPreflight = {
      schemaVersion: SCHEMA_VERSION,
      normalised: true,
      recommendedExecutiveSummary: nextSummary.classification,
      errors: residual.errors,
      warnings: residual.warnings,
      checks: residual.checks,
    };
    return output;
  }

  function chainContains(fn, marker) {
    const seen = new Set();
    let current = fn;
    while (typeof current === 'function' && !seen.has(current)) {
      if (current[marker] === true) return true;
      seen.add(current);
      current = current._original || current._uaOriginal;
    }
    return false;
  }

  function installReportAdapter() {
    const original = UA.computeExportReport;
    if (typeof original !== 'function') return false;
    if (chainContains(original, '_uaSemanticReportAdapter')) return true;

    const wrapped = async function semanticComputeExportReport(...args) {
      const report = await original.apply(this, args);
      return normaliseReport(report);
    };
    wrapped._uaSemanticReportAdapter = true;
    wrapped._original = original;
    wrapped._uaOriginal = original;
    UA.computeExportReport = wrapped;
    return true;
  }

  function mergeMessages(base, extra) {
    const output = [];
    const seen = new Set();
    for (const item of [...list(base), ...list(extra)]) {
      const code = clean(item?.code);
      const key = code || JSON.stringify(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push({ ...item });
    }
    return output;
  }

  function install() {
    const current = UA.filingReadiness;
    const originalEvaluate = current?.evaluate;
    if (typeof originalEvaluate !== 'function') return false;
    if (originalEvaluate._uaSemanticFilingGate === true) return true;

    const wrappedEvaluate = function semanticFilingReadiness(options = {}) {
      const semantic = evaluate(options);
      const gate = originalEvaluate.call(current, {
        ...options,
        errors: mergeMessages(options.errors, semantic.errors),
        warnings: mergeMessages(options.warnings, semantic.warnings),
        checks: mergeMessages(options.checks, semantic.checks),
      });
      return {
        ...gate,
        semanticFilingGateSchemaVersion: SCHEMA_VERSION,
        semanticAnalysisClassification: semantic.classification,
        semanticPreflight: {
          recommendedExecutiveSummary: semantic.recommendedExecutiveSummary,
          errors: semantic.errors,
          warnings: semantic.warnings,
          checks: semantic.checks,
        },
      };
    };
    wrappedEvaluate._uaSemanticFilingGate = true;
    wrappedEvaluate._original = originalEvaluate;
    wrappedEvaluate._uaOriginal = originalEvaluate;

    UA.filingReadiness = Object.freeze({
      ...current,
      evaluate: wrappedEvaluate,
      semanticGateSchemaVersion: SCHEMA_VERSION,
    });
    return true;
  }

  UA.semanticFilingGate = Object.freeze({
    SCHEMA_VERSION,
    evaluate,
    install,
    installReportAdapter,
    normaliseReport,
    focusRows,
    claimTexts,
    claimTextGroups,
    claimProfile,
    mapReality,
    forcedByActiveFilter,
    concreteMeasures,
    unnegatedMatch,
  });

  const gateInstalled = install();
  const reportAdapterInstalled = installReportAdapter();
  if ((!gateInstalled || !reportAdapterInstalled)
      && typeof root.setInterval === 'function') {
    let attempts = 0;
    const timer = root.setInterval(() => {
      attempts += 1;
      const gateReady = install();
      const reportReady = installReportAdapter();
      if ((gateReady && reportReady) || attempts >= 200) root.clearInterval(timer);
    }, 50);
  }
})();
