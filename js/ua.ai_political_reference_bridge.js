/**
 * UA.aiPoliticalReferenceBridge
 *
 * `computeExportReport()` exposes user-selected political material in
 * `structured.politicalReferences`, while the server-side AI feature pipeline
 * reads `structured.references`. This small adapter closes that schema gap for
 * AI workflows and also injects an explicit status reference when the portal
 * research was incomplete. It prevents the server AI from interpreting an
 * empty references array as proof that no political proceedings exist.
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

  function bridgeReport(report, ctxValue) {
    const ctx = runtimeContext(ctxValue);
    // Only touch reports for which an AI workflow explicitly started or
    // recorded political research. Normal technical exports remain unchanged.
    if (!ctx.__uaPoliticalResearchPromise && !ctx.politicalContextResearch) return report;
    const structured = report?.structured;
    if (!structured || typeof structured !== 'object') return report;

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
    return true;
  }

  UA.aiPoliticalReferenceBridge = Object.freeze({
    install,
    bridgeReport,
    _internal: Object.freeze({
      clean,
      normalizeReference,
      referenceKey,
      mergeReferences,
      statusReference,
      suitableReferences,
      runtimeContext,
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
