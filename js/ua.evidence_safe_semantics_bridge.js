'use strict';

(function evidenceSafeSemanticsBridge(root) {
  const UA = root.UA = root.UA || {};
  const BASE_MARK = '__uaEvidenceSafe644';
  const HARDENING_MARK = '__uaEvidenceSafe644Hardening';
  const BRIDGE_MARK = '__uaEvidenceSafe644Bridge';
  const CONTROL_MARK = '__uaEvidenceSafe644BridgeControl';
  const REPORT_MARK = '__uaEvidenceSafe644BridgeProcessed';
  const TEXT_APPENDIX_MARKER = 'VOLLSTÄNDIGE NUMMERIERTE UNFALLBEWEISANLAGE';
  const HTML_APPENDIX_MARKER = 'data-ua-evidence-appendix';
  const METHOD_LINE =
    'Vollständiger Antragsbeleg: Die nummerierte completeEvidenceCohort umfasst alle Unfälle im Antragsgebiet; Suchfilter begrenzen diese Menge nicht, sondern kennzeichnen ausschließlich die explorative Teilmenge.';

  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = value => Array.isArray(value) ? value : [];

  function transformNarrative(value) {
    if (typeof value !== 'string') return value;
    let output = value;
    if (typeof UA.EvidenceSafeSemantics?.safeText === 'function') {
      output = UA.EvidenceSafeSemantics.safeText(output);
    }
    if (typeof UA.EvidenceSafeSemanticsHardening?.eventText === 'function') {
      output = UA.EvidenceSafeSemanticsHardening.eventText(output);
    }
    return output;
  }

  function transformTextOutsideAppendix(value) {
    if (typeof value !== 'string') return value;
    const markerIndex = value.indexOf(TEXT_APPENDIX_MARKER);
    if (markerIndex < 0) return transformNarrative(value);
    return transformNarrative(value.slice(0, markerIndex)) + value.slice(markerIndex);
  }

  function transformHtmlOutsideAppendix(value) {
    if (typeof value !== 'string') return value;
    const markerIndex = value.indexOf(HTML_APPENDIX_MARKER);
    if (markerIndex < 0) return transformNarrative(value);

    const sectionStart = Math.max(0, value.lastIndexOf('<section', markerIndex));
    const sectionClose = value.indexOf('</section>', markerIndex);
    if (sectionClose < 0) {
      return transformNarrative(value.slice(0, sectionStart)) + value.slice(sectionStart);
    }
    const appendixEnd = sectionClose + '</section>'.length;
    return transformNarrative(value.slice(0, sectionStart))
      + value.slice(sectionStart, appendixEnd)
      + transformNarrative(value.slice(appendixEnd));
  }

  function ensureEvidenceCohortMethodLine(structuredValue) {
    const structured = object(structuredValue);
    const hasEvidenceCohort = Boolean(
      structured.evidenceCohorts
      || structured.evidenceCohortContract
      || structured.accidentEvidenceAppendix
    );
    if (!hasEvidenceCohort) return structured;

    const methodikScope = object(structured.methodikScope);
    const lines = list(methodikScope.lines).slice();
    if (!lines.some(line => /Suchfilter begrenzen diese Menge nicht/i.test(String(line)))) {
      lines.push(METHOD_LINE);
    }
    return {
      ...structured,
      methodikScope: {
        ...methodikScope,
        lines,
      },
    };
  }

  function hardenStructuredReport(reportValue) {
    if (reportValue?.[REPORT_MARK] === true) return reportValue;
    const report = object(reportValue);
    const originalText = report.text;
    const originalHtml = report.html;
    let hardened = { ...report, text: null, html: null };

    // The hardening contract already delegates to the base semantic contract.
    // Run that combined path exactly once. If the hardening module is absent,
    // retain the base-only fallback. The full numbered accident appendix can
    // contain tens of thousands of rows and must not be copied and scanned by
    // multiple compatibility passes.
    if (typeof UA.EvidenceSafeSemanticsHardening?.hardenReport === 'function') {
      hardened = UA.EvidenceSafeSemanticsHardening.hardenReport(hardened) || hardened;
      hardened.text = null;
      hardened.html = null;
    } else if (typeof UA.EvidenceSafeSemantics?.safeReport === 'function') {
      hardened = UA.EvidenceSafeSemantics.safeReport(hardened) || hardened;
      hardened.text = null;
      hardened.html = null;
    }

    const result = {
      ...report,
      ...hardened,
      structured: ensureEvidenceCohortMethodLine(hardened.structured || report.structured),
      text: transformTextOutsideAppendix(originalText),
      html: transformHtmlOutsideAppendix(originalHtml),
    };
    try {
      Object.defineProperty(result, REPORT_MARK, {
        value: true,
        enumerable: false,
        configurable: false,
      });
    } catch (_) {
      result[REPORT_MARK] = true;
    }
    return result;
  }

  function restoreIncompleteBackgroundRender(ctx) {
    const snapshot = UA.lifecycle?.getSnapshot?.();
    if (!ctx || !snapshot || snapshot.status !== 'rendering') return false;

    // Report preparation may load optional context and leave a superseded map
    // render revision behind (most visibly when cluster and heatmap are both
    // active). The report is already complete at this point; schedule exactly
    // one ordinary application render so the interactive background returns
    // to the same fail-closed lifecycle contract used by screenshots and later
    // exports. Never manufacture lifecycle completion directly.
    if (ctx.store && typeof ctx.store.dispatch === 'function') {
      ctx.store.dispatch('filtersChanged');
      return true;
    }
    if (typeof UA.renderLayers === 'function') {
      ctx._dataChanged = true;
      UA.renderLayers(ctx);
      return true;
    }
    return false;
  }

  function deactivateReportFunction(current) {
    const control = current?.[CONTROL_MARK];
    if (control) control.active = false;
  }

  function wrapReportFunction(current) {
    if (typeof current !== 'function' || current[BRIDGE_MARK]) return current;
    const control = { active: true };
    const wrapped = async function evidenceSafeComputeExportReport(...args) {
      // Snapshot ownership before awaiting the underlying report. A later
      // module may replace the public wrapper while this invocation is still
      // running. In that case the replacement cannot participate in this
      // already-started call, so this wrapper must still finalize it. Wrappers
      // that were already superseded when invoked remain pass-through.
      const finalizeThisInvocation = control.active;
      const report = await current.apply(this, args);
      if (!finalizeThisInvocation) return report;
      const hardened = hardenStructuredReport(report);
      restoreIncompleteBackgroundRender(args[0]);
      return hardened;
    };
    Object.defineProperties(wrapped, {
      [BASE_MARK]: { value: true },
      [HARDENING_MARK]: { value: true },
      [BRIDGE_MARK]: { value: true },
      [CONTROL_MARK]: { value: control },
      // Existing late-binding modules detect their own hooks by following
      // these conventional links. Preserve the wrapped chain so observers do
      // not install the same expensive report decorator repeatedly.
      _uaOriginal: { value: current },
      _original: { value: current },
    });
    return wrapped;
  }

  function installDeterministicReportBridge() {
    const existing = Object.getOwnPropertyDescriptor(UA, 'computeExportReport');
    if (existing?.get?.[BRIDGE_MARK] === true) return UA;

    // Another bootstrap guard may temporarily own the property while waiting
    // for the real export implementation. Replacing that foreign accessor
    // would silently drop its safety check. Wait until it has resolved to an
    // ordinary function property, then install this finalizing bridge around
    // the complete guarded chain.
    if (existing && (typeof existing.get === 'function' || typeof existing.set === 'function')) {
      return false;
    }

    let implementation = wrapReportFunction(existing?.value);
    const getter = function getEvidenceSafeComputeExportReport() {
      return implementation;
    };
    getter[BRIDGE_MARK] = true;

    Object.defineProperty(UA, 'computeExportReport', {
      configurable: true,
      enumerable: existing?.enumerable !== false,
      get: getter,
      set(value) {
        if (value === implementation) return;
        const next = wrapReportFunction(value);
        if (next === implementation) return;
        deactivateReportFunction(implementation);
        implementation = next;
      },
    });
    return UA;
  }

  function ownsLiveReportBridge() {
    const descriptor = Object.getOwnPropertyDescriptor(UA, 'computeExportReport');
    return descriptor?.get?.[BRIDGE_MARK] === true
      && typeof UA.computeExportReport === 'function';
  }

  UA.EvidenceSafeSemanticsBridge = Object.freeze({
    METHOD_LINE,
    transformTextOutsideAppendix,
    transformHtmlOutsideAppendix,
    ensureEvidenceCohortMethodLine,
    hardenStructuredReport,
    restoreIncompleteBackgroundRender,
    wrapReportFunction,
    ownsLiveReportBridge,
    install: installDeterministicReportBridge,
  });

  installDeterministicReportBridge();
  if (typeof root.setTimeout === 'function' && !ownsLiveReportBridge()) {
    let attempts = 0;
    const retry = () => {
      installDeterministicReportBridge();
      if (!ownsLiveReportBridge() && attempts++ < 400) root.setTimeout(retry, 25);
    };
    root.setTimeout(retry, 25);
  }
})(window);
