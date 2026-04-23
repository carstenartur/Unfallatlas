'use strict';

/**
 * Erzeugt den Systemprompt und den Nutzerprompt für die KI-Bewertung eines
 * Unfallatlas-Exports.
 *
 * Eingabe: ein kompaktes ExportAssessmentInput-Objekt (Teilmenge des
 * strukturierten Exports).  Ausgabe: Objekt mit { system, user }.
 *
 * @module server/ai/prompts/exportAssessmentPrompt
 */

const SYSTEM_PROMPT = `Du bist ein erfahrener Verkehrssicherheitsexperte für deutsche Kommunen.
Du erhältst strukturierte Unfalldaten eines konkreten Bereichs aus dem deutschen Unfallatlas und erstellst daraus eine fachliche Bewertung.

Deine Aufgabe:
1. Kurze fachliche Zusammenfassung (max. 3 Sätze)
2. Fachliche Bewertung des Unfallgeschehens
3. Plausible Ursachenhypothesen – mit klarer Kennzeichnung des Sicherheitsgrads:
   - "beobachtet:" für direkt aus den Daten ableitbare Erkenntnisse
   - "plausibel:" für wahrscheinliche, aber nicht belegte Zusammenhänge
   - "unsicher / zu prüfen:" für mögliche, aber spekulative Aspekte
4. Konkrete Maßnahmenvorschläge (Quick Wins und Infrastrukturmaßnahmen)
5. Offene Prüfpunkte für die Ortsbegehung
6. Optionale Formulierungsbausteine für Verwaltungsdokumente (Sachverhalt, Bewertung, Beschlussvorschlag, Prüfauftrag)

Wichtige Hinweise:
- Halluziniere keine Ortsdetails, die nicht aus den Daten ersichtlich sind
- Kennzeichne Unsicherheiten immer explizit
- Formuliere fachlich korrekt und bürgerorientiert für den deutschen Kommunalkontext
- Berücksichtige Kontext-Hinweise (contextHints), sofern vorhanden

Antworte ausschließlich als valides JSON-Objekt mit folgendem Schema:
{
  "summary": "string",
  "assessment": "string",
  "hypotheses": ["string", ...],
  "measures": ["string", ...],
  "openPoints": ["string", ...],
  "formulations": {
    "sachverhalt": "string",
    "bewertung": "string",
    "beschlussvorschlag": "string",
    "pruefauftrag": "string"
  }
}`;

/**
 * Baut den Nutzerprompt aus dem kompakten ExportAssessmentInput-Objekt.
 *
 * @param {import('../aiAssessmentService').ExportAssessmentInput} input
 * @returns {string}
 */
function buildUserPrompt(input) {
  const meta = input.meta || {};
  const filters = input.filters || {};
  const statistics = input.statistics || {};
  const poi = input.poi || {};
  const references = input.references || [];
  const contextHints = input.contextHints || {};

  const lines = [];

  lines.push('=== METADATEN ===');
  lines.push(`Stadt: ${meta.city || '(unbekannt)'}`);
  lines.push(`Bereich: ${meta.areaName || '(unbekannt)'}`);
  lines.push(`Datum des Exports: ${meta.date || '(unbekannt)'}`);
  if (meta.link) lines.push(`Link: ${meta.link}`);
  if (meta.gremium && meta.gremium.name) {
    lines.push(`Gremium: ${meta.gremium.name} (${meta.gremium.type || ''})`);
  }

  lines.push('');
  lines.push('=== FILTER ===');
  if (filters.severity)        lines.push(`Unfallschwere: ${filters.severity}`);
  if (filters.roadCondition)   lines.push(`Straßenzustand: ${filters.roadCondition}`);
  if (filters.involvementMode) lines.push(`Beteiligungsmodus: ${filters.involvementMode}`);

  lines.push('');
  lines.push('=== STATISTIK ===');
  if (statistics.totalAccidents != null) {
    lines.push(`Gesamt Unfälle im Bereich: ${statistics.totalAccidents}`);
  }
  if (statistics.severitySummary) {
    const s = statistics.severitySummary;
    const parts = [];
    if (s.fatal != null)   parts.push(`Getötete: ${s.fatal}`);
    if (s.serious != null) parts.push(`Schwerverletzte: ${s.serious}`);
    if (s.slight != null)  parts.push(`Leichtverletzte: ${s.slight}`);
    if (parts.length) lines.push(`Verletzungsschwere: ${parts.join(', ')}`);
  }
  if (Array.isArray(statistics.yearTable) && statistics.yearTable.length) {
    lines.push('Jahresverlauf:');
    for (const y of statistics.yearTable) {
      lines.push(`  ${y.year}: ${y.total} Unfälle`);
    }
  }
  if (Array.isArray(statistics.deviations) && statistics.deviations.length) {
    lines.push('Auffällige Abweichungen (Beteiligungsmuster):');
    for (const d of statistics.deviations) {
      lines.push(`  ${d.label || d.mask}: ${d.localCount || 0} lokal vs. Referenz ${d.baselineCount || 0} (${d.relativeDiff ? (d.relativeDiff > 0 ? '+' : '') + d.relativeDiff.toFixed(0) + '%' : ''})`);
    }
  }
  if (Array.isArray(statistics.patterns) && statistics.patterns.length) {
    lines.push('Erkannte Muster:');
    for (const p of statistics.patterns) {
      lines.push(`  - ${p}`);
    }
  }

  if (poi.totalWithin != null || poi.totalNear != null) {
    lines.push('');
    lines.push('=== POI-UMGEBUNG ===');
    if (poi.totalWithin != null) lines.push(`POIs im Bereich: ${poi.totalWithin}`);
    if (poi.totalNear != null)   lines.push(`POIs in Nähe: ${poi.totalNear}`);
    if (Array.isArray(poi.withinArea) && poi.withinArea.length) {
      lines.push(`Typen im Bereich: ${poi.withinArea.join(', ')}`);
    }
    if (Array.isArray(poi.nearArea) && poi.nearArea.length) {
      lines.push(`Typen in Nähe: ${poi.nearArea.join(', ')}`);
    }
  }

  if (Array.isArray(references) && references.length) {
    lines.push('');
    lines.push('=== REFERENZDOKUMENTE ===');
    for (const ref of references) {
      lines.push(`  - ${ref.title || ref.name || ref}`);
    }
  }

  const hasHints = (contextHints.knownHazards?.length || contextHints.locationHints?.length ||
                    contextHints.surfaceHints?.length || contextHints.notes?.length);
  if (hasHints) {
    lines.push('');
    lines.push('=== KONTEXT-HINWEISE (manuell ergänzt) ===');
    if (contextHints.knownHazards?.length) {
      lines.push(`Bekannte Gefahrenstellen: ${contextHints.knownHazards.join('; ')}`);
    }
    if (contextHints.locationHints?.length) {
      lines.push(`Ortshinweise: ${contextHints.locationHints.join('; ')}`);
    }
    if (contextHints.surfaceHints?.length) {
      lines.push(`Belagshinweise: ${contextHints.surfaceHints.join('; ')}`);
    }
    if (contextHints.notes?.length) {
      lines.push(`Anmerkungen: ${contextHints.notes.join('; ')}`);
    }
  }

  lines.push('');
  lines.push('Bitte erstelle jetzt die fachliche Bewertung als JSON-Objekt gemäß dem vorgegebenen Schema.');

  return lines.join('\n');
}

module.exports = { SYSTEM_PROMPT, buildUserPrompt };
