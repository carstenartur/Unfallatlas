'use strict';

(function evidenceSafeSemanticsHardening(root) {
  const UA = root.UA = root.UA || {};
  const MARK = '__uaEvidenceSafe644Hardening';
  const BASE_MARK = '__uaEvidenceSafe644';
  const list = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const TEXTUAL_FIELDS = Object.freeze([
    'executiveSummary',
    'causesMeasures',
    'contextualMeasures',
    'patternDetection',
    'patterns',
    'deviations',
    'crossTable',
    'timeClusters',
    'mapReferences',
    'methodikScope',
    'osmInsights',
    'visualContextHints',
    'darkFigureNote',
    'enrichmentSourcesNote',
    'references',
    'politicalReferences',
    'evidenceCohortContract',
  ]);
  const EVIDENCE_COHORT_METHOD_LINE =
    'Vollständiger Antragsbeleg: Die nummerierte completeEvidenceCohort umfasst alle Unfälle im Antragsgebiet; Suchfilter begrenzen diese Menge nicht, sondern kennzeichnen ausschließlich die explorative Teilmenge.';

  function eventText(value) {
    if (typeof value !== 'string') return value;
    const base = UA.EvidenceSafeSemantics?.safeText
      ? UA.EvidenceSafeSemantics.safeText(value)
      : value;
    return base
      .replace(/(?<!Unfall mit )(?<!Unfälle mit )\bGetötete\b/g, 'Unfälle mit Getöteten')
      .replace(/(?<!Unfall mit )(?<!Unfälle mit )\bSchwerverletzte\b/g, 'Unfälle mit Schwerverletzten')
      .replace(/(?<!Unfall mit )(?<!Unfälle mit )\bLeichtverletzte\b/g, 'Unfälle mit Leichtverletzten')
      .replace(/Rad[-/]+(?:Lkw|Gkfz|Güterkraftfahrzeug)-(?:Konflikt|Kollision)/gi,
        'Rad- und Güterkraftfahrzeug-Beteiligungsmuster')
      .replace(/Fuß[-/]+(?:Lkw|Gkfz|Güterkraftfahrzeug)-(?:Konflikt|Kollision)/gi,
        'Fuß- und Güterkraftfahrzeug-Beteiligungsmuster')
      .replace(/Rad[-/]+Krad-(?:Konflikt|Kollision)/gi,
        'Rad- und Kraftrad-Beteiligungsmuster');
  }

  function deep(value, depth = 0, seen = new WeakMap()) {
    if (depth > 8 || value == null) return value;
    if (typeof value === 'string') return eventText(value);
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    const copy = Array.isArray(value) ? [] : {};
    seen.set(value, copy);
    if (Array.isArray(value)) {
      value.forEach(item => copy.push(deep(item, depth + 1, seen)));
      return copy;
    }
    Object.entries(value).forEach(([key, item]) => {
      copy[key] = deep(item, depth + 1, seen);
    });
    return copy;
  }

  function qualify(value) {
    const text = eventText(String(value || '').trim());
    if (!text || /^(Prüfung|Prüfauftrag|Prüfoption|Vor-Ort|Fachprüfung|Zu prüfen|Untersuchung)/i.test(text)) return text;
    return `Prüfoption (keine Umsetzungsfreigabe; örtlich und fachlich zu verifizieren): ${text}`;
  }

  function hardenRecommendedMeasures(value) {
    const current = object(value);
    return {
      ...deep(current),
      measures: list(current.measures).map(entry => {
        const wrapper = object(entry);
        const measure = object(wrapper.measure && typeof wrapper.measure === 'object' ? wrapper.measure : wrapper);
        const stage = String(wrapper.causalStatus || measure.causalStatus || wrapper.evidenceStage || measure.evidenceStage || '');
        const supported = ['mechanism-plausible', 'causally-confirmed', 'supported-mechanism'].includes(stage);
        const hardened = {
          ...deep(measure),
          label: supported ? eventText(measure.label) : qualify(measure.label),
          description: supported ? eventText(measure.description) : qualify(measure.description),
          evidenceStage: supported ? (measure.evidenceStage || wrapper.evidenceStage || 'supported-mechanism') : 'measure-option',
        };
        return wrapper.measure && typeof wrapper.measure === 'object'
          ? { ...deep(wrapper), measure: hardened }
          : hardened;
      }),
    };
  }

  function hardenTextualFields(structured) {
    const hardened = { ...structured };
    TEXTUAL_FIELDS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(structured, key)) {
        hardened[key] = deep(structured[key]);
      }
    });
    return hardened;
  }

  function ensureEvidenceCohortMethodLine(structured) {
    const hasEvidenceCohort = structured.evidenceCohorts
      || structured.evidenceCohortContract
      || structured.accidentEvidenceAppendix;
    if (!hasEvidenceCohort) return structured;

    const current = object(structured.methodikScope);
    const lines = list(current.lines).map(eventText);
    if (!lines.some(line => /Suchfilter begrenzen diese Menge nicht/i.test(String(line)))) {
      lines.push(EVIDENCE_COHORT_METHOD_LINE);
    }
    structured.methodikScope = { ...deep(current), lines };
    return structured;
  }

  function hardenReport(report) {
    if (!report || typeof report !== 'object') return report;
    if (UA.EvidenceSafeSemantics?.safeReport) {
      report = UA.EvidenceSafeSemantics.safeReport(report);
    }
    const structured = object(report.structured);
    if (structured.recommendedMeasures) {
      structured.recommendedMeasures = hardenRecommendedMeasures(structured.recommendedMeasures);
    }
    report.structured = ensureEvidenceCohortMethodLine(hardenTextualFields(structured));
    if (typeof report.text === 'string') report.text = eventText(report.text);
    if (typeof report.html === 'string') report.html = eventText(report.html);
    return report;
  }

  function preserveBaseMarker(wrapped, current) {
    wrapped[MARK] = true;
    if (current && current[BASE_MARK] === true) wrapped[BASE_MARK] = true;
    return wrapped;
  }

  function patchViews() {
    const current = UA.applyAccidentView;
    if (typeof current !== 'function' || current[MARK]) return;
    const wrapped = function (...args) {
      const result = current.apply(this, args);
      list(result?.groups).forEach(group => {
        if (group?.headers) {
          if (typeof group.headers.text === 'string') group.headers.text = eventText(group.headers.text);
          if (typeof group.headers.html === 'string') group.headers.html = eventText(group.headers.html);
          if (Array.isArray(group.headers.docx)) group.headers.docx = deep(group.headers.docx);
        }
      });
      return result;
    };
    UA.applyAccidentView = preserveBaseMarker(wrapped, current);
  }

  function patchReport() {
    const current = UA.computeExportReport;
    if (typeof current !== 'function' || current[MARK]) return;
    const wrapped = async function (...args) {
      return hardenReport(await current.apply(this, args));
    };
    UA.computeExportReport = preserveBaseMarker(wrapped, current);
  }

  function install() {
    patchViews();
    patchReport();
    return UA;
  }

  UA.EvidenceSafeSemanticsHardening = Object.freeze({
    eventText,
    hardenRecommendedMeasures,
    hardenReport,
    install,
  });

  if (!root.__UA_DISABLE_EVIDENCE_SAFE_AUTOINSTALL__ && typeof root.setTimeout === 'function') {
    let attempts = 0;
    const retry = () => {
      install();
      if (attempts++ < 400) root.setTimeout(retry, 25);
    };
    retry();
  }
})(window);
