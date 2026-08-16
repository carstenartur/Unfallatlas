/**
 * UA.aiPoliticalReferenceBridge
 *
 * `computeExportReport()` exposes user-selected political material in
 * `structured.politicalReferences`, while the server-side AI feature pipeline
 * reads `structured.references`. This small adapter closes that schema gap for
 * AI workflows and also injects an explicit status reference when the portal
 * research was incomplete. It prevents the server AI from interpreting an
 * empty references array as proof that no political proceedings exist.
 *
 * The same report bridge now also adds the statistical methodology contract
 * used by both AI paths. This prevents a model from misreading a comparison of
 * accident-pattern shares as a direct comparison of absolute local and city
 * accident rates.
 */
(() => {
  'use strict';

  const root = (typeof window !== 'undefined') ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const POLL_INTERVAL_MS = 25;
  const MAX_INSTALL_ATTEMPTS = 240;

  function runtimeContext(fallback) {
    return fallback
      || (typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null)
      || {};
  }

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function finiteNumber(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function normalizeReference(ref) {
    return {
      title: clean(ref?.title),
      type: clean(ref?.type) || 'Sonstige',
      date: ref?.date || null,
      gremium: ref?.gremium || null,
      number: ref?.number || null,
      url: clean(ref?.url),
      source: ref?.source || null,
      referenceType: ref?.referenceType || null,
      reason: ref?.reason || ref?.trafficReason || ref?.aiGating?.reason || null,
      snippet: ref?.snippet || null,
    };
  }

  function referenceKey(ref) {
    const url = clean(ref?.url).toLowerCase();
    if (url) return `url:${url}`;
    return `title:${clean(ref?.title).toLowerCase()}|type:${clean(ref?.type).toLowerCase()}`;
  }

  function mergeReferences(existing, additions) {
    const out = [];
    const seen = new Set();
    for (const raw of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(additions) ? additions : [])]) {
      const ref = normalizeReference(raw);
      if (!ref.title) continue;
      const key = referenceKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
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
      reason: state?.qaInstruction || state?.message || 'Vor Einreichung ist eine nachvollziehbare Recherche in amtlichen Rats- und Informationssystemen erforderlich.',
      snippet: state?.message || null,
    };
  }

  function suitableReferences(state) {
    const refs = Array.isArray(state?.references) ? state.references : [];
    const predicate = UA.aiPoliticalEvidence?._internal?.isSuitableForAutomaticHandoff;
    return typeof predicate === 'function' ? refs.filter(predicate) : refs;
  }

  function buildAnalysisMethodology(structured) {
    const deviations = structured?.deviations || {};
    const yearlyTrend = structured?.yearlyTrend || {};
    const totals = Array.isArray(yearlyTrend?.counts?.total)
      ? yearlyTrend.counts.total.map(Number).filter(Number.isFinite)
      : [];
    const mean = totals.length
      ? totals.reduce((sum, value) => sum + value, 0) / totals.length
      : null;
    const slope = finiteNumber(yearlyTrend?.slope);
    const relativeSlope = slope !== null && mean !== null && mean > 0
      ? slope / mean
      : null;

    return {
      schemaVersion: 'unfallwerkbank.analysisMethodology.v1',
      mandatoryInterpretationBeforeQa: [
        'Der Mustervergleich vergleicht lokale und stadtweite Anteile von Beteiligungskombinationen unter denselben Nicht-Beteiligungsfiltern.',
        'local.total und baseline.total sind Stichprobenumfänge beziehungsweise Nenner der Anteilsberechnung, nicht direkt verglichene Unfallraten.',
        'Eine Expositionsnormierung ist für diesen Anteilsvergleich nicht erforderlich; sie ist erst für Aussagen über absolutes Risiko oder Unfallraten je Verkehrsleistung erforderlich.',
        'Der Mehrjahrestrend beschreibt die relative zeitliche Entwicklung innerhalb desselben Bereichs und wird über relative Steigung und R² klassifiziert.'
      ],
      forbiddenMisinterpretation: 'Die lokalen und stadtweiten Gesamtfallzahlen dürfen nicht als unmittelbarer Flächen-, Straßenlängen- oder Verkehrsleistungs-Risikovergleich dargestellt werden.',
      patternComparison: {
        comparisonType: 'composition-share-ratio',
        localPopulation: 'Unfälle innerhalb der Auswahlgeometrie nach denselben Nicht-Beteiligungsfiltern',
        referencePopulation: 'stadtweite Unfälle nach denselben Nicht-Beteiligungsfiltern',
        localSampleSize: finiteNumber(deviations?.local?.total),
        referenceSampleSize: finiteNumber(deviations?.baseline?.total),
        formulas: {
          localShare: 'locR = locCnt / local.total',
          referenceShare: 'baseR = baseCnt / baseline.total',
          factor: 'factor = locR / baseR',
          uncertainty: 'Wilson-Score-Konfidenzintervall (95 %) für den lokalen Anteil',
          significance: 'isSignificant = true, wenn ciLow > baseR'
        },
        interpretation: 'Eine Überrepräsentation betrifft die Zusammensetzung des dokumentierten Unfallgeschehens.',
        exposureRequirement: 'Keine Exposition für den Anteilvergleich; Exposition nur für absolute Risiko-/Unfallratenaussagen.',
        precisionNote: 'Die Präzision hängt von den Stichprobenumfängen ab.'
      },
      yearlyTrend: {
        comparisonType: 'within-area-relative-linear-trend',
        formula: 'relativeSlope = slope / mean(yearly totals)',
        slope,
        meanAnnualCount: mean,
        relativeSlope,
        r2: finiteNumber(yearlyTrend?.r2, yearlyTrend?.rSquared),
        nYears: finiteNumber(yearlyTrend?.nYears),
        classification: yearlyTrend?.classification || null,
        interpretation: 'Relative zeitliche Entwicklung der dokumentierten Jahreswerte im selben gefilterten Bereich.'
      }
    };
  }

  function bridgeFactsPackage() {
    const internal = UA.aiProposal?._internal;
    if (!internal || typeof internal.buildExternalAiFactsPackage !== 'function') return false;
    if (internal.buildExternalAiFactsPackage._uaMethodologyContractWrapped) return true;

    const original = internal.buildExternalAiFactsPackage;
    const wrapped = function buildFactsWithMethodology(input) {
      const facts = original.call(this, input);
      const structured = input?.structured || facts?.structured;
      const methodology = structured?.analysisMethodology || buildAnalysisMethodology(structured);
      if (facts && typeof facts === 'object') {
        facts.analysisMethodology = methodology;
        facts.methodologyQaGate = {
          required: 'Vor jeder statistischen Kritik muss die KI den Methodenvertrag korrekt wiedergeben.',
          rejectIf: 'Die KI behandelt den Musteranteilsvergleich als direkten Vergleich absoluter Unfallraten oder verlangt dafür pauschal einen Expositionsnenner.'
        };
      }
      return facts;
    };
    wrapped._uaMethodologyContractWrapped = true;
    wrapped._uaOriginal = original;
    internal.buildExternalAiFactsPackage = wrapped;
    return true;
  }

  function bridgeReport(report, ctxValue) {
    const ctx = runtimeContext(ctxValue);
    // Only touch reports for which an AI workflow explicitly started or
    // recorded political research. Normal technical exports remain unchanged.
    if (!ctx.__uaPoliticalResearchPromise && !ctx.politicalContextResearch) return report;
    const structured = report?.structured;
    if (!structured || typeof structured !== 'object') return report;

    structured.analysisMethodology = buildAnalysisMethodology(structured);

    const state = UA.aiPoliticalEvidence.currentState(ctx);
    structured.politicalContextResearch = state;

    if (state.status === 'results-found') {
      const refs = suitableReferences(state);
      structured.politicalReferences = mergeReferences(structured.politicalReferences, refs);
      structured.references = mergeReferences(structured.references, refs);
    } else {
      structured.references = mergeReferences(structured.references, [statusReference(state)]);
    }
    return report;
  }

  function install() {
    bridgeFactsPackage();
    if (!UA.aiPoliticalEvidence || typeof UA.aiPoliticalEvidence.currentState !== 'function') return false;
    if (typeof UA.computeExportReport !== 'function') return false;
    if (UA.computeExportReport._uaPoliticalReferenceBridgeWrapped) return true;

    const original = UA.computeExportReport;
    const wrapped = async function computeWithPoliticalReferenceBridge(ctxValue, ...args) {
      const report = await original.call(this, ctxValue, ...args);
      return bridgeReport(report, ctxValue);
    };
    wrapped._uaPoliticalReferenceBridgeWrapped = true;
    wrapped._uaOriginal = original;
    UA.computeExportReport = wrapped;
    bridgeFactsPackage();
    return true;
  }

  UA.aiPoliticalReferenceBridge = Object.freeze({
    install,
    bridgeReport,
    buildAnalysisMethodology,
    _internal: Object.freeze({
      clean,
      finiteNumber,
      normalizeReference,
      referenceKey,
      mergeReferences,
      statusReference,
      suitableReferences,
      runtimeContext,
      bridgeFactsPackage,
    }),
  });

  let attempts = 0;
  const installWhenReady = () => {
    if (install()) return;
    if (attempts++ < MAX_INSTALL_ATTEMPTS && typeof root.setTimeout === 'function') {
      root.setTimeout(installWhenReady, POLL_INTERVAL_MS);
    }
  };
  installWhenReady();
})();
