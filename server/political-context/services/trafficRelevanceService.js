'use strict';

/**
 * Verkehrsrelevanz-Klassifikation für normalisierte politische Vorgänge.
 *
 * Liefert eine deterministische, fachliche Einschätzung, ob ein Treffer
 * für eine Verkehrsanalyse relevant ist – auf Basis von Titel, Snippet
 * und Gremium.  Keine KI, keine externen Aufrufe.
 *
 * Ergebnisfelder, die {@link classifyTrafficRelevance} liefert:
 *   - trafficCategory       : 'direct_traffic' | 'indirect_traffic' | 'non_traffic'
 *   - trafficRelevanceScore : 0–100 (deterministisch)
 *   - trafficSubtopics      : kanonische Subthemen (z. B. ['Radverkehr'])
 *   - isTrafficRelevant     : true falls Kategorie ≠ 'non_traffic' und Score ≥ 20
 *   - trafficReason         : kurze, lesbare Begründung (max. 240 Zeichen)
 *
 * @module server/political-context/services/trafficRelevanceService
 */

/** Score, ab dem ein Treffer als verkehrsrelevant gilt. */
const RELEVANCE_THRESHOLD = 20;

/** Maximale Länge einer Begründung. */
const REASON_MAX_LEN = 240;

/**
 * Subthemen mit zugehörigen Stichworten.  Reihenfolge bestimmt die
 * Anzeige­reihenfolge der Subthemen, nicht die Klassifikation.
 *
 * Die Stichworte sind klein geschrieben; der Match erfolgt case-insensitive
 * gegen die Lowercase-Variante von Titel + Snippet + Gremium.
 *
 * @type {Array<{label: string, keywords: string[]}>}
 */
const DIRECT_SUBTOPICS = [
  {
    label: 'Radverkehr',
    keywords: [
      'radverkehr', 'radweg', 'radstreifen', 'fahrradstraße', 'fahrradstrasse',
      'schutzstreifen', 'radschnellweg', 'fahrrad', 'velo', 'bike'
    ]
  },
  {
    label: 'Fußverkehr',
    keywords: [
      'fußverkehr', 'fussverkehr', 'fußgänger', 'fussgaenger', 'gehweg',
      'zebrastreifen', 'fußgängerüberweg', 'fussgaengerueberweg', 'querungshilfe'
    ]
  },
  {
    label: 'Schulweg',
    keywords: ['schulweg', 'schulwegsicherung', 'schulwegplan']
  },
  {
    label: 'Verkehrssicherheit',
    keywords: [
      'verkehrssicherheit', 'verkehrsunfall', 'unfallschwerpunkt',
      'unfallhäufung', 'unfallhaeufung', 'verkehrsunfälle', 'verkehrsunfaelle'
    ]
  },
  {
    label: 'Geschwindigkeit/Tempo',
    keywords: [
      'tempo 30', 'tempo-30', 'tempo30', 'verkehrsberuhigung',
      'geschwindigkeitsbegrenzung', 'geschwindigkeitsmessung'
    ]
  },
  {
    label: 'Knotenpunkt/Ampel',
    keywords: [
      'kreuzung', 'knotenpunkt', 'ampel', 'lichtsignal', 'signalanlage',
      'kreisverkehr', 'kreisel', 'einmündung', 'einmuendung'
    ]
  },
  {
    label: 'ÖPNV',
    keywords: [
      'öpnv', 'oepnv', 'bus', 'buslinie', 'straßenbahn', 'strassenbahn',
      'stadtbahn', 'haltestelle', 'tram', 'üstra'
    ]
  },
  {
    label: 'Ruhender Verkehr',
    keywords: ['parken', 'parkraum', 'parkplatz', 'halten', 'halteverbot']
  },
  {
    label: 'Straße/Fahrbahn',
    keywords: [
      'fahrbahn', 'straßensanierung', 'strassensanierung', 'straßenbau',
      'strassenbau', 'straßenbelag', 'strassenbelag', 'bordstein'
    ]
  },
  {
    label: 'Mobilität',
    keywords: ['mobilität', 'mobilitaet', 'verkehrswende', 'mobilitätswende']
  }
];

/**
 * Schlagworte für *indirekten* Verkehrsbezug.  Werden nur ausgewertet,
 * wenn keine direkten Treffer vorliegen.
 */
const INDIRECT_KEYWORDS = [
  'stadtentwicklung', 'sanierung', 'umbau', 'neuordnung', 'umgestaltung',
  'bauausschuss', 'planungsausschuss', 'infrastruktur', 'lärm', 'laerm',
  'lärmschutz', 'laermschutz', 'klima', 'klimaschutz', 'baumaßnahme',
  'baumassnahme', 'platzgestaltung', 'umgestaltung'
];

/**
 * Punkte pro direktem Subthemen-Treffer (gekappt).
 */
const POINTS_PER_DIRECT_SUBTOPIC = 25;
/** Bonus, wenn ein direkter Treffer im Titel steht (statt nur Snippet). */
const BONUS_DIRECT_IN_TITLE      = 15;
/** Punkte pro indirektem Treffer (gekappt). */
const POINTS_PER_INDIRECT        = 10;
/** Bonus, wenn ein indirekter Treffer im Titel steht. */
const BONUS_INDIRECT_IN_TITLE    = 5;
/** Bonus für eine eindeutige verkehrsfachliche Gremiums-Zugehörigkeit. */
const BONUS_TRAFFIC_GREMIUM      = 10;

/**
 * Erkennt verkehrsfachliche Gremien (Verkehrsausschuss etc.).
 */
const TRAFFIC_GREMIUM_RE = /(verkehrs(?:ausschuss|kommission|beirat)|ausschuss\s+f(?:ü|ue)r\s+verkehr|mobilit(?:ä|ae)tsausschuss)/i;

/**
 * Klassifiziert einen normalisierten Treffer hinsichtlich Verkehrsrelevanz.
 *
 * @param {object} reference – normalisiertes PoliticalReference-Objekt
 * @returns {{
 *   trafficCategory:       ('direct_traffic'|'indirect_traffic'|'non_traffic'),
 *   trafficRelevanceScore: number,
 *   trafficSubtopics:      string[],
 *   isTrafficRelevant:     boolean,
 *   trafficReason:         string
 * }}
 */
function classifyTrafficRelevance(reference) {
  const ref     = reference || {};
  const title   = String(ref.title   || '');
  const snippet = String(ref.snippet || '');
  const gremium = String(ref.gremium || '');

  const titleLc   = title.toLowerCase();
  const snippetLc = snippet.toLowerCase();
  const gremiumLc = gremium.toLowerCase();

  // ── Direkte Subthemen sammeln ───────────────────────────────────────────
  const directHits = [];           // [{label, inTitle, keyword}]
  const seenLabels = new Set();
  for (const topic of DIRECT_SUBTOPICS) {
    let hitKeyword = null;
    let inTitle    = false;
    for (const kw of topic.keywords) {
      if (titleLc.includes(kw))   { hitKeyword = kw; inTitle = true; break; }
      if (snippetLc.includes(kw)) { hitKeyword = kw;                 break; }
    }
    if (hitKeyword && !seenLabels.has(topic.label)) {
      seenLabels.add(topic.label);
      directHits.push({ label: topic.label, inTitle, keyword: hitKeyword });
    }
  }

  // ── Indirekte Treffer sammeln ───────────────────────────────────────────
  const indirectHits = [];         // [{keyword, inTitle}]
  for (const kw of INDIRECT_KEYWORDS) {
    if (titleLc.includes(kw))         indirectHits.push({ keyword: kw, inTitle: true });
    else if (snippetLc.includes(kw))  indirectHits.push({ keyword: kw, inTitle: false });
  }

  // Verkehrsfachliches Gremium?
  const trafficGremium = TRAFFIC_GREMIUM_RE.test(gremiumLc);

  // ── Score & Kategorie bestimmen ─────────────────────────────────────────
  let score = 0;
  let category;
  let reason;

  if (directHits.length > 0) {
    category = 'direct_traffic';
    // Punkte je Subthema, plus Title-Bonus, gedeckelt
    for (const h of directHits) {
      score += POINTS_PER_DIRECT_SUBTOPIC;
      if (h.inTitle) score += BONUS_DIRECT_IN_TITLE;
    }
    if (trafficGremium) score += BONUS_TRAFFIC_GREMIUM;

    const labels = directHits.map(h => h.label);
    const where  = directHits.some(h => h.inTitle) ? 'Titel' : 'Auszug';
    reason = `Verkehrsbezug: ${labels.join(', ')} (im ${where}).`;
  } else if (indirectHits.length > 0) {
    category = 'indirect_traffic';
    const uniqueKeywords = [];
    for (const h of indirectHits) {
      if (!uniqueKeywords.includes(h.keyword)) uniqueKeywords.push(h.keyword);
      score += POINTS_PER_INDIRECT;
      if (h.inTitle) score += BONUS_INDIRECT_IN_TITLE;
    }
    if (trafficGremium) score += BONUS_TRAFFIC_GREMIUM;
    const where = indirectHits.some(h => h.inTitle) ? 'Titel' : 'Auszug';
    reason = `Indirekter Verkehrsbezug über ${uniqueKeywords.slice(0, 3).join(', ')} (im ${where}).`;
  } else {
    category = 'non_traffic';
    score    = 0;
    reason   = 'Keine verkehrsfachlichen Stichworte im Titel oder Auszug erkannt.';
  }

  // Score auf [0, 100] kappen
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Truncate reason defensiv
  if (reason && reason.length > REASON_MAX_LEN) {
    reason = reason.substring(0, REASON_MAX_LEN - 1) + '…';
  }

  const isTrafficRelevant = category !== 'non_traffic' && score >= RELEVANCE_THRESHOLD;

  return {
    trafficCategory:       category,
    trafficRelevanceScore: score,
    trafficSubtopics:      directHits.map(h => h.label),
    isTrafficRelevant,
    trafficReason:         reason
  };
}

/**
 * Reichert einen einzelnen normalisierten Treffer um die Verkehrs-Felder an
 * (immutabel; gibt eine neue Kopie zurück).
 *
 * @param {object} reference
 * @returns {object}
 */
function enrichWithTrafficRelevance(reference) {
  const cls = classifyTrafficRelevance(reference);
  return { ...reference, ...cls };
}

/**
 * Reichert eine Liste an.
 *
 * @param {object[]} references
 * @returns {object[]}
 */
function enrichAllWithTrafficRelevance(references) {
  if (!Array.isArray(references)) return [];
  return references.map(enrichWithTrafficRelevance);
}

module.exports = {
  classifyTrafficRelevance,
  enrichWithTrafficRelevance,
  enrichAllWithTrafficRelevance,
  RELEVANCE_THRESHOLD
};
