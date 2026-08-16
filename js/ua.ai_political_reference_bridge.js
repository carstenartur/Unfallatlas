/**
 * Bridges political evidence, statistical semantics and an explicit
 * deterministic-vs-AI value-add contract into both user-owned AI workflows.
 */
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const AI_COMPARISON_SCHEMA = 'unfallwerkbank.aiAnalysisComparisonContract.v1';
  const DIGEST_SCHEMA = 'unfallwerkbank.deterministicAnalysisDigest.v1';
  const POLL_MS = 25;
  const MAX_POLLS = 240;

  const clean = value => String(value == null ? '' : value).trim();
  const finite = value => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const context = fallback => fallback
    || (typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null)
    || {};

  function normalizeReference(ref) {
    return {
      title: clean(ref?.title), type: clean(ref?.type) || 'Sonstige',
      date: ref?.date || null, gremium: ref?.gremium || null,
      number: ref?.number || null, url: clean(ref?.url),
      source: ref?.source || null, referenceType: ref?.referenceType || null,
      reason: ref?.reason || ref?.trafficReason || ref?.aiGating?.reason || null,
      snippet: ref?.snippet || null,
    };
  }
  function referenceKey(ref) {
    return clean(ref?.url)
      ? `url:${clean(ref.url).toLowerCase()}`
      : `title:${clean(ref?.title).toLowerCase()}|type:${clean(ref?.type).toLowerCase()}`;
  }
  function mergeReferences(existing, additions) {
    const out = [];
    const seen = new Set();
    for (const raw of [...(existing || []), ...(additions || [])]) {
      const ref = normalizeReference(raw);
      if (!ref.title || seen.has(referenceKey(ref))) continue;
      seen.add(referenceKey(ref));
      out.push(ref);
    }
    return out;
  }
  function statusReference(state) {
    const status = clean(state?.status) || 'not-searched';
    return {
      title: `Politische Recherche unvollständig (Status: ${status}) – nicht als fehlende Vorbefassung interpretieren`,
      type: 'Sonstige',
      url: clean(state?.officialPortalUrl || state?.portalSearchUrls?.[0]),
      source: state?.providerKey || state?.expectedProviderKey || 'political-context-status',
      referenceType: 'verwandtes Thema',
      reason: state?.qaInstruction || state?.message
        || 'Vor Einreichung ist eine nachvollziehbare amtliche Recherche erforderlich.',
      snippet: state?.message || null,
    };
  }
  function suitableReferences(state) {
    const refs = Array.isArray(state?.references) ? state.references : [];
    const allow = UA.aiPoliticalEvidence?._internal?.isSuitableForAutomaticHandoff;
    return typeof allow === 'function' ? refs.filter(allow) : refs;
  }

  function selection() {
    try {
      const p = new URL(root.location.href).searchParams;
      const s = finite(p.get('selSouth')), w = finite(p.get('selWest'));
      const n = finite(p.get('selNorth')), e = finite(p.get('selEast'));
      return [s, w, n, e].some(v => v === null) ? null : { south: s, west: w, north: n, east: e };
    } catch (_) { return null; }
  }
  function explicitAreaName(ctx, structured) {
    const candidates = [ctx?.areaNameOverride, ctx?.confirmedAreaName,
      structured?.meta?.confirmedAreaName, structured?.meta?.areaNameOverride];
    try {
      const fromUrl = new URL(root.location.href).searchParams.get('areaName');
      if (fromUrl) candidates.unshift(fromUrl);
    } catch (_) { /* headless */ }
    return candidates.map(clean).find(Boolean) || null;
  }
  function resolveAreaName(ctx, structured) {
    const explicit = explicitAreaName(ctx, structured);
    if (explicit) return { name: explicit, quality: 'confirmed', source: 'explicit' };
    const city = clean(structured?.meta?.city || structured?.meta?.cityRaw || ctx?.CITY_RAW || ctx?.city)
      || 'der ausgewählten Kommune';
    const b = selection();
    return b ? {
      name: `Markierter Untersuchungsbereich in ${city} (${b.south.toFixed(5)}–${b.north.toFixed(5)}° N; ${b.west.toFixed(5)}–${b.east.toFixed(5)}° E)`,
      quality: 'neutral-bounds', source: 'selection-bounds'
    } : { name: `Markierter Untersuchungsbereich in ${city}`, quality: 'neutral', source: 'city-only' };
  }
  function correctAreaName(report, ctx) {
    const structured = report?.structured;
    if (!structured || typeof structured !== 'object') return report;
    structured.meta = structured.meta || {};
    const previous = clean(structured.meta.areaName);
    if (!previous && !explicitAreaName(ctx, structured) && !selection()) return report;
    const resolved = resolveAreaName(ctx, structured);
    structured.meta.areaNameQuality = resolved;
    if (previous && !explicitAreaName(ctx, structured)) structured.meta.reverseGeocodedMidpointLabel = previous;
    structured.meta.areaName = resolved.name;
    if (previous && previous !== resolved.name) {
      for (const key of ['text', 'html']) {
        if (typeof report[key] === 'string') report[key] = report[key].split(previous).join(resolved.name);
      }
    }
    return report;
  }

  function patternRow(row, localTotal, baselineTotal) {
    const significant = row?.isSignificant === true;
    return {
      mask: finite(row?.mask), label: clean(row?.textLabel || row?.label) || null,
      locCnt: finite(row?.locCnt ?? row?.localCnt ?? row?.localCount),
      baseCnt: finite(row?.baseCnt ?? row?.baselineCnt ?? row?.baselineCount),
      localTotal: finite(localTotal), baselineTotal: finite(baselineTotal),
      locR: finite(row?.locR ?? row?.localShare), baseR: finite(row?.baseR ?? row?.baselineShare),
      factor: finite(row?.factor), ciLow: finite(row?.ciLow), ciHigh: finite(row?.ciHigh),
      isSignificant: significant,
      interpretation: significant ? 'statistically-supported-pattern-overrepresentation' : 'exploratory-pattern-difference',
    };
  }
  function buildDeterministicAnalysisDigest(structured) {
    const sev = structured?.severity || {}, by = sev.bySev || {};
    const dev = structured?.deviations || {}, trend = structured?.yearlyTrend || null;
    const localN = dev?.local?.total, baseN = dev?.baseline?.total;
    const totals = Array.isArray(trend?.counts?.total) ? trend.counts.total.map(Number) : [];
    const mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
    return {
      schemaVersion: DIGEST_SCHEMA, role: 'verified-reproducible-baseline',
      meta: { city: structured?.meta?.city || structured?.meta?.cityRaw || null,
        areaName: structured?.meta?.areaName || null, date: structured?.meta?.date || null,
        link: structured?.meta?.link || null, filters: structured?.meta?.filters || null,
        involvementMode: structured?.meta?.involvementMode || null },
      officialAccidentFacts: { total: finite(sev.total), fatal: finite(by['1']),
        serious: finite(by['2']), slight: finite(by['3']), other: finite(by.other) },
      patternCompositionComparison: {
        method: 'locR=locCnt/local.total; baseR=baseCnt/baseline.total; factor=locR/baseR; isSignificant iff Wilson-95%-CI lower bound exceeds baseR',
        localSampleSize: finite(localN), baselineSampleSize: finite(baseN),
        focus: (dev.focus || []).map(r => patternRow(r, localN, baseN)),
        allRows: (dev.rows || []).map(r => patternRow(r, localN, baseN)),
        scopeNote: 'Compares accident-pattern composition, not an absolute accident rate per area, road length or traffic exposure.'
      },
      yearlyTrend: trend ? { years: trend.years || [], totals, slopePerYear: finite(trend.slope),
        meanPerYear: mean, relativeSlope: mean > 0 ? finite(trend.slope) / mean : null,
        r2: finite(trend.r2 ?? trend.rSquared), nYears: finite(trend.nYears),
        classification: trend.classification || null,
        method: 'OLS yearly totals in the same area; classification uses slope/mean, R² and minimum years.' } : null,
      temporalDistribution: structured?.heatmap ? { total: finite(structured.heatmap.total),
        weekdayTotal: finite(structured.heatmap?.colTotals?.[0]),
        weekendTotal: finite(structured.heatmap?.colTotals?.[1]),
        matrix: structured.heatmap.matrix || null } : null,
      spatialEvidence: { accidentDetailTotal: finite(structured?.accidentDetails?.total),
        truncated: structured?.accidentDetails?.truncated === true,
        clusterMaps: structured?.clusterMaps || null,
        spatialArgumentation: structured?.spatialArgumentation || null },
      contextEvidence: { poi: structured?.poi || null, osm: structured?.osmContext || null,
        visual: structured?.visualContextHints || null },
      politicalResearch: { status: structured?.politicalContextResearch?.status || 'not-bound-to-analysis',
        references: (structured?.politicalReferences || []).map(normalizeReference) },
    };
  }
  function buildAnalysisMethodology(structured) {
    const d = buildDeterministicAnalysisDigest(structured), p = d.patternCompositionComparison;
    return {
      schemaVersion: 'unfallwerkbank.analysisMethodology.v1',
      mandatoryInterpretationBeforeQa: [
        'Mustervergleich = lokale gegen stadtweite Anteile von Beteiligungskombinationen.',
        'local.total und baseline.total sind Stichprobenumfänge, keine direkt verglichenen Unfallraten.',
        'Exposition ist erst für absolute Risiko-/Unfallratenaussagen erforderlich.',
        'Mehrjahrestrend = relative Entwicklung im selben Bereich über slope/mean und R².'
      ],
      forbiddenMisinterpretation: 'Kein unmittelbarer Flächen-, Straßenlängen- oder Verkehrsleistungs-Risikovergleich.',
      patternComparison: { comparisonType: 'composition-share-ratio',
        localSampleSize: p.localSampleSize, referenceSampleSize: p.baselineSampleSize,
        formulas: { localShare: 'locR = locCnt / local.total',
          referenceShare: 'baseR = baseCnt / baseline.total', factor: 'factor = locR / baseR',
          uncertainty: 'Wilson-Score-Konfidenzintervall (95 %)',
          significance: 'isSignificant = true, wenn ciLow > baseR' },
        exposureRequirement: 'Keine Exposition für den Anteilvergleich; nur für absolute Unfallraten.' },
      yearlyTrend: d.yearlyTrend ? { comparisonType: 'within-area-relative-linear-trend',
        formula: 'relativeSlope = slope / mean(yearly totals)', slope: d.yearlyTrend.slopePerYear,
        meanAnnualCount: d.yearlyTrend.meanPerYear, relativeSlope: d.yearlyTrend.relativeSlope,
        r2: d.yearlyTrend.r2, nYears: d.yearlyTrend.nYears,
        classification: d.yearlyTrend.classification } : null,
    };
  }
  function buildAiValueAddContract(structured) {
    return {
      schemaVersion: AI_COMPARISON_SCHEMA,
      purpose: 'Both analyses must be correct; AI must add traceable decision value rather than rewrite the baseline.',
      baselineAuthority: 'Preserve official facts and deterministic calculations unless reproducible recalculation proves a mismatch.',
      mandatoryComparisonColumns: ['deterministic finding', 'AI verification', 'AI-added synthesis/context', 'evidence/source', 'uncertainty/check'],
      requiredAiAddedValue: [
        { id: 'cross-layer-synthesis', requirement: 'At least three insights combining at least two evidence layers.' },
        { id: 'prioritisation', requirement: 'Rank decision-relevant findings and explain urgency.' },
        { id: 'competing-explanations', requirement: 'Name alternatives and discriminating checks for causal claims.' },
        { id: 'political-administrative-fit', requirement: 'Research motions, decisions, responses, projects and implementation windows.' },
        { id: 'measure-decision-matrix', requirement: 'Link evidence, objective, prerequisites, trade-offs, responsibility, time and success indicators.' },
        { id: 'application-improvement-delta', requirement: 'List confirmed, clarified, added, rejected and unresolved content.' },
      ],
      prohibitedShortcuts: [
        'Merely rewriting or paraphrasing tables.',
        'Treating pattern composition as an absolute accident-rate comparison.',
        'Calling non-significant differences statistically proven.',
        'Inventing crash causes or political proceedings.',
        'Returning generic measures without evidence and prerequisites.',
        'Treating failed/empty political search as no prior activity.'
      ],
      minimumOutput: { deterministicVsAiComparison: true, prioritisedFindings: 3,
        crossLayerInsights: 3, competingHypothesesPerCausalClaim: 1,
        measureDecisionMatrix: true, politicalResearchLog: true,
        explicitAiDelta: true, filingReadinessVerdict: true },
      acceptanceRubric: { methodologicalCorrectness: 30, preservationOfOfficialEvidence: 15,
        additionalSynthesis: 15, politicalAndAdministrativeContext: 15,
        measureSpecificityAndTradeoffs: 15, sourceTraceability: 10, passScore: 80,
        automaticFailure: ['methodology misrepresented',
          'official facts altered without reproducible evidence',
          'no substantive added value beyond paraphrase', 'invented source'] },
      deterministicDigest: buildDeterministicAnalysisDigest(structured),
    };
  }
  function enrichFactsPackage(facts) {
    if (!facts || typeof facts !== 'object') return facts;
    const structured = facts.structured || {};
    const methodology = structured.analysisMethodology || buildAnalysisMethodology(structured);
    const contract = buildAiValueAddContract(structured);
    const instruction = [
      '', 'VERBINDLICHER VERGLEICHS- UND MEHRWERTAUFTRAG:',
      'Stelle deterministische und KI-Analyse gegenüber; bestätige zuerst Fakten und Methodik.',
      'Liefere mindestens drei quellengebundene Synthesen aus mehreren Evidenzschichten.',
      'Priorisiere; nenne Gegenhypothesen, Prüfbedarf, Voraussetzungen, Zielkonflikte und Erfolgskriterien.',
      'Recherchiere politische/administrative Vorbefassung und vermeide Doppelanträge.',
      'Schließe mit: bestätigt | präzisiert | ergänzt | verworfen | offen.',
      `Vertrag: ${AI_COMPARISON_SCHEMA}`
    ].join('\n');
    return { ...facts,
      intendedUse: 'Vergleich mit einer methodentreuen, nachweisbar höherwertigen KI-Aufbereitung',
      analysisMethodology: methodology,
      methodologyQaGate: { required: 'Methodenvertrag vor statistischer Kritik korrekt wiedergeben.',
        rejectIf: 'Musteranteilsvergleich wird als absolute Unfallrate fehlinterpretiert.' },
      deterministicAnalysisDigest: contract.deterministicDigest,
      aiAnalysisComparisonContract: contract,
      deterministicReportText: `${clean(facts.deterministicReportText)}${instruction}` };
  }
  function bridgeFactsPackage() {
    const internal = UA.aiProposal?._internal;
    if (!internal || typeof internal.buildExternalAiFactsPackage !== 'function') return false;
    if (internal.buildExternalAiFactsPackage._uaAnalysisComparisonWrapped) return true;
    const original = internal.buildExternalAiFactsPackage;
    const wrapped = input => enrichFactsPackage(original.call(internal, input));
    wrapped._uaAnalysisComparisonWrapped = true;
    wrapped._uaMethodologyContractWrapped = true;
    wrapped._uaOriginal = original;
    internal.buildExternalAiFactsPackage = wrapped;
    return true;
  }
  function bridgeReport(report, ctxValue) {
    const ctx = context(ctxValue), structured = report?.structured;
    if (!structured || typeof structured !== 'object') return report;
    correctAreaName(report, ctx);
    if (!ctx.__uaPoliticalResearchPromise && !ctx.politicalContextResearch) return report;
    const state = UA.aiPoliticalEvidence.currentState(ctx);
    structured.politicalContextResearch = state;
    if (state.status === 'results-found') {
      const refs = suitableReferences(state);
      structured.politicalReferences = mergeReferences(structured.politicalReferences, refs);
      structured.references = mergeReferences(structured.references, refs);
    } else structured.references = mergeReferences(structured.references, [statusReference(state)]);
    structured.analysisMethodology = buildAnalysisMethodology(structured);
    structured.deterministicAnalysisDigest = buildDeterministicAnalysisDigest(structured);
    structured.aiAnalysisComparisonContract = buildAiValueAddContract(structured);
    return report;
  }
  function install() {
    bridgeFactsPackage();
    if (!UA.aiPoliticalEvidence?.currentState || typeof UA.computeExportReport !== 'function') return false;
    if (UA.computeExportReport._uaPoliticalReferenceBridgeWrapped) return true;
    const original = UA.computeExportReport;
    const wrapped = async function wrappedCompute(ctx, ...args) {
      return bridgeReport(await original.call(this, ctx, ...args), ctx);
    };
    wrapped._uaPoliticalReferenceBridgeWrapped = true;
    wrapped._uaOriginal = original;
    UA.computeExportReport = wrapped;
    bridgeFactsPackage();
    return true;
  }

  UA.aiPoliticalReferenceBridge = Object.freeze({
    AI_COMPARISON_SCHEMA, DETERMINISTIC_DIGEST_SCHEMA: DIGEST_SCHEMA,
    install, bridgeReport, buildAnalysisMethodology,
    buildDeterministicAnalysisDigest, buildAiValueAddContract, enrichFactsPackage,
    _internal: Object.freeze({ clean, finite, context, normalizeReference, referenceKey,
      mergeReferences, statusReference, suitableReferences, selection,
      explicitAreaName, resolveAreaName, correctAreaName, patternRow, bridgeFactsPackage })
  });
  let polls = 0;
  const retry = () => {
    if (install()) return;
    if (polls++ < MAX_POLLS && typeof root.setTimeout === 'function') root.setTimeout(retry, POLL_MS);
  };
  retry();
})();
