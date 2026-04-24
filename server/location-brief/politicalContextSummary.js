'use strict';

/**
 * Strukturierte Verdichtung politischer Kontextdaten für den
 * Location Action Brief.
 *
 * Eingabe: ein bereits durchgeführtes Suchergebnis aus
 *   `server/political-context/services/portalSearchService.js#search`
 * (oder ein anders strukturiertes, kompatibles Objekt mit `references[]`).
 *
 * Ausgabe-Felder (gemäß Aufgabenstellung):
 *   - previousPoliticalAttention      string (none|some|frequent)
 *   - policyReadiness                 string (low|medium|high)
 *   - relatedReferences               Array<{title,url,type,relevance}>
 *   - recurringRequests               Array<{topic, count}>
 *   - administrativeMomentumHints     string[]   – Hinweise auf laufende
 *                                                  Vorgänge (Anfragen,
 *                                                  Antworten, Beschlüsse)
 *
 * **Wichtig**: kein Vorgang darf nur wegen gleicher Straße als wichtig
 * gelten.  Diese Funktion stützt sich daher *primär* auf
 * `trafficRelevance.classification` und `relevanceScore`, die der
 * Portalsuchdienst bereits liefert.  Treffer ohne erkennbare
 * Verkehrsrelevanz werden konservativ ignoriert.
 *
 * @module server/location-brief/politicalContextSummary
 */

const TRAFFIC_RELEVANT = new Set(['traffic_safety', 'traffic_infrastructure', 'traffic_general']);

/**
 * @param {object} [searchResult]
 *        Erwartete Felder (alle optional):
 *          - references: Array<{ title, url, type, relevanceScore?, trafficRelevance?: { classification?, score? } }>
 *          - meta: { city }
 * @returns {PoliticalContextSummary}
 */
function summarizePoliticalContext(searchResult) {
  const refs = Array.isArray(searchResult?.references) ? searchResult.references : [];
  // Treat references as traffic-relevant only when explicitly classified, to
  // avoid the "same street name" false positive trap.
  const relevant = refs.filter(r => isTrafficRelevant(r));

  const previousPoliticalAttention = countToAttentionLevel(relevant.length);
  const policyReadiness            = computePolicyReadiness(relevant);

  const relatedReferences = relevant
    .slice()
    .sort((a, b) => (relevanceOf(b) - relevanceOf(a)))
    .slice(0, 8)
    .map(r => ({
      title:     String(r.title || r.label || '').slice(0, 240),
      url:       r.url || '',
      type:      r.type || r.kind || '',
      relevance: round2(relevanceOf(r))
    }))
    .filter(r => r.title);

  const recurringRequests = computeRecurringRequests(relevant);
  const administrativeMomentumHints = computeAdministrativeMomentumHints(relevant);

  return {
    previousPoliticalAttention,
    policyReadiness,
    relatedReferences,
    recurringRequests,
    administrativeMomentumHints
  };
}

function isTrafficRelevant(r) {
  if (!r || typeof r !== 'object') return false;
  const cls = r.trafficRelevance?.classification;
  if (cls && TRAFFIC_RELEVANT.has(cls)) return true;
  // Allow explicit boolean override
  if (r.trafficRelevance?.isRelevant === true) return true;
  // Conservative additional path: if the upstream service has already
  // assigned a meaningful, non-zero relevanceScore, treat that as evidence
  // that traffic relevance has been positively asserted.
  if (Number.isFinite(r.relevanceScore) && r.relevanceScore >= 0.5) return true;
  return false;
}

function relevanceOf(r) {
  const traffic = Number(r?.trafficRelevance?.score);
  if (Number.isFinite(traffic)) return traffic;
  const generic = Number(r?.relevanceScore);
  return Number.isFinite(generic) ? generic : 0;
}

function countToAttentionLevel(n) {
  if (n <= 0) return 'none';
  if (n < 3)  return 'some';
  return 'frequent';
}

function computePolicyReadiness(relevant) {
  if (relevant.length === 0) return 'low';
  // Prefer explicit signals
  const hasResolution = relevant.some(r => /beschluss|antwort|stellungnahme|maßnahme/i.test(r.type || ''));
  const hasFresh      = relevant.some(r => isWithinLastYears(r, 2));
  if (relevant.length >= 3 && hasFresh)        return 'high';
  if (hasResolution || (relevant.length >= 2)) return 'medium';
  return 'low';
}

function isWithinLastYears(r, years) {
  const d = parseDate(r?.date || r?.publishedAt || r?.publishedDate);
  if (!d) return false;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return d >= cutoff;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.valueOf()) ? d : null;
}

function computeRecurringRequests(relevant) {
  const counts = new Map();
  for (const r of relevant) {
    const topic = topicOf(r);
    if (!topic) continue;
    counts.set(topic, (counts.get(topic) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));
}

function topicOf(r) {
  // Heuristic: derive a coarse topic from title keywords.
  const t = String(r?.title || '').toLowerCase();
  if (!t) return '';
  if (/(rad|fahrrad|velo)/.test(t))                         return 'radverkehr';
  if (/(fußgänger|fussgänger|fußweg|gehweg|querung)/.test(t)) return 'fussverkehr';
  if (/(schul|kita)/.test(t))                               return 'schulweg';
  if (/(tempo|verkehrsberuhig)/.test(t))                    return 'tempo';
  if (/(park|halten)/.test(t))                              return 'parken';
  if (/(unfall|sicherheit)/.test(t))                        return 'verkehrssicherheit';
  if (/(bus|tram|haltestelle|öpnv)/.test(t))                return 'oepnv';
  return '';
}

function computeAdministrativeMomentumHints(relevant) {
  const hints = [];
  if (relevant.length === 0) return hints;
  const recent = relevant.filter(r => isWithinLastYears(r, 1));
  if (recent.length >= 2) {
    hints.push(`Es liegen ${recent.length} Vorgänge aus den letzten 12 Monaten vor – das Thema ist politisch aktiv.`);
  }
  if (relevant.some(r => /antrag/i.test(r.type || ''))) {
    hints.push('Es existieren bereits Anträge mit Bezug zur Verkehrssicherheit – Anschluss an laufende Initiativen möglich.');
  }
  if (relevant.some(r => /antwort|stellungnahme/i.test(r.type || ''))) {
    hints.push('Verwaltung hat bereits geantwortet bzw. Stellung genommen – Sachstand sollte vor neuen Anträgen geprüft werden.');
  }
  if (relevant.some(r => /beschluss/i.test(r.type || ''))) {
    hints.push('Es liegen bereits Beschlüsse vor – Umsetzungsstand klären, bevor neue Maßnahmen vorgeschlagen werden.');
  }
  return hints;
}

function round2(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

/**
 * Returns an empty, well-formed summary.  Used as the default when no
 * political context has been provided.
 */
function emptyPoliticalContextSummary() {
  return {
    previousPoliticalAttention: 'none',
    policyReadiness: 'low',
    relatedReferences: [],
    recurringRequests: [],
    administrativeMomentumHints: []
  };
}

module.exports = {
  summarizePoliticalContext,
  emptyPoliticalContextSummary
};

/**
 * @typedef {object} PoliticalContextSummary
 * @property {string} previousPoliticalAttention   – none|some|frequent
 * @property {string} policyReadiness              – low|medium|high
 * @property {Array<{title:string,url:string,type:string,relevance:number}>} relatedReferences
 * @property {Array<{topic:string,count:number}>}  recurringRequests
 * @property {string[]} administrativeMomentumHints
 */
