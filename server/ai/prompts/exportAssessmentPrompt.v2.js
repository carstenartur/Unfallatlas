'use strict';

/**
 * Prompt-Builder v2 für die KI-Bewertung – unterstützt zwei Modi:
 *   - "assessment"     : fachliche Bewertung + Maßnahmen (exportAssessment.v2)
 *   - "proposal-brief" : antragsfähiger Steckbrief        (proposalBrief.v1)
 *
 * Erhält bereits aufbereitete Merkmale (`features`) und vorselektierte
 * Maßnahmen (`preselected`) statt Rohdaten.  Die KI wird damit gezwungen,
 * sich auf die deterministisch ermittelten Fakten zu stützen und Maßnahmen
 * primär aus dem Katalog zu wählen.
 *
 * @module server/ai/prompts/exportAssessmentPrompt.v2
 */

/** Versionskennung – Teil des Cache-Keys. */
const PROMPT_VERSION = 'exportAssessmentPrompt.v2.3';

const SYSTEM_PROMPT_ASSESSMENT = `Du bist Verkehrssicherheitsexpertin für deutsche Kommunen.
Du erhältst aufbereitete Unfallatlas-Daten und musst eine fachliche Bewertung erstellen.

Strenge Regeln:
1. Trenne sauber zwischen
     - "evidence" (direkt aus den Daten ableitbar),
     - "primaryRiskFactors" (plausibel, gestützt von Evidenz),
     - "secondaryRiskFactors" (Hypothese, zu prüfen).
2. Halluziniere KEINE Ortsdetails (Straßennamen, Gebäude, Schulen), die nicht im Input vorkommen.
3. Wähle Maßnahmen primär aus der bereitgestellten Maßnahmen-Vorauswahl ("preselectedMeasures").
   Verwende, wo möglich, deren id und Titel unverändert. Du darfst sortieren, kürzen, ergänzen ("whyThisFitsHere", "expectedEffect"), aber keine völlig neuen Maßnahmen erfinden, wenn passende vorhanden sind.
   Übernimm – wo passend – die mitgegebenen Felder "matchedRiskFactors", "matchedConflictPatterns", "expectedTargetAccidentTypes" und "reasonForPreselection" in deine Ausgabe.
4. "confidence" muss ehrlich auf Datenlage und Fallzahl basieren – bei < 10 Unfällen NIE "high".
5. "dataGaps" listet, was die Bewertung verbessern würde. Ergänzend dazu fülle, sofern relevant, "uncertainty" mit "missingData", "weakDataBasis", "plausibleNotEvidenced", "requiresOnSiteCheck", "alternativeExplanations".
6. Trenne Herkunft per "provenance":
     - "derivedFromDeterministicFeatures": was kommt 1:1 aus den Kennzahlen/Features?
     - "inferredByModel": was hast du verdichtet/interpretiert?
     - "uncertainOrNeedsVerification": was muss vor Ort/durch Fachstelle geprüft werden?
7. Nutze "detectedConflictPatterns" um plausible Konfliktmuster zu benennen. Stütze dich dabei auf die im Input mitgelieferten Muster und ihre Evidenz – erfinde keine neuen.
8. Antragstaugliche Felder ("shortAdministrativeSummary", "technicalRationale", "recommendedImmediateAction", "recommendedDetailedExamination", "expectedSafetyBenefit", "whyActionIsPlausibleHere", "whyEvidenceIsLimitedIfApplicable", "suggestedCouncilRequest", "suggestedReviewOrder", "fieldInspectionChecklist") sollen direkt als Rohmaterial für Antrag/Prüfauftrag/Notiz nutzbar sein – nüchtern und konkret.
9. Antworte ausschließlich als JSON gemäß dem vorgegebenen Schema (kein Markdown, kein Fließtext drumherum).`;

const SYSTEM_PROMPT_PROPOSAL = `Du bist Referentin für Verkehrspolitik in einer deutschen Kommune.
Du formulierst aus aufbereiteten Unfallatlas-Daten einen antragsfähigen Maßnahmensteckbrief.

Strenge Regeln:
1. Verwende ausschließlich die im Input genannten Fakten (keine erfundenen Straßennamen, keine fiktiven Vorfälle).
2. Maßnahmen kommen primär aus der "preselectedMeasures"-Vorauswahl. Du darfst priorisieren und begründen, aber nicht halluzinieren. Übernimm – wo passend – "matchedRiskFactors" und "matchedConflictPatterns" pro Maßnahme.
3. Trenne klar:
     - "shortVersion": kompakte Bürger-/Gremiumsfassung
     - "longVersion":  ausführliche Antragsbegründung mit Datenbezug
     - "sachverhalt", "begruendung", "beschlussvorschlag", "pruefauftrag": einzelne Antragsbausteine
4. Gib in "caveats" Datenlücken oder Unsicherheiten an, die im Antrag erwähnt werden sollten. Optional ergänzend "uncertainty" füllen.
5. Trenne Herkunft per "provenance" (was kommt aus Daten, was hast du formuliert, was ist unsicher).
6. Antragstaugliche Zusatzfelder ("shortAdministrativeSummary", "recommendedImmediateAction", "recommendedDetailedExamination", "expectedSafetyBenefit", "whyActionIsPlausibleHere", "whyEvidenceIsLimitedIfApplicable", "suggestedCouncilRequest", "suggestedReviewOrder", "fieldInspectionChecklist") sind direkt einsetzbares Rohmaterial.
7. Ton: sachlich, kommunal-üblich, frei von Polemik.
8. Antworte ausschließlich als JSON gemäß dem vorgegebenen Schema.`;

/**
 * Baut den Nutzerprompt aus features + preselected.
 *
 * @param {object} aiInput          – v2-AI-Input (siehe aiAssessmentServiceV2.buildAiInput)
 * @param {string} mode             – "assessment" | "proposal-brief"
 * @returns {{ system: string, user: string }}
 */
function buildPrompt(aiInput, mode) {
  const m = aiInput?.meta || {};
  const f = aiInput?.features || {};
  const counts = f.counts || {};
  const inv = f.involvement || {};
  const trend = f.trend || {};
  const sp = f.spatialDensity || {};
  const poi = f.poiSummary;
  const pre = aiInput?.preselectedMeasures || [];
  const refs = f.references || [];
  const hints = f.normalizedHints || {};

  const lines = [];
  lines.push('=== KONTEXT ===');
  lines.push(`Stadt: ${m.city || '(unbekannt)'}`);
  lines.push(`Bereich: ${m.areaName || '(unbekannt)'}`);
  if (m.gremium && m.gremium.name) {
    lines.push(`Gremium: ${m.gremium.name} (${m.gremium.type || ''})`);
  }
  lines.push(`Datum des Exports: ${m.date || '(unbekannt)'}`);

  lines.push('');
  lines.push('=== KENNZAHLEN (deterministisch berechnet) ===');
  lines.push(`Unfälle gesamt im Bereich: ${counts.total ?? 0}`);
  lines.push(`Davon Getötete/Schwerverletzte/Leichtverletzte: ${counts.fatal ?? 0} / ${counts.serious ?? 0} / ${counts.slight ?? 0}`);
  if (Number.isFinite(f.ksiShare)) {
    lines.push(`Anteil schwere Unfälle (getötet+schwerverletzt): ${(f.ksiShare * 100).toFixed(1)} %`);
  }

  lines.push('');
  lines.push('=== BETEILIGUNGSANTEILE ===');
  if (inv && (inv.bike != null || inv.car != null)) {
    lines.push(`Rad: ${pct(inv.bike)} | Fuß: ${pct(inv.ped)} | PKW: ${pct(inv.car)} | Krad: ${pct(inv.moto)} | Lkw: ${pct(inv.truck)}`);
    if (inv.sampleSize) lines.push(`(Stichprobengröße: ${inv.sampleSize})`);
  } else {
    lines.push('(keine ausreichende Beteiligungsstatistik vorhanden)');
  }

  if (Array.isArray(f.dominantPatterns) && f.dominantPatterns.length) {
    lines.push('');
    lines.push('=== AUFFÄLLIGE BETEILIGUNGSMUSTER ===');
    for (const d of f.dominantPatterns) {
      const rd = Number.isFinite(d.relativeDiff)
        ? ` (rel. Abweichung ${d.relativeDiff > 0 ? '+' : ''}${(d.relativeDiff * 100).toFixed(0)} %)`
        : '';
      lines.push(`  - ${d.label}: ${d.localCount} lokal${rd}`);
    }
  }

  lines.push('');
  lines.push('=== TREND ===');
  if (trend.direction && trend.direction !== 'unknown') {
    lines.push(`Richtung über ${trend.rangeYears} Jahre (${trend.firstYear}–${trend.lastYear}): ${trend.direction} (rel. Änderung ${(trend.relativeChange * 100).toFixed(0)} %)`);
  } else {
    lines.push(`Trend nicht eindeutig bestimmbar (Datenpunkte: ${trend.rangeYears || 0}).`);
  }

  // Stufe-1-Anreicherung: kompakte Klassifikation aus js/ua.trend.js, falls
  // mitgeliefert. Liefert eine zweite, an strikten Schwellen orientierte
  // Lesart (steigend/rückläufig/stagnierend/unbestimmt) – ergänzt die obige
  // Erst-Letzte-Schätzung um die Regressions-Sicht. classifyTrend() liefert
  // bei zu wenigen Jahren oder unklarer Statistik 'unbestimmt' – diese
  // Variante blenden wir aus, weil sie keinen Mehrwert für die KI hat.
  const yt = f.yearlyTrend;
  if (yt && yt.classification && yt.classification !== 'unbestimmt') {
    const slope = Number.isFinite(yt.slope) ? yt.slope.toFixed(2) : '–';
    const r2    = Number.isFinite(yt.rSquared) ? yt.rSquared.toFixed(2) : '–';
    lines.push(`Klassifikation (lineare Regression): ${yt.classification} (Steigung ${slope}/Jahr, R²=${r2}, n=${yt.nYears})`);
  }

  lines.push('');
  lines.push('=== RÄUMLICHE VERDICHTUNG ===');
  if (sp.hint && sp.hint !== 'insufficient_data' && sp.hint !== 'insufficient_coords') {
    lines.push(`Hinweis: ${sp.hint} (Spannweite ca. ${sp.spanMeters} m, Stichprobe ${sp.sampleSize}/${sp.totalAccidents}).`);
  } else {
    lines.push('(zu wenig Einzelpunkte für eine räumliche Aussage)');
  }

  // Stufe-1-Anreicherung: OSM-Kontext aus js/ua.osm_context.js, falls
  // mitgeliefert. Wir spielen *nur* die Aggregation aus, niemals einen
  // Fehler-Stub – die KI soll keine "OSM nicht verfügbar"-Hinweise
  // formulieren, das übernimmt der deterministische Renderer.
  const osm = f.osmContext;
  if (osm && osm.summary) {
    lines.push('');
    lines.push('=== OSM-KONTEXT ===');
    const s = osm.summary;
    if (s.dominantMaxspeed != null) {
      lines.push(`Vorherrschendes Tempolimit: ${s.dominantMaxspeed} km/h (n=${s.speedSampleSize} Wegabschnitte)`);
    }
    if (s.cycleInfraWays > 0) {
      const sh = (s.cycleInfraShare != null) ? ` (${Math.round(s.cycleInfraShare * 100)} % der klassifizierten Hauptachsen)` : '';
      lines.push(`Radinfrastruktur an ${s.cycleInfraWays} Wegabschnitten${sh}`);
    } else if (s.wayCount > 0) {
      lines.push('Keine separaten Radverkehrsanlagen erkannt.');
    }
    if (s.trafficSignals > 0) lines.push(`Signalisierte Knoten: ${s.trafficSignals}`);
    if (s.crossings > 0)      lines.push(`Markierte Querungen: ${s.crossings}`);
    if (s.avgLanes != null)   lines.push(`Ø Fahrstreifen: ${s.avgLanes.toFixed(1)} (n=${s.lanesSampleSize})`);
    if (s.avgWidthMeters != null) lines.push(`Ø Fahrbahnbreite: ${s.avgWidthMeters.toFixed(1)} m (n=${s.widthSampleSize})`);
  }

  if (poi) {
    lines.push('');
    lines.push('=== POI-UMGEBUNG ===');
    lines.push(`POIs im Bereich (insgesamt ${poi.totalWithin}): ${listPoi(poi.within) || '—'}`);
    lines.push(`POIs in Nähe   (insgesamt ${poi.totalNear}):    ${listPoi(poi.near)   || '—'}`);
  }

  if (Array.isArray(f.tags) && f.tags.length) {
    lines.push('');
    lines.push(`=== ABGELEITETE MERKMALSTAGS ===`);
    lines.push(f.tags.join(', '));
  }

  if (Array.isArray(f.conflictPatterns) && f.conflictPatterns.length) {
    lines.push('');
    lines.push('=== ERKANNTE KONFLIKTMUSTER (deterministisch) ===');
    for (const p of f.conflictPatterns) {
      lines.push(`  - id="${p.id}" | ${p.classification} | confidence=${p.confidence}`);
      lines.push(`    Label: ${p.label}`);
      lines.push(`    Begründung: ${p.rationale}`);
      if (Array.isArray(p.evidence) && p.evidence.length) lines.push(`    Evidenz: ${p.evidence.join('; ')}`);
      if (Array.isArray(p.requiresOnSiteCheck) && p.requiresOnSiteCheck.length) {
        lines.push(`    Vor-Ort-Prüfung: ${p.requiresOnSiteCheck.join('; ')}`);
      }
    }
  }

  if (refs.length) {
    lines.push('');
    lines.push('=== REFERENZDOKUMENTE ===');
    for (const r of refs) {
      lines.push(`  - ${r.title}${r.type ? ` [${r.type}]` : ''}${r.url ? ` (${r.url})` : ''}`);
    }
  }

  const hasHints = (hints.knownHazards?.length || hints.locationHints?.length || hints.surfaceHints?.length || hints.notes?.length);
  if (hasHints) {
    lines.push('');
    lines.push('=== KONTEXT-HINWEISE (manuell, mit Vorsicht behandeln) ===');
    if (hints.knownHazards?.length)  lines.push(`Bekannte Gefahrenstellen: ${hints.knownHazards.join('; ')}`);
    if (hints.locationHints?.length) lines.push(`Ortshinweise: ${hints.locationHints.join('; ')}`);
    if (hints.surfaceHints?.length)  lines.push(`Belagshinweise: ${hints.surfaceHints.join('; ')}`);
    if (hints.notes?.length)         lines.push(`Anmerkungen: ${hints.notes.join('; ')}`);
  }

  lines.push('');
  lines.push('=== MASSNAHMEN-VORAUSWAHL (aus interner Bibliothek) ===');
  if (pre.length === 0) {
    lines.push('(keine spezifische Vorauswahl – wähle generische, gut belegte Maßnahmen)');
  } else {
    for (const p of pre) {
      lines.push(`  - id="${p.id}" | Kategorie: ${p.category} | Aufwand: ${p.implementationEffort} | Kosten: ${p.costBand}`);
      lines.push(`    Titel: ${p.title}`);
      lines.push(`    Beschreibung: ${p.description}`);
      if (p.targetAccidentTypes?.length) lines.push(`    Zielmuster: ${p.targetAccidentTypes.join(', ')}`);
      if (p.matchedRiskFactors?.length)        lines.push(`    matchedRiskFactors: ${p.matchedRiskFactors.join(', ')}`);
      if (p.matchedConflictPatterns?.length)   lines.push(`    matchedConflictPatterns: ${p.matchedConflictPatterns.join(', ')}`);
      if (p.reasonForPreselection)             lines.push(`    reasonForPreselection: ${p.reasonForPreselection}`);
      if (p.implementationDuration)            lines.push(`    Dauer: ${p.implementationDuration}`);
      if (p.measureClass)                      lines.push(`    Klasse: ${p.measureClass}`);
      if (p.useCases?.length)                  lines.push(`    Einsatzfälle: ${p.useCases.join(' | ')}`);
      if (p.cautions?.length)                  lines.push(`    Vorsicht: ${p.cautions.join(' | ')}`);
    }
  }

  lines.push('');
  if (mode === 'proposal-brief') {
    lines.push('AUFGABE: Erzeuge einen antragsfähigen Maßnahmensteckbrief gemäß Schema "proposalBrief.v1".');
  } else {
    lines.push('AUFGABE: Erzeuge die fachliche Bewertung gemäß Schema "exportAssessment.v2".');
  }
  lines.push('Antworte ausschließlich als JSON-Objekt – kein Markdown, kein Vor- oder Nachtext.');

  return {
    system: mode === 'proposal-brief' ? SYSTEM_PROMPT_PROPOSAL : SYSTEM_PROMPT_ASSESSMENT,
    user:   lines.join('\n')
  };
}

function pct(x) {
  if (!Number.isFinite(x)) return '–';
  return `${(x * 100).toFixed(0)} %`;
}
function listPoi(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.map(p => `${p.type}=${p.count}`).join(', ');
}

module.exports = {
  PROMPT_VERSION,
  SYSTEM_PROMPT_ASSESSMENT,
  SYSTEM_PROMPT_PROPOSAL,
  buildPrompt
};
