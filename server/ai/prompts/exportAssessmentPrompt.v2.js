'use strict';

/**
 * Prompt-Builder v2 für die KI-Bewertung – unterstützt zwei Modi:
 *   - "assessment"     : fachliche Bewertung + Maßnahmen (exportAssessment.v2)
 *   - "proposal-brief" : antragsfähiger Steckbrief        (proposalBrief.v1)
 *
 * Erhält bereits aufbereitete Merkmale (`features`) und vorselektierte
 * Maßnahmen (`preselected`) statt Rohdaten. Die KI muss den amtlichen
 * Tatsachenkern bewahren, einfache Konsistenzprüfungen vornehmen und
 * Maßnahmen sichtbar aus belegten Befunden ableiten.
 *
 * @module server/ai/prompts/exportAssessmentPrompt.v2
 */

/** Versionskennung – Teil des Cache-Keys. */
const PROMPT_VERSION = 'exportAssessmentPrompt.v2.5';

const OFFICIAL_UNFALLATLAS_URL = 'https://www.statistikportal.de/de/karten/unfallatlas';
const OFFICIAL_DESTATIS_URL = 'https://www.destatis.de/DE/Service/Statistik-Visualisiert/unfall-atlas.html';

const SYSTEM_PROMPT_ASSESSMENT = `Du bist Verkehrssicherheitsexpertin für deutsche Kommunen.
Du erhältst aufbereitete Unfallatlas-Daten und musst eine fachliche Bewertung erstellen.

Evidenzstatus der Primärdaten:
- Die Unfallatlas-Daten stammen aus der amtlichen Statistik der Straßenverkehrsunfälle auf Grundlage von Meldungen der Polizeidienststellen.
- Veröffentlicht werden Unfälle mit Personenschaden; reine Sachschadensunfälle sind nicht enthalten.
- Dokumentiertes Ereignis, veröffentlichter Ort, Zeitraum, Unfallschwere und kodierte Beteiligungsarten sind – soweit im Input vorhanden – amtliche Tatsachen mit hohem Evidenzwert.
- Unsicherheit über die genaue Ursache entwertet diese Tatsachen nicht. Vorsicht gilt für Kausalität, Kontextdeutung und Wirkungsprognose, nicht für die Wiedergabe dokumentierter Ereignisse.

Strenge Regeln:
1. Trenne sauber zwischen
     - "evidence" (amtliche Unfalltatsachen und deterministisch berechnete Kennzahlen),
     - "primaryRiskFactors" (plausibel, gestützt von Evidenz),
     - "secondaryRiskFactors" (Hypothese, zu prüfen).
2. Formuliere amtliche Zahlen bestimmt, konkret und mit Raum-/Zeitbezug. Verwandle sie nicht allein wegen kleiner Fallzahlen in bloße „mögliche Hinweise". "confidence" bewertet Interpretation und Maßnahmenpassung, nicht die Existenz eines amtlich dokumentierten Ereignisses.
3. Prüfe vor der Bewertung die innere Plausibilität des Inputs: Gesamtzahl gegen Schweregradsumme, Stichprobengrößen, Zeitraum und weitere mitgelieferte Summen. Widersprüche gehören in "dataGaps"/"uncertainty" und verhindern eine scheinbar sichere Schlussfolgerung.
4. Halluziniere KEINE Ortsdetails (Straßennamen, Gebäude, Schulen), die nicht im Input vorkommen.
5. Wähle Maßnahmen primär aus der bereitgestellten Maßnahmen-Vorauswahl ("preselectedMeasures"). Verwende, wo möglich, deren id und Titel unverändert. Du darfst sortieren, kürzen und begründen, aber keine völlig neuen Maßnahmen erfinden, wenn passende vorhanden sind.
6. Begründe jede empfohlene Maßnahme als Kette: belegter Befund → Sicherheitsziel → Maßnahme/Prüfoption → noch nötige Fachprüfung → Erfolgskriterium. Eine nicht belegte Alleinursache ist dafür nicht erforderlich.
7. Bei < 10 Unfällen ist "confidence.overall" für Interpretation/Maßnahmen nie "high"; die amtliche Qualität der einzelnen dokumentierten Ereignisse bleibt davon unberührt.
8. "dataGaps" listet, was die Bewertung verbessern würde. Ergänzend dazu fülle, sofern relevant, "uncertainty" mit "missingData", "weakDataBasis", "plausibleNotEvidenced", "requiresOnSiteCheck", "alternativeExplanations".
9. Trenne Herkunft per "provenance":
     - "derivedFromDeterministicFeatures": amtliche Tatsachen und 1:1 aus Kennzahlen/Features übernommene Aussagen,
     - "inferredByModel": Verdichtung und Interpretation,
     - "uncertainOrNeedsVerification": Vor-Ort-/Fachprüfung.
10. Nutze "detectedConflictPatterns" nur auf Grundlage der mitgelieferten Muster und ihrer Evidenz.
11. Antragstaugliche Felder sollen konkrete Unfallzahl, Schwere, Bereich und Zeitraum enthalten, soweit vorhanden, und direkt als Rohmaterial für Antrag/Prüfauftrag/Notiz nutzbar sein.
12. Visuelle Hinweise aus Orthofoto/Luftbild sind als Beobachtungen zu formulieren ("sichtbarer Hinweis", "möglicherweise relevant", "prüfbedürftig"), nicht als belegte Unfallursachen.
13. Antworte ausschließlich als JSON gemäß dem vorgegebenen Schema (kein Markdown, kein Fließtext drumherum).`;

const SYSTEM_PROMPT_PROPOSAL = `Du bist Referentin für Verkehrspolitik in einer deutschen Kommune.
Du formulierst aus aufbereiteten Unfallatlas-Daten einen antragsfähigen Maßnahmensteckbrief.

Evidenzstatus der Primärdaten:
- Die Unfallatlas-Daten stammen aus der amtlichen Statistik der Straßenverkehrsunfälle auf Grundlage von Meldungen der Polizeidienststellen.
- Veröffentlicht werden Unfälle mit Personenschaden; reine Sachschadensunfälle sind nicht enthalten.
- Dokumentiertes Ereignis, veröffentlichter Ort, Zeitraum, Unfallschwere und kodierte Beteiligungsarten sind – soweit im Input vorhanden – amtliche Tatsachen mit hohem Evidenzwert.
- Unsicherheit über die genaue Ursache entwertet den amtlich dokumentierten Tatsachenkern nicht.

Strenge Regeln:
1. Verwende ausschließlich die im Input genannten Fakten (keine erfundenen Straßennamen, keine fiktiven Vorfälle).
2. Gib amtliche Unfallzahlen bestimmt und konkret wieder. Formulierungen wie „möglicherweise gab es" oder „die Daten könnten andeuten", obwohl eine Zahl im Input steht, sind unzulässig. Vorsicht gilt für Ursachenhypothesen und Wirkungsprognosen.
3. Prüfe vor dem Schreiben die innere Plausibilität der Kennzahlen. Bei Widersprüchen: benenne sie in "caveats"/"uncertainty", formuliere einen konkreten Prüfauftrag und vermeide einen scheinbar abschließenden Maßnahmenbeschluss.
4. "sachverhalt" und "longVersion" müssen – soweit vorhanden – Unfallzahl, Schweregrade, Untersuchungsraum und Zeitraum nennen. Allgemeine Verkehrssicherheitsfloskeln ersetzen diesen Tatsachenkern nicht.
5. Maßnahmen kommen primär aus der "preselectedMeasures"-Vorauswahl. Priorisiere nur Maßnahmen, deren Passung du auf einen belegten Befund oder einen ausdrücklich gekennzeichneten Prüfbedarf zurückführen kannst.
6. Begründe jede Maßnahme als Kette: belegter Befund → Sicherheitsziel → Option → Fach-/Ortsprüfung → Erfolgskriterium. Ein dokumentiertes Unfallgeschehen kann einen Prüf-, Sicherungs-, Pilot- oder Abhilfeauftrag tragen, ohne dass eine exakte Alleinursache bereits bewiesen ist.
7. Trenne klar:
     - "shortVersion": kompakte Bürger-/Gremiumsfassung,
     - "longVersion": ausführliche Antragsbegründung mit Datenbezug,
     - "sachverhalt", "begruendung", "beschlussvorschlag", "pruefauftrag": einzelne Antragsbausteine.
8. Gib in "caveats" nur echte Datenlücken oder Unsicherheiten an. Relativiere dort nicht pauschal die amtlich dokumentierten Unfallereignisse.
9. Trenne Herkunft per "provenance" (amtliche/deterministische Fakten, Modellformulierung, unsichere bzw. zu prüfende Aussagen).
10. Antragstaugliche Zusatzfelder müssen konkret, ortsbezogen und überprüfbar sein; nenne Prüfgegenstand, Berichtspflicht bzw. Erfolgskontrolle soweit das Schema dies erlaubt.
11. Ton: sachlich, kommunal-üblich, frei von Polemik.
12. Visuelle Hinweise aus Orthofoto/Luftbild sind als Kontextbeobachtung zu kennzeichnen (keine kausalen Formulierungen wie "verursacht durch").
13. Antworte ausschließlich als JSON gemäß dem vorgegebenen Schema.`;

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
  const visualHints = f.visualContextHints || null;

  const lines = [];
  lines.push('=== KONTEXT ===');
  lines.push(`Stadt: ${m.city || '(unbekannt)'}`);
  lines.push(`Bereich: ${m.areaName || '(unbekannt)'}`);
  if (m.gremium && m.gremium.name) {
    lines.push(`Gremium: ${m.gremium.name} (${m.gremium.type || ''})`);
  }
  lines.push(`Datum des Exports: ${m.date || '(unbekannt)'}`);
  if (m.link) lines.push(`Reproduzierbarer Analyse-Link: ${m.link}`);

  lines.push('');
  lines.push('=== DATENSTATUS UND EVIDENZREGEL ===');
  lines.push('Primärbasis: amtliche Statistik der Straßenverkehrsunfälle auf Grundlage von Meldungen der Polizeidienststellen.');
  lines.push('Geltungsbereich: veröffentlichte Unfälle mit Personenschaden; reine Sachschadensunfälle sind nicht enthalten.');
  lines.push(`Amtliche Quellenbeschreibung: ${OFFICIAL_UNFALLATLAS_URL}`);
  lines.push(`Abgrenzung des dargestellten Umfangs: ${OFFICIAL_DESTATIS_URL}`);
  lines.push('Verbindliche Einordnung: dokumentierte Ereignisse und mitgelieferte Unfallattribute bestimmt wiedergeben; Unsicherheit über Ursachen nicht mit Unsicherheit über das Ereignis verwechseln.');

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
    // js/ua.trend.js liefert das Bestimmtheitsmaß als `r2`; ältere Varianten
    // hießen `rSquared`. Für Robustheit beide Felder akzeptieren.
    const r2Value = Number.isFinite(yt.r2) ? yt.r2 : yt.rSquared;
    const r2    = Number.isFinite(r2Value) ? r2Value.toFixed(2) : '–';
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

  // Orts- und musterbezogene Empfehlungen aus UA.contextMeasures (Spec
  // Items 4–8). Wir geben der KI die deterministisch ermittelten
  // Prüfaufträge + Maßnahmenoptionen mit, damit sie keine zum Ortskontext
  // unpassenden Standardmaßnahmen vorschlägt (Beispiel aus Spec: NICHT
  // „Bewuchs zurückschneiden" am Hauptbahnhof). Der Block ist optional;
  // wenn die feature-Pipeline ihn nicht liefert, wird er stumm übersprungen.
  const ctxMeasures = f.contextualMeasures;
  if (ctxMeasures && Array.isArray(ctxMeasures.matchedRules) && ctxMeasures.matchedRules.length > 0) {
    lines.push('');
    lines.push('=== ORTS- & MUSTERBEZOGENE EMPFEHLUNGEN (deterministisch) ===');
    lines.push('Diese Vorschläge stammen aus einer regelbasierten (Pattern × Ortskontext)-Matrix und sind als');
    lines.push('Hilfestellung gedacht. Übernimm passende Punkte direkt in deine Maßnahmen-/Prüfauftragsfelder.');
    lines.push('Vermeide ausdrücklich Standardmaßnahmen, die hier NICHT enthalten sind, wenn der Ortskontext');
    lines.push('sie unplausibel macht (z. B. „Bewuchs zurückschneiden" am Hauptbahnhof oder im Schienenbereich).');
    if (ctxMeasures.rationale) {
      lines.push('');
      lines.push(`Hinweis: ${ctxMeasures.rationale}`);
    }
    if (Array.isArray(ctxMeasures.contexts) && ctxMeasures.contexts.length) {
      lines.push(`Erkannte Kontexte: ${ctxMeasures.contexts.join(', ')}`);
    }
    if (Array.isArray(ctxMeasures.patterns) && ctxMeasures.patterns.length) {
      lines.push(`Erkannte Muster:   ${ctxMeasures.patterns.join(', ')}`);
    }
    const renderBucket = (heading, items) => {
      if (!Array.isArray(items) || items.length === 0) return;
      lines.push('');
      lines.push(`${heading}:`);
      for (const it of items) lines.push(`  - ${it}`);
    };
    renderBucket('Erforderliche Vor-Ort-Prüfung',     ctxMeasures.pruefauftraege);
    renderBucket('Kurzfristig prüfbar',               ctxMeasures.kurzfristig);
    renderBucket('Baulich/organisatorisch zu prüfen', ctxMeasures.mittelfristig);
  }

  if (poi) {
    lines.push('');
    lines.push('=== POI-UMGEBUNG ===');
    lines.push(`POIs im Bereich (insgesamt ${poi.totalWithin}): ${listPoi(poi.within) || '—'}`);
    lines.push(`POIs in Nähe   (insgesamt ${poi.totalNear}):    ${listPoi(poi.near)   || '—'}`);
  }

  if (Array.isArray(f.tags) && f.tags.length) {
    lines.push('');
    lines.push('=== ABGELEITETE MERKMALSTAGS ===');
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

  if (visualHints && visualHints.sourceType === 'visual_context') {
    const src = visualHints.source || {};
    lines.push('');
    lines.push('=== VISUELLE HINWEISE (ORTHOFOTO/LUFTBILD) ===');
    const sourceBits = [src.layerName, src.provider].filter(Boolean);
    if (sourceBits.length) {
      lines.push(`Provenienz: ${sourceBits.join(' / ')}`);
    }
    if (src.mapModeLabel || src.mapMode) {
      lines.push(`Kartenmodus: ${src.mapModeLabel || src.mapMode}`);
    }
    if (Array.isArray(visualHints.hints) && visualHints.hints.length) {
      lines.push(`Sichtbare Hinweise: ${visualHints.hints.join('; ')}`);
    }
    if (visualHints.recommendation) {
      lines.push(`Prüfempfehlung: ${visualHints.recommendation}`);
    }
    lines.push('Einordnung: visuelle Kontextbeobachtung, keine amtlich belegte Unfallursache.');
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
  lines.push('=== QUALITÄTSAUFTRAG VOR TEXTGENERATION ===');
  lines.push('1. Prüfe, ob Gesamtzahl und Summe aus Getöteten/Schwerverletzten/Leichtverletzten plausibel zusammenpassen.');
  lines.push('2. Behandle die genannten Unfälle als amtlich dokumentierte Tatsachen; relativiere nur Ursachen- und Wirkungsannahmen.');
  lines.push('3. Verknüpfe jede Maßnahme mit mindestens einem konkreten Befund und einem prüfbaren Sicherheitsziel.');
  lines.push('4. Benenne Datenlücken spezifisch. Eine kleine Fallzahl ist kein Grund, dokumentierte Unfälle sprachlich verschwinden zu lassen.');
  if (mode === 'proposal-brief') {
    lines.push('5. Beginne Sachverhalt und Langfassung mit konkreter Unfallzahl, Schwere, Untersuchungsraum und Zeitraum, soweit im Input vorhanden.');
    lines.push('6. Formuliere Beschlussvorschlag und Prüfauftrag konkret; keine bloße sprachliche Verschönerung der Kennzahlen.');
  }

  lines.push('');
  if (mode === 'proposal-brief') {
    lines.push('AUFGABE: Erzeuge einen evidenzbasierten, antragsfähigen Maßnahmensteckbrief gemäß Schema "proposalBrief.v1".');
  } else {
    lines.push('AUFGABE: Erzeuge die evidenzbasierte fachliche Bewertung gemäß Schema "exportAssessment.v2".');
  }
  lines.push('Antworte ausschließlich als JSON-Objekt – kein Markdown, kein Vor- oder Nachtext.');

  return {
    system: mode === 'proposal-brief' ? SYSTEM_PROMPT_PROPOSAL : SYSTEM_PROMPT_ASSESSMENT,
    user: lines.join('\n')
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
  OFFICIAL_UNFALLATLAS_URL,
  OFFICIAL_DESTATIS_URL,
  SYSTEM_PROMPT_ASSESSMENT,
  SYSTEM_PROMPT_PROPOSAL,
  buildPrompt
};
