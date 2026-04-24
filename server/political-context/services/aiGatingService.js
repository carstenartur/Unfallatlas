'use strict';

/**
 * Zentrale Zulassungslogik für die spätere KI-Bewertung politischer
 * Vorgänge.  Hält fachliche Auswahl getrennt von der breiten Suche:
 * der portalSearchService darf großzügig liefern, hier wird *eng*
 * gefiltert.
 *
 * Regeln (ausschließlich aus den deterministisch berechneten Feldern
 * `trafficCategory`, `topicMatch`, `streetHints`, `areaHints`,
 * `locationMatch` und `isTrafficRelevant` abgeleitet):
 *
 *   - non_traffic       → nie an die KI weitergeben
 *   - direct_traffic    → nur mit brauchbarem Orts- ODER Themenbezug
 *                         (locationMatch ∈ {street, district, bbox} oder
 *                          topicMatch.length > 0 oder
 *                          streetHints.length > 0 oder
 *                          areaHints.length > 0)
 *   - indirect_traffic  → nur mit *gutem* Ortsbezug
 *                         (locationMatch ∈ {street, district}) ODER
 *                         mindestens einem topicMatch
 *
 * Die Funktion ist ein reiner Boolean-Filter mit lesbarer Begründung;
 * sie ruft nichts Externes auf und ist deterministisch.
 *
 * @module server/political-context/services/aiGatingService
 */

/**
 * @typedef {object} AiGatingDecision
 * @property {boolean} allowed
 * @property {string}  reason   – kurze, lesbare Begründung (max. 240 Zeichen)
 */

/** Maximale Länge der Begründung (passend zum Schema-Limit). */
const REASON_MAX_LEN = 240;

/**
 * @param {string} reason
 * @returns {string}
 */
function clampReason(reason) {
  if (typeof reason !== 'string') return '';
  return reason.length > REASON_MAX_LEN
    ? reason.substring(0, REASON_MAX_LEN - 1) + '…'
    : reason;
}

/**
 * Prüft, ob `topicMatch` einen verwertbaren Themenbezug enthält.
 * @param {*} topicMatch
 * @returns {boolean}
 */
function hasTopicMatch(topicMatch) {
  return Array.isArray(topicMatch) && topicMatch.some(t => typeof t === 'string' && t.trim());
}

/**
 * Prüft, ob mindestens ein nicht-leerer String im Array steht.
 * @param {*} arr
 * @returns {boolean}
 */
function hasAnyString(arr) {
  return Array.isArray(arr) && arr.some(v => typeof v === 'string' && v.trim());
}

/**
 * Liefert die Gating-Entscheidung für einen einzelnen Treffer.
 *
 * @param {object} reference
 * @param {object} [context]   – derselbe Kontext wie bei der Suche
 *                               (gremium, location, …); nicht zwingend nötig,
 *                               aber für künftige Erweiterungen vorgesehen
 * @returns {AiGatingDecision}
 */
function shouldAllowForAiEvaluation(reference, context) {
  // Defensive: ohne Referenz nichts an die KI geben.
  if (!reference || typeof reference !== 'object') {
    return { allowed: false, reason: 'Kein Treffer übergeben.' };
  }

  const category      = reference.trafficCategory;
  const locationMatch = reference.locationMatch;
  const topicMatch    = reference.topicMatch;
  const streetHints   = reference.streetHints;
  const areaHints     = reference.areaHints;

  // Wenn die Verkehrsklassifikation noch nicht durchgelaufen ist, nicht
  // raten – konservativ ablehnen, statt eine schlechte Bewertung
  // weiterzureichen.
  if (category === undefined || category === null) {
    return {
      allowed: false,
      reason:  'Verkehrsklassifikation fehlt – Treffer wird sicherheitshalber nicht an die KI weitergegeben.'
    };
  }

  // Regel 1: non_traffic nie an KI.
  if (category === 'non_traffic') {
    return {
      allowed: false,
      reason:  'Kein Verkehrsbezug erkannt – Treffer für die KI-Bewertung ungeeignet.'
    };
  }

  // Verkehrsrelevanz darf nicht implizit auf 0 stehen.
  if (reference.isTrafficRelevant === false) {
    return {
      allowed: false,
      reason:  'Verkehrsrelevanz unterhalb des Schwellwerts – nicht an die KI weitergegeben.'
    };
  }

  const hasLocStreetOrDistrict = locationMatch === 'street' || locationMatch === 'district';
  const hasUsableLocation      = hasLocStreetOrDistrict || locationMatch === 'bbox';
  const topicHit               = hasTopicMatch(topicMatch);
  const streetHinted           = hasAnyString(streetHints);
  const areaHinted             = hasAnyString(areaHints);

  // Regel 2: direct_traffic – braucht *irgendeinen* Orts- oder Themenbezug.
  if (category === 'direct_traffic') {
    if (hasUsableLocation || topicHit || streetHinted || areaHinted) {
      const reasons = [];
      if (hasLocStreetOrDistrict) reasons.push(`Ortsbezug (${locationMatch})`);
      else if (locationMatch === 'bbox') reasons.push('Ortsbezug (Kartenausschnitt)');
      if (topicHit) reasons.push(`Thementreffer (${topicMatch.length})`);
      if (!hasUsableLocation && (streetHinted || areaHinted)) {
        reasons.push('Ortshinweise im Text');
      }
      return {
        allowed: true,
        reason:  clampReason(`Direkter Verkehrsbezug mit ${reasons.join(', ')}.`)
      };
    }
    return {
      allowed: false,
      reason:  'Direkter Verkehrsbezug, aber weder Orts- noch Themenbezug erkannt.'
    };
  }

  // Regel 3: indirect_traffic – braucht *guten* Ortsbezug oder Themenbezug.
  if (category === 'indirect_traffic') {
    if (hasLocStreetOrDistrict || topicHit) {
      const reasons = [];
      if (hasLocStreetOrDistrict) reasons.push(`Ortsbezug (${locationMatch})`);
      if (topicHit) reasons.push(`Thementreffer (${topicMatch.length})`);
      return {
        allowed: true,
        reason:  clampReason(`Indirekter Verkehrsbezug mit ${reasons.join(', ')}.`)
      };
    }
    return {
      allowed: false,
      reason:  'Indirekter Verkehrsbezug ohne ausreichenden Orts- oder Themenbezug – nicht an die KI weitergegeben.'
    };
  }

  // Unbekannte Kategorie → konservativ ablehnen.
  return {
    allowed: false,
    reason:  `Unbekannte Verkehrskategorie "${category}" – konservativ abgelehnt.`
  };
}

/**
 * Bequemlichkeit: filtert ein Array auf KI-zulässige Treffer.
 *
 * @param {object[]} references
 * @param {object}   [context]
 * @returns {object[]}
 */
function filterReferencesForAi(references, context) {
  if (!Array.isArray(references)) return [];
  return references.filter(ref => shouldAllowForAiEvaluation(ref, context).allowed);
}

/**
 * Reichert einen Treffer um das Gating-Ergebnis an (immutabel).
 *
 * @param {object} reference
 * @param {object} [context]
 * @returns {object}
 */
function enrichWithAiGating(reference, context) {
  const decision = shouldAllowForAiEvaluation(reference, context);
  return { ...reference, aiGating: decision };
}

/**
 * @param {object[]} references
 * @param {object}   [context]
 * @returns {object[]}
 */
function enrichAllWithAiGating(references, context) {
  if (!Array.isArray(references)) return [];
  return references.map(r => enrichWithAiGating(r, context));
}

module.exports = {
  shouldAllowForAiEvaluation,
  filterReferencesForAi,
  enrichWithAiGating,
  enrichAllWithAiGating
};
