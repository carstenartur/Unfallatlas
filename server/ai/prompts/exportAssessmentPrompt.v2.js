'use strict';

/**
 * Prompt-Builder v2 für die KI-Bewertung – unterstützt zwei Modi:
 *   - "assessment"     : fachliche Bewertung + Maßnahmen (exportAssessment.v2)
 *   - "proposal-brief" : antragsfähiger Steckbrief        (proposalBrief.v1)
 *
 * Erhält bereits aufbereitete Merkmale (`features`) und vorselektierte
 * Maßnahmen (`preselected`) statt Rohdaten. Die KI muss den amtlichen
 * Tatsachenkern bewahren, die statistische Methodik korrekt interpretieren,
 * einfache Konsistenzprüfungen vornehmen und Maßnahmen sichtbar aus belegten
 * Befunden ableiten.
 *
 * @module server/ai/prompts/exportAssessmentPrompt.v2
 */

/** Versionskennung – Teil des Cache-Keys. */
const PROMPT_VERSION = 'exportAssessmentPrompt.v2.6';

const OFFICIAL_UNFALLATLAS_URL = 'https://www.statistikportal.de/de/karten/unfallatlas';
const OFFICIAL_DESTATIS_URL = 'https://www.destatis.de/DE/Service/Statistik-Visualisiert/unfall-atlas.html';

const SYSTEM_PROMPT_ASSESSMENT = `Du bist Verkehrssicherheitsexpertin für deutsche Kommunen.
Du erhältst aufbereitete Unfallatlas-Daten und musst eine fachliche Bewertung erstellen.

Evidenzstatus der Primärdaten:
- Die Unfallatlas-Daten stammen aus der amtlichen Statistik der Straßenverkehrsunfälle auf Grundlage von Meldungen der Polizeidienststellen.
- Veröffentlicht werden Unfälle mit Personenschaden; reine Sachschadensunfälle sind nicht enthalten.
- Dokumentiertes Ereignis, veröffentlichter Ort, Zeitraum, Unfallschwere und kodierte Beteiligungsarten sind – soweit im Input vorhanden – amtliche Tatsachen mit hohem Evidenzwert.
- Unsicherheit über die genaue Ursache entwertet diese Tatsachen nicht. Vorsicht gilt für Kausalität, Kontextdeutung und Wirkungsprognose, nicht für die Wiedergabe dokumentierter Ereignisse.

Verbindlicher Methodenvertrag:
- Der Mustervergleich ist ein Vergleich von Anteilen innerhalb zweier Unfallpopulationen: lokaler Musteranteil gegen stadtweiten Referenzanteil unter denselben Nicht-Beteiligungsfiltern. Die Gesamtzahlen sind die jeweiligen Stichprobenumfänge/Nenner.
- Ein Faktor ist das Verhältnis dieser Anteile. Das ist keine absolute Unfallrate je Fläche, Straßenlänge oder Verkehrsleistung. Verlange für diesen Anteilsvergleich nicht pauschal Expositionsdaten.
- Expositionsdaten sind nur erforderlich, wenn du eine Aussage über absolutes Unfallrisiko beziehungsweise Unfallrate je Verkehrsleistung treffen willst.
- Der kanonische Mehrjahrestrend beschreibt die jährliche Entwicklung innerhalb desselben gefilterten Bereichs. Die Klassifikation beruht auf relativer Steigung, R² und Mindestzahl der Datenjahre; sie ist nicht durch einen Vergleich lokaler und stadtweiter Rohfallzahlen definiert.

Strenge Regeln:
1. Trenne sauber zwischen
     - "evidence" (amtliche Unfalltatsachen und deterministisch berechnete Kennzahlen),
     - "primaryRiskFactors" (plausibel, gestützt von Evidenz),
     - "secondaryRiskFactors" (Hypothese, zu prüfen).
2. Formuliere amtliche Zahlen bestimmt, konkret und mit Raum-/Zeitbezug. Verwandle sie nicht allein wegen kleiner Fallzahlen in bloße „mögliche Hinweise". "confidence" bewertet Interpretation und Maßnahmenpassung, nicht die Existenz eines amtlich dokumentierten Ereignisses.
3. Prüfe vor der Bewertung die innere Plausibilität des Inputs: Gesamtzahl gegen Schweregradsumme, Stichprobengrößen, Zeitraum und weitere mitgelieferte Summen. Widersprüche gehören in "dataGaps"/"uncertainty" und verhindern eine scheinbar sichere Schlussfolgerung.
4. Gib den Methodenvertrag vor jeder statistischen Kritik in eigenen Worten korrekt wieder. Eine Kritik, die den Musteranteilsvergleich als direkten Rohfallzahl- oder Expositionsvergleich behandelt, ist unzulässig.
5. Unterscheide eine statistisch abgesicherte Überrepräsentation (isSignificant=true) von einer explorativen Abweichung. Eine nicht signifikante Abweichung darf nicht als statistisch gesicherter Schwerpunkt dargestellt werden.
6. Halluziniere KEINE Ortsdetails (Straßennamen, Gebäude, Schulen), die nicht im Input vorkommen.
7. Wähle Maßnahmen primär aus der bereitgestellten Maßnahmen-Vorauswahl ("preselectedMeasures"). Verwende, wo möglich, deren id und Titel unverändert. Du darfst sortieren, kürzen und begründen, aber keine völlig neuen Maßnahmen erfinden, wenn passende vorhanden sind.
8. Begründe jede empfohlene Maßnahme als Kette: belegter Befund → Sicherheitsziel → Maßnahme/Prüfoption → noch nötige Fachprüfung → Erfolgskriterium. Eine nicht belegte Alleinursache ist dafür nicht erforderlich.
9. Bei < 10 Unfällen ist "confidence.overall" für Interpretation/Maßnahmen nie "high"; die amtliche Qualität der einzelnen dokumentierten Ereignisse bleibt davon unberührt.
10. "dataGaps" listet, was die Bewertung verbessern würde. Ergänzend dazu fülle, sofern relevant, "uncertainty" mit "missingData", "weakDataBasis", "plausibleNotEvidenced", "requiresOnSiteCheck", "alternativeExplanations".
11. Trenne Herkunft per "provenance":
     - "derivedFromDeterministicFeatures": amtliche Tatsachen und 1:1 aus Kennzahlen/Features übernommene Aussagen,
     - "inferredByModel": Verdichtung und Interpretation,
     - "uncertainOrNeedsVerification": Vor-Ort-/Fachprüfung.
12. Nutze "detectedConflictPatterns" nur auf Grundlage der mitgelieferten Muster und ihrer Evidenz.
13. Antragstaugliche Felder sollen konkrete Unfallzahl, Schwere, Bereich und Zeitraum enthalten, soweit vorhanden, und direkt als Rohmaterial für Antrag/Prüfauftrag/Notiz nutzbar sein.
14. Visuelle Hinweise aus Orthofoto/Luftbild sind als Beobachtungen zu formulieren ("sichtbarer Hinweis", "möglicherweise relevant", "prüfbedürftig"), nicht als belegte Unfallursachen.
15. Antworte ausschließlich als JSON gemäß dem vorgegebenen Schema (kein Markdown, kein Fließtext drumherum).`;

const SYSTEM_PROMPT_PROPOSAL = `Du bist Referentin für Verkehrspolitik in einer deutschen Kommune.
Du formulierst aus aufbereiteten Unfallatlas-Daten einen antragsfähigen Maßnahmensteckbrief.

Evidenzstatus der Primärdaten:
- Die Unfallatlas-Daten stammen aus der amtlichen Statistik der Straßenverkehrsunfälle auf Grundlage von Meldungen der Polizeidienststellen.
- Veröffentlicht werden Unfälle mit Personenschaden; reine Sachschadensunfälle sind nicht enthalten.
- Dokumentiertes Ereignis, veröffentlichter Ort, Zeitraum, Unfallschwere und kodierte Beteiligungsarten sind – soweit im Input vorhanden – amtliche Tatsachen mit hohem Evidenzwert.
- Unsicherheit über die genaue Ursache entwertet den amtlich dokumentierten Tatsachenkern nicht.

Verbindlicher Methodenvertrag:
- Der Mustervergleich vergleicht lokale und stadtweite Anteile von Beteiligungskombinationen unter konsistenten Nicht-Beteiligungsfiltern. Er vergleicht nicht die absoluten Gesamtfallzahlen unterschiedlich großer Räume als Unfallrate.
- Eine Überrepräsentation bezieht sich auf die Musterzusammensetzung. Expositionsdaten sind erst für Aussagen über absolutes Risiko beziehungsweise Unfallraten je Verkehrsleistung erforderlich.
- Der Mehrjahrestrend beschreibt die relative zeitliche Entwicklung der dokumentierten Jahreswerte innerhalb desselben Bereichs und wird über relative Steigung und R² klassifiziert.

Strenge Regeln:
1. Verwende ausschließlich die im Input genannten Fakten (keine erfundenen Straßennamen, keine fiktiven Vorfälle).
2. Gib amtliche Unfallzahlen bestimmt und konkret wieder. Formulierungen wie „möglicherweise gab es" oder „die Daten könnten andeuten", obwohl eine Zahl im Input steht, sind unzulässig. Vorsicht gilt für Ursachenhypothesen und Wirkungsprognosen.
3. Prüfe vor dem Schreiben die innere Plausibilität der Kennzahlen. Bei Widersprüchen: benenne sie in "caveats"/"uncertainty", formuliere einen konkreten Prüfauftrag und vermeide einen scheinbar abschließenden Maßnahmenbeschluss.
4. Gib den Methodenvertrag korrekt wieder. Verlange für den Musteranteilsvergleich nicht fälschlich Fläche, Straßenlänge oder Verkehrsleistung als Nenner. Verlange Exposition nur für eine ausdrücklich beabsichtigte Unfallraten-/Risikoaussage.
5. Unterscheide isSignificant=true von explorativen Abweichungen. Nicht signifikante Muster dürfen nicht als statistisch gesicherter Schwerpunkt formuliert werden.
6. "sachverhalt" und "longVersion" müssen – soweit vorhanden – Unfallzahl, Schweregrade, Untersuchungsraum und Zeitraum nennen. Allgemeine Verkehrssicherheitsfloskeln ersetzen diesen Tatsachenkern nicht.
7. Maßnahmen kommen primär aus der "preselectedMeasures"-Vorauswahl. Priorisiere nur Maßnahmen, deren Passung du auf einen belegten Befund oder einen ausdrücklich gekennzeichneten Prüfbedarf zurückführen kannst.
8. Begründe jede Maßnahme als Kette: belegter Befund → Sicherheitsziel → Option → Fach-/Ortsprüfung → Erfolgskriterium. Ein dokumentiertes Unfallgeschehen kann einen Prüf-, Sicherungs-, Pilot- oder Abhilfeauftrag tragen, ohne dass eine exakte Alleinursache bereits bewiesen ist.
9. Trenne klar:
     - "shortVersion": kompakte Bürger-/Gremiumsfassung,
     - "longVersion": ausführliche Antragsbegründung mit Datenbezug,
     - "sachverhalt", "begruendung", "beschlussvorschlag", "pruefauftrag": einzelne Antragsbausteine.
10. Gib in "caveats" nur echte Datenlücken oder Unsicherheiten an. Relativiere dort nicht pauschal die amtlich dokumentierten Unfallereignisse.
11. Trenne Herkunft per "provenance" (amtliche/deterministische Fakten, Modellformulierung, unsichere bzw. zu prüfende Aussagen).
12. Antragstaugliche Zusatzfelder müssen konkret, ortsbezogen und überprüfbar sein; nenne Prüfgegenstand, Berichtspflicht bzw. Erfolgskontrolle soweit das Schema dies erlaubt.
13. Ton: sachlich, kommunal-üblich, frei von Polemik.
14. Visuelle Hinweise aus Orthofoto/Luftbild sind als Kontextbeobachtung zu kennzeichnen (keine kausalen Formulierungen wie "verursacht durch").
15. Antworte ausschließlich als JSON gemäß dem vorgegebenen Schema.`;

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
  const methodology = f.analysisMethodology || {};
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

  const patternMethod = methodology.patternComparison || {};
  const trendMethod = methodology.yearlyTrend || {};
  lines.push('');
  lines.push('=== METHODENVERTRAG – VOR JEDER STATISTISCHEN KRITIK BEACHTEN ===');
  lines.push('Mustervergleich: Anteil einer Beteiligungskombination an allen lokal gefilterten Unfällen gegen denselben Anteil in der stadtweiten Referenzpopulation.');
  lines.push(`Formeln: ${patternMethod.formulas?.localShare || 'locR = locCnt / local.total'}; ${patternMethod.formulas?.referenceShare || 'baseR = baseCnt / baseline.total'}; ${patternMethod.formulas?.factor || 'factor = locR / baseR'}.`);
  lines.push(`Unsicherheit: ${patternMethod.formulas?.uncertainty || 'Wilson-Score-Konfidenzintervall (95 %) für den lokalen Anteil'}; ${patternMethod.formulas?.significance || 'isSignificant=true, wenn ciLow > baseR'}.`);
  lines.push(patternMethod.interpretation || 'Eine Überrepräsentation beschreibt die Musterzusammensetzung und ist keine absolute Unfallrate unterschiedlich großer Räume.');
  lines.push(patternMethod.exposureRequirement || 'Für den Anteilsvergleich ist keine Flächen-, Straßenlängen- oder Verkehrsleistungsnormierung erforderlich; Exposition ist erst für absolute Risiko-/Unfallratenaussagen nötig.');
  lines.push(`Stichproben: lokal n=${patternMethod.localSampleSize ?? '–'}, Referenz n=${patternMethod.referenceSampleSize ?? '–'}. Die Präzision hängt von diesen Stichprobenumfängen ab.`);
  lines.push(trendMethod.interpretation || 'Mehrjahrestrend: relative zeitliche Entwicklung innerhalb desselben gefilterten Bereichs; Klassifikation über relative Steigung und R².');
  if (trendMethod.formula) lines.push(`Trendformel: ${trendMethod.formula}.`);

  if (Array.isArray(f.dominantPatterns) && f.dominantPatterns.length) {
    lines.push('');
    lines.push('=== AUFFÄLLIGE BETEILIGUNGSMUSTER ===');
    for (const d of f.dominantPatterns) {
      if (d.comparisonAvailable) {
        const local = Number.isFinite(d.localShare) ? `${pct1(d.localShare)} (${d.localCount}/${d.localSampleSize ?? '–'})` : `${d.localCount} lokal`;
        const baseline = Number.isFinite(d.baselineShare) ? `${pct1(d.baselineShare)} (${d.baselineCount ?? '–'}/${d.baselineSampleSize ?? '–'})` : 'Referenzanteil unbekannt';
        const factor = Number.isFinite(d.factor) ? formatNumber(d.factor, 2) : '–';
        const ci = Number.isFinite(d.ciLow) && Number.isFinite(d.ciHigh)
          ? `${pct1(d.ciLow)}–${pct1(d.ciHigh)}`
          : 'nicht verfügbar';
        const status = d.isSignificant
          ? 'statistisch über dem Referenzanteil nach implementierter Regel'
          : 'explorative Abweichung; nicht als statistisch abgesicherte Überrepräsentation formulieren';
        lines.push(`  - ${d.label}: lokal ${local}; stadtweite Referenz ${baseline}; Faktor ${factor}; 95-%-Wilson-Intervall lokal ${ci}; ${status}.`);
      } else {
        lines.push(`  - ${d.label}: ${d.localCount} lokale Fälle; keine Lokal-vs.-Referenz-Auffälligkeit verfügbar (nur lokale Häufigkeitsrangfolge).`);
      }
    }
  }

  lines.push('');
  lines.push('=== TREND ===');
  // `yearlyTrend` ist die kanonische, relative Regressionsanalyse. Der ältere
  // erste-/zweite-Hälfte-Trend wird nur verwendet, wenn sie fehlt.
  const yt = f.yearlyTrend;
  if (yt && yt.classification) {
    const slope = Number.isFinite(yt.slope) ? formatNumber(yt.slope, 2) : '–';
    const r2Value = Number.isFinite(yt.r2) ? yt.r2 : yt.rSquared;
    const r2 = Number.isFinite(r2Value) ? formatNumber(r2Value, 2) : '–';
    const relSlopeValue = Number.isFinite(trendMethod.relativeSlope) ? trendMethod.relativeSlope : null;
    const relSlope = relSlopeValue !== null ? `${formatNumber(relSlopeValue * 100, 1)} % des Jahresmittels pro Jahr` : '–';
    lines.push(`Kanonische Klassifikation (lineare Regression im selben Bereich): ${yt.classification} (Steigung ${slope} Unfälle/Jahr; relative Steigung ${relSlope}; R²=${r2}; n=${yt.nYears}).`);
  } else if (trend.direction && trend.direction !== 'unknown') {
    lines.push(`Fallback-Richtung über ${trend.rangeYears} Jahre (${trend.firstYear}–${trend.lastYear}): ${trend.direction} (rel. Änderung ${formatNumber(trend.relativeChange * 100, 0)} %).`);
  } else {
    lines.push(`Trend nicht eindeutig bestimmbar (Datenpunkte: ${trend.rangeYears || 0}).`);
  }

  lines.push('');
  lines.push('=== RÄUMLICHE VERDICHTUNG ===');
  if (sp.hint && sp.hint !== 'insufficient_data' && sp.hint !== 'insufficient_coords') {
    lines.push(`Hinweis: ${sp.hint} (Spannweite ca. ${sp.spanMeters} m, Stichprobe ${sp.sampleSize}/${sp.totalAccidents}).`);
  } else {
    lines.push('(zu wenig Einzelpunkte für eine räumliche Aussage)');
  }

  // Stufe-1-Anreicherung: OSM-Kontext aus js/ua.osm_context.js
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
  lines.push('1. Gib zuerst in einem internen Plausibilitätsschritt korrekt wieder, dass Musteranteile und nicht absolute Lokal-/Stadtfallzahlen als Unfallraten verglichen werden.');
  lines.push('2. Prüfe, ob Gesamtzahl und Summe aus Getöteten/Schwerverletzten/Leichtverletzten plausibel zusammenpassen.');
  lines.push('3. Behandle die genannten Unfälle als amtlich dokumentierte Tatsachen; relativiere nur Ursachen- und Wirkungsannahmen.');
  lines.push('4. Unterscheide statistisch abgesicherte Muster (isSignificant=true) von explorativen Abweichungen.');
  lines.push('5. Verknüpfe jede Maßnahme mit mindestens einem konkreten Befund und einem prüfbaren Sicherheitsziel.');
  lines.push('6. Benenne Datenlücken spezifisch. Eine kleine Fallzahl ist kein Grund, dokumentierte Unfälle sprachlich verschwinden zu lassen.');
  lines.push('7. Fordere Expositionsdaten nur für eine ausdrücklich beabsichtigte Aussage über absolutes Risiko beziehungsweise Unfallraten je Verkehrsleistung.');
  if (mode === 'proposal-brief') {
    lines.push('8. Beginne Sachverhalt und Langfassung mit konkreter Unfallzahl, Schwere, Untersuchungsraum und Zeitraum, soweit im Input vorhanden.');
    lines.push('9. Formuliere Beschlussvorschlag und Prüfauftrag konkret; keine bloße sprachliche Verschönerung der Kennzahlen.');
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

function pct1(x) {
  if (!Number.isFinite(x)) return '–';
  return `${formatNumber(x * 100, 1)} %`;
}

function formatNumber(x, digits) {
  if (!Number.isFinite(x)) return '–';
  return Number(x).toFixed(digits).replace('.', ',');
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
