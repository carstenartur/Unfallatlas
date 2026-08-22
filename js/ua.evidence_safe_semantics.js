'use strict';

(function evidenceSafeSemantics(root) {
  const UA = root.UA = root.UA || {};
  const SCHEMA = 'unfallwerkbank.evidenceSafeSemantics.v1';
  const MARK = '__uaEvidenceSafe644';
  const PARTS = [
    [1, 'Rad', 'Radverkehr'], [2, 'Fuß', 'Fußverkehr'], [4, 'Pkw', 'Pkw'],
    [8, 'Kraftrad', 'Kraftrad'], [16, 'Gkfz', 'Güterkraftfahrzeug'],
    [32, 'Sonstige', 'sonstiger veröffentlichter Beteiligungskategorie']
  ];
  const SEV_ONE = { 1: 'Unfall mit Getöteten', 2: 'Unfall mit Schwerverletzten', 3: 'Unfall mit Leichtverletzten' };
  const SEV_MANY = { 1: 'Unfälle mit Getöteten', 2: 'Unfälle mit Schwerverletzten', 3: 'Unfälle mit Leichtverletzten' };
  const list = value => Array.isArray(value) ? value : [];
  const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const num = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

  function maskParts(mask) { return PARTS.filter(([bit]) => (Number(mask) & bit) !== 0); }
  function join(parts) {
    if (parts.length < 2) return parts[0] || '';
    if (parts.length === 2) return `${parts[0]} und ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')} und ${parts.at(-1)}`;
  }
  function involvementLabel(mask, compact = false) {
    const parts = maskParts(mask);
    if (!parts.length) return compact ? 'Beteiligungskategorie nicht veröffentlicht' : 'Unfall ohne auswertbare veröffentlichte Beteiligungskategorie';
    if (compact) return `${parts.length === 1 ? 'Beteiligungskategorie' : 'Beteiligungskategorien'}: ${parts.map(p => p[1]).join(' + ')}`;
    if (parts.length === 1) return `Unfall mit ausschließlich gesetzter Beteiligungskategorie ${parts[0][2]}`;
    return `Unfall mit veröffentlichter Beteiligung von ${join(parts.map(p => p[2]))}`;
  }
  function severityLabel(value, plural = false) {
    return (plural ? SEV_MANY : SEV_ONE)[Number(value)] || (plural ? 'Unfälle mit nicht veröffentlichter schwerster Folge' : 'Unfall mit nicht veröffentlichter schwerster Folge');
  }
  function safeText(value) {
    if (typeof value !== 'string') return value;
    const rules = [
      [/Auffälliger Unfallschwerpunkt/gi, 'Zu prüfende lokale Unfallauffälligkeit'],
      [/Lokaler Häufungspunkt mit erhöhtem Risikoprofil/gi, 'Explorativer lokaler Zusammensetzungsbefund'],
      [/URSACHEN UND MASSNAHMEN/gi, 'PRÜFHYPOTHESEN UND MASSNAHMENOPTIONEN'],
      [/Fahrrad-?Alleinunfälle?/gi, 'Unfälle mit ausschließlich gesetzter Rad-Beteiligungskategorie'],
      [/Rad-only-?\/Fahrradalleinunfall-Konstellation/gi, 'Rad-Beteiligungskategorie ohne weitere gesetzte Kategorie'],
      [/Rad\+Pkw-(?:Kollisionen?|Unfällen?)/gi, 'Unfälle mit Rad- und Pkw-Beteiligung'],
      [/Rad[-/]Pkw-(?:Kollision|Konflikt)/gi, 'Rad- und Pkw-Beteiligungsmuster'],
      [/Fuß[-/]Pkw-(?:Kollision|Konflikt)/gi, 'Fuß- und Pkw-Beteiligungsmuster'],
      [/Rad[-/]Fuß(?:verkehr)?(?:s)?konflikt/gi, 'Rad- und Fuß-Beteiligungsmuster'],
      [/Rad\+Fuß-Unfällen?/gi, 'Unfällen mit Rad- und Fuß-Beteiligung'],
      [/Rad\+Gkfz-Unfällen?/gi, 'Unfällen mit Rad- und Güterkraftfahrzeug-Beteiligung'],
      [/Lkw[-/]Rad[- ]Abbiegen/gi, 'Rad- und Güterkraftfahrzeug-Beteiligungsmuster'],
      [/Lkw[-/]Fuß[- ]Abbiegen/gi, 'Fuß- und Güterkraftfahrzeug-Beteiligungsmuster'],
      [/Rad[-/](?:Bus|ÖPNV)-(?:Konflikt|Beteiligung)/gi, 'Rad- und sonstiges Beteiligungsmuster'],
      [/Sonstige\s*\/\s*ÖPNV/gi, 'sonstige veröffentlichte Beteiligungskategorie'],
      [/🚌/g, 'Sonstige'],
      [/Schulverkehr \(morgens\)/gi, 'Werktägliches Morgenfenster (Schul-/Berufsverkehr möglich, nicht nachgewiesen)'],
      [/Schulverkehr \(nachmittags\)/gi, 'Werktägliches Mittags-/Nachmittagsfenster (Schulverkehr möglich, nicht nachgewiesen)'],
      [/Berufsverkehr \(morgens\)/gi, 'Werktägliches erweitertes Morgenfenster (Fahrtzweck nicht veröffentlicht)'],
      [/Berufsverkehr \(abends\)/gi, 'Werktägliches spätes Nachmittags-/Abendfenster (Fahrtzweck nicht veröffentlicht)'],
      [/Getötete \+ Schwerverletzte/gi, 'Unfälle mit tödlichen oder schweren Folgen'],
      [/die tatsächliche Belastung kann je nach Verkehrsart um den Faktor 2[–-]10 höher liegen\.?/gi,
        'die Dunkelziffer ist lokal unbekannt und unterscheidet sich stark nach Unfallkonstellation und Verletzungsschwere; aus den dargestellten Fallzahlen darf keine lokale Gesamtzahl hochgerechnet werden.'],
      [/Wirksamkeit nach 12 Monaten anhand der Unfallatlas-Daten überprüfen/gi,
        'Umsetzung kurzfristig anhand von Konflikt-, Geschwindigkeits-, Verkehrs- und Qualitätsindikatoren sowie längerfristig anhand mehrjähriger Unfallzahlen überprüfen']
    ];
    return rules.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  }
  function deepSafe(value, depth = 0) {
    if (depth > 7 || value == null) return value;
    if (typeof value === 'string') return safeText(value);
    if (Array.isArray(value)) return value.map(v => deepSafe(v, depth + 1));
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, deepSafe(val, depth + 1)]));
  }
  function safeRow(row) {
    const mask = num(row?.mask ?? row?.involvementMask);
    return mask === null ? deepSafe(row) : { ...deepSafe(row), label: involvementLabel(mask, true), textLabel: involvementLabel(mask), semantics: 'published-participation-categories-not-mechanism' };
  }
  function detailRows(structured) {
    const out = [];
    function walk(value, depth = 0) {
      if (depth > 4 || value == null) return;
      if (Array.isArray(value)) return value.forEach(v => walk(v, depth + 1));
      if (typeof value !== 'object') return;
      if (num(value.mask ?? value.involvementMask) !== null && num(value.severity ?? value.ukategorie ?? value.UKATEGORIE) !== null) out.push(value);
      ['items', 'rows', 'groups', 'all'].forEach(key => walk(value[key], depth + 1));
    }
    [structured?.accidentDetails, structured?.accidentRows, structured?.selectedAccidents, structured?.accidents].forEach(walk);
    return out;
  }
  function sameCohortSerious(structured, mask) {
    if (detailRows(structured).some(row => Number(row.mask ?? row.involvementMask) === Number(mask) && [1, 2].includes(Number(row.severity ?? row.ukategorie ?? row.UKATEGORIE)))) return true;
    const row = list(structured?.deviations?.focus).find(item => Number(item?.mask) === Number(mask));
    const sev = row?.bySev || row?.severityCounts || row?.severity?.bySev;
    return !!sev && Number(sev[1] ?? sev.sev1 ?? 0) + Number(sev[2] ?? sev.sev2 ?? 0) > 0;
  }
  function qualify(value) {
    const text = safeText(String(value || '').trim());
    if (!text || /^(Prüfung|Prüfauftrag|Vor-Ort|Fachprüfung|Zu prüfen|Untersuchung)/i.test(text)) return text;
    return `Prüfoption (keine Umsetzungsfreigabe; örtlich und fachlich zu verifizieren): ${text}`;
  }
  function safeMeasures(value) {
    const current = obj(value);
    return {
      ...deepSafe(current),
      kurzfristig: list(current.kurzfristig).map(qualify),
      mittelfristig: list(current.mittelfristig).map(qualify),
      pruefauftraege: list(current.pruefauftraege).map(safeText),
      rationale: 'Beteiligungs-, Zeit- und aktuelle Kontextdaten begründen nur Prüfhypothesen. Ein Unfallmechanismus oder eine Ursache ist ohne zusätzliche orts- und fallbezogene Evidenz nicht bestätigt.',
      evidenceStage: 'mechanism-candidate'
    };
  }
  function official(structured) {
    return structured?.officialAccidentHotspot === true || structured?.isOfficialAccidentHotspot === true || structured?.meta?.officialAccidentHotspot === true || structured?.spatialClassification?.officialHotspot === true;
  }
  function safeSummary(summary, structured) {
    const focus = list(structured?.deviations?.focus);
    const significant = focus.some(row => row?.isSignificant === true);
    const classification = official(structured)
      ? 'Amtlich bestätigter Unfallschwerpunkt; Beteiligungsmuster, räumlicher Befund und amtliche Einstufung werden getrennt ausgewiesen.'
      : significant
        ? 'Signifikante Abweichung in der lokalen Beteiligungsmuster-Zusammensetzung; kein räumlicher oder amtlicher Unfallschwerpunkt ist damit belegt.'
        : focus.length
          ? 'Explorative Abweichung in der Beteiligungsmuster-Zusammensetzung; kein räumlicher oder amtlicher Unfallschwerpunkt ist belegt.'
          : 'Keine belastbare lokale Abweichung der Beteiligungsmuster erkennbar; räumliche und amtliche Einstufungen sind gesondert zu prüfen.';
    return { ...deepSafe(obj(summary)), classification, urgency: significant ? 'Zeitnahe fachliche Prüfung empfohlen; aus dem Zusammensetzungsbefund folgt noch keine konkrete Ursache oder Maßnahme.' : 'Beobachtung und fachliche Prüfung nach Datenlage; keine automatische Maßnahmenfreigabe.' };
  }
  function safeReport(report) {
    if (!report || typeof report !== 'object') return report;
    const structured = obj(report.structured);
    if (structured.deviations) structured.deviations = { ...structured.deviations, rows: list(structured.deviations.rows).map(safeRow), focus: list(structured.deviations.focus).map(safeRow), semantics: 'composition-not-absolute-risk' };
    if (structured.crossTable) structured.crossTable = { ...structured.crossTable, rows: list(structured.crossTable.rows).map(safeRow) };
    if (structured.contextualMeasures) structured.contextualMeasures = safeMeasures(structured.contextualMeasures);
    structured.executiveSummary = safeSummary(structured.executiveSummary, structured);
    if (structured.darkFigureNote) structured.darkFigureNote = { ...deepSafe(structured.darkFigureNote), body: 'Erfasst sind polizeilich aufgenommene Verkehrsunfälle mit Personenschaden. Reine Sachschäden, Beinaheereignisse und nicht gemeldete Unfälle fehlen. Die Dunkelziffer ist lokal unbekannt und unterscheidet sich erheblich nach Unfallkonstellation und Verletzungsschwere; die Fallzahlen dürfen nicht auf eine lokale Gesamtzahl hochgerechnet werden.' };
    structured.semanticContract = { schemaVersion: SCHEMA, stages: ['official-observation', 'reproducible-derivation', 'test-hypothesis', 'supported-mechanism', 'measure-option'], severityUnit: 'accident-event-classified-by-most-severe-consequence', prohibitedFromFlagsAlone: ['collision', 'single-party accident', 'bus/public transport', 'turning manoeuvre', 'cause', 'official black spot'] };
    ['title', 'subject', 'applicationTitle', 'resolution', 'beschluss', 'intro'].forEach(key => { if (typeof structured[key] === 'string') structured[key] = safeText(structured[key]); });
    report.structured = structured;
    if (typeof report.text === 'string') report.text = safeText(report.text);
    if (typeof report.html === 'string') report.html = safeText(report.html);
    return report;
  }
  function safeCluster(cluster) {
    const names = { werktag_schule_morgens: 'Werktägliches Morgenfenster', werktag_schule_nachmittags: 'Werktägliches Mittags-/Nachmittagsfenster', werktag_berufsverkehr_morgens: 'Werktägliches erweitertes Morgenfenster', werktag_berufsverkehr_abends: 'Werktägliches spätes Nachmittags-/Abendfenster' };
    return { ...cluster, label: names[cluster?.id] || safeText(cluster?.label || cluster?.id), typicalParticipants: [], interpretation: /schule/i.test(cluster?.id || '') ? 'Mit Schul- und gegebenenfalls Berufsverkehr vereinbar; Kinderbeteiligung, Fahrtzweck und Schulwegbezug sind nicht veröffentlicht.' : 'Deskriptives Zeitfenster; der Fahrtzweck ist nicht veröffentlicht.' };
  }
  function patchLabels() {
    if (!UA.COMBO_LABEL || UA.COMBO_LABEL[1]?.startsWith('Beteiligungskategorie')) return;
    UA.COMBO_LABEL = Object.fromEntries(Array.from({ length: 63 }, (_, index) => [index + 1, involvementLabel(index + 1, true)]));
  }
  function patchContext() {
    const current = UA.contextMeasures;
    if (!current || current[MARK]) return;
    const patched = { ...current, [MARK]: true };
    if (typeof current.classifyPatterns === 'function') patched.classifyPatterns = structured => {
      const output = new Set(current.classifyPatterns(structured));
      output.delete('rad_alleinunfall_schwer');
      if (output.has('rad_alleinunfall') && sameCohortSerious(structured, 1)) output.add('rad_alleinunfall_schwer');
      return output;
    };
    if (typeof current.deriveContextualMeasures === 'function') patched.deriveContextualMeasures = (patterns, contexts) => safeMeasures(current.deriveContextualMeasures(patterns, contexts));
    UA.contextMeasures = patched;
  }
  function patchTime() {
    const current = UA.timeClusters;
    if (!current || current[MARK]) return;
    const patched = { ...current, [MARK]: true, DEFAULT_CLUSTERS: list(current.DEFAULT_CLUSTERS).map(safeCluster), FALLBACK: { ...obj(current.FALLBACK), clusters: list(current.FALLBACK?.clusters || current.DEFAULT_CLUSTERS).map(safeCluster) } };
    if (typeof current.loadTimeClusters === 'function') patched.loadTimeClusters = async city => { const result = await current.loadTimeClusters(city); return { ...result, clusters: list(result?.clusters).map(safeCluster) }; };
    UA.timeClusters = patched;
  }
  function patchViews() {
    const current = UA.applyAccidentView;
    if (typeof current !== 'function' || current[MARK]) return;
    const wrapped = function (items, view, options) {
      const result = current.call(this, items, view, options);
      list(result?.groups).forEach(group => {
        if (group?.meta?.mask != null) group.meta.label = involvementLabel(group.meta.mask, true);
        if (group?.meta?.sevLabel && group.key != null) group.meta.sevLabel = severityLabel(group.key, true);
        list(group?.rows).forEach(row => { if (row?.mask != null) row.involved = involvementLabel(row.mask, true); if (row?.severity != null) row.sevLabel = severityLabel(row.severity); });
        if (group?.headers) { if (typeof group.headers.text === 'string') group.headers.text = safeText(group.headers.text); if (typeof group.headers.html === 'string') group.headers.html = safeText(group.headers.html); if (Array.isArray(group.headers.docx)) group.headers.docx = deepSafe(group.headers.docx); }
      });
      return result;
    };
    wrapped[MARK] = true;
    UA.applyAccidentView = wrapped;
  }
  function pointYear(point) { const props = point?.props || point?.properties || point || {}; return num(props.year ?? props.ujahr ?? props.UJAHR); }
  function pointSeverity(point) { const props = point?.props || point?.properties || point || {}; return String(props.ukategorie ?? props.UKATEGORIE ?? props.severity ?? ''); }
  function patchTrend() {
    const trend = UA.trend;
    if (!trend || typeof trend.computeYearlyTrend !== 'function' || trend.computeYearlyTrend[MARK]) return;
    const original = trend.computeYearlyTrend;
    trend.computeYearlyTrend = function (points, options = {}) {
      const base = original.call(trend, points, options);
      const observed = list(points).map(pointYear).filter(Number.isFinite);
      let years = list(options.years).map(Number).filter(Number.isFinite);
      if (!years.length && Number.isFinite(Number(options.fromYear)) && Number.isFinite(Number(options.toYear))) years = Array.from({ length: Number(options.toYear) - Number(options.fromYear) + 1 }, (_, i) => Number(options.fromYear) + i);
      if (!years.length && observed.length) years = Array.from({ length: Math.max(...observed) - Math.min(...observed) + 1 }, (_, i) => Math.min(...observed) + i);
      if (years.length < 2) return base;
      const rows = new Map(years.map(year => [year, { fatal: 0, severe: 0, light: 0, total: 0 }]));
      list(points).forEach(point => { const row = rows.get(pointYear(point)); if (!row) return; const sev = pointSeverity(point); if (sev === '1') row.fatal++; else if (sev === '2') row.severe++; else if (sev === '3') row.light++; row.total++; });
      const counts = { fatal: [], severe: [], light: [], total: [] };
      years.forEach(year => Object.keys(counts).forEach(key => counts[key].push(rows.get(year)[key])));
      const reg = typeof trend.linearRegression === 'function' ? trend.linearRegression(years, counts.total) : base;
      return { ...base, years, counts, slope: reg.slope, intercept: reg.intercept, r2: reg.r2, classification: typeof trend.classifyTrend === 'function' ? trend.classifyTrend(reg.slope, reg.mean, reg.r2, years.length) : base.classification, nYears: years.length, zeroYears: years.filter((year, i) => counts.total[i] === 0) };
    };
    trend.computeYearlyTrend[MARK] = true;
  }
  function patchDirect() {
    if (typeof UA.formatInvolvementCombo === 'function' && !UA.formatInvolvementCombo[MARK]) { UA.formatInvolvementCombo = (mask, options = {}) => involvementLabel(mask, options.format === 'emoji' || options.compact === true); UA.formatInvolvementCombo[MARK] = true; }
    if (typeof UA.buildExecutiveSummary === 'function' && !UA.buildExecutiveSummary[MARK]) { const original = UA.buildExecutiveSummary; UA.buildExecutiveSummary = (structured, options) => safeSummary(original(structured, options), structured || {}); UA.buildExecutiveSummary[MARK] = true; }
    if (typeof UA.buildCausesMeasuresSection === 'function' && !UA.buildCausesMeasuresSection[MARK]) { const original = UA.buildCausesMeasuresSection; UA.buildCausesMeasuresSection = (rows, measures) => list(original(rows, measures)).map(item => ({ ...deepSafe(item), cause: item?.mask != null ? involvementLabel(item.mask) : safeText(item?.cause), measures: list(item?.measures).map(qualify), evidenceStage: 'test-hypothesis' })); UA.buildCausesMeasuresSection[MARK] = true; }
  }
  function patchReport() {
    const current = UA.computeExportReport;
    if (typeof current !== 'function' || current[MARK]) return;
    UA.computeExportReport = async function (...args) { return safeReport(await current.apply(this, args)); };
    UA.computeExportReport[MARK] = true;
  }
  function install() { patchLabels(); patchTime(); patchViews(); patchContext(); patchTrend(); patchDirect(); patchReport(); return UA; }

  UA.EvidenceSafeSemantics = Object.freeze({ SCHEMA, involvementLabel, severityLabel, safeText, sameCohortSerious, safeMeasures, safeSummary, safeReport, safeCluster, install });
  if (!root.__UA_DISABLE_EVIDENCE_SAFE_AUTOINSTALL__ && typeof root.setTimeout === 'function') {
    let attempts = 0;
    const retry = () => { install(); if (attempts++ < 400) root.setTimeout(retry, 25); };
    retry();
  }
})(window);
