'use strict';

/**
 * Erzeugt Suchvarianten aus dem Karten-/Exportkontext für die politische
 * Vorgangsrecherche.
 *
 * Ziel: besserer Recall ohne die zentrale Bewertung zu schwächen.  Die
 * Variantensuche ist absichtlich breit; die fachliche Auswahl erfolgt
 * später im trafficRelevanceService und im aiGatingService.
 *
 * Erzeugte Varianten (so weit aus dem Kontext ableitbar):
 *   1. Originalbegriffe (z. B. „Limmerstraße")
 *   2. Straße + Radverkehr           (z. B. „Limmerstraße Radverkehr")
 *   3. Straße + Verkehrssicherheit
 *   4. Straße + Gremium              (z. B. „Limmerstraße Stadtbezirksrat Linden-Limmer")
 *   5. Kreuzung                      (Originalbegriff, sofern als Kreuzung erkannt)
 *   6. Stadtbezirk + Straße          (z. B. „Linden Limmerstraße")
 *   7. Thema + Stadtteil             (z. B. „Radverkehr Linden")
 *   8. Verkehrssicherheit + Stadtteil
 *
 * Die Funktion ist deterministisch (gleicher Input → gleicher Output) und
 * ohne Seiteneffekte.
 *
 * @module server/political-context/services/searchVariantBuilder
 */

/** Maximale Anzahl Suchvarianten, die der Builder zurückgibt. */
const MAX_VARIANTS = 8;

/** Maximale Länge einer einzelnen Variante (deckt sich mit der Sanitisierung
 *  in server/index.js – dort wird auf 200 Zeichen gekappt). */
const MAX_TERM_LENGTH = 200;

/** Heuristik: erkennt Straßennamen.  Bewusst tolerant gegenüber Komposita
 *  („Limmerstraße"). */
const STREET_RE = /(?:straße|strasse|str\.?\b|\bplatz\b|\ballee\b|\bweg\b|\bgasse\b|\bring\b|\bufer\b|\bdamm\b|\bchaussee\b|\bbrücke\b|\bbruecke\b)/i;

/** Heuristik: erkennt Stadtbezirks-/Stadtteil-/Quartier-Hinweise. */
const DISTRICT_RE = /\b(stadtbezirk|bezirk|stadtteil|ortsteil|quartier|viertel)\b/i;

/** Heuristik: erkennt Kreuzungs-/Knotenpunkt-Hinweise. */
const INTERSECTION_RE = /\b(kreuzung|knoten(?:punkt)?|abzweig|kreisverkehr|einmündung|ein-?mund|kreisel)\b/i;

/** Allgemeine Verkehrsthemen, die einer Straße angefügt werden. */
const TRAFFIC_TOPICS = ['Radverkehr', 'Verkehrssicherheit'];

/**
 * Hilfsfunktion: prüft, ob ein Begriff wie ein Straßenname aussieht.
 * @param {string} term
 * @returns {boolean}
 */
function looksLikeStreet(term) {
  return typeof term === 'string' && STREET_RE.test(term);
}

/**
 * Hilfsfunktion: prüft, ob ein Begriff wie ein Stadtbezirks-/Stadtteilname
 * aussieht.  Erkennt sowohl explizite Marker („Stadtteil Linden") als auch
 * Marker im umgebenden Kontext.
 * @param {string} term
 * @returns {boolean}
 */
function looksLikeDistrict(term) {
  return typeof term === 'string' && DISTRICT_RE.test(term);
}

/**
 * Hilfsfunktion: prüft, ob ein Begriff einen Kreuzungs-/Knotenpunkt-Hinweis
 * enthält.
 * @param {string} term
 * @returns {boolean}
 */
function looksLikeIntersection(term) {
  return typeof term === 'string' && INTERSECTION_RE.test(term);
}

/**
 * Entfernt explizite Marker („Stadtteil ", „Stadtbezirk ") aus einem
 * Begriff – das eigentliche Stadtteil-Label ist meist wertvoller als der
 * Marker selbst.
 *
 * @param {string} term
 * @returns {string}
 */
function stripDistrictMarker(term) {
  return String(term || '')
    .replace(/^(stadtbezirk|bezirk|stadtteil|ortsteil|quartier|viertel)\s+/i, '')
    .trim();
}

/**
 * Sanitisiert + kappt einen einzelnen Begriff.
 *
 * @param {string} term
 * @returns {string}
 */
function clean(term) {
  if (typeof term !== 'string') return '';
  // Mehrfach-Whitespace reduzieren, Trim, Längenbegrenzung
  const t = term.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TERM_LENGTH ? t.substring(0, MAX_TERM_LENGTH) : t;
}

/**
 * Fügt eine Variante in eine Map ein, wenn sie neu (case-insensitiv) und
 * nicht-leer ist.  Reihenfolge bleibt erhalten (Map-Insertion-Order).
 *
 * @param {Map<string,string>} bucket – key: lowercase, value: Originalform
 * @param {string} variant
 */
function add(bucket, variant) {
  const v = clean(variant);
  if (!v) return;
  const key = v.toLowerCase();
  if (!bucket.has(key)) bucket.set(key, v);
}

/**
 * Hauptfunktion: erzeugt eine Liste deduplizierter Suchvarianten.
 *
 * Kontext-Felder, die ausgewertet werden:
 *   - context.gremium  – z. B. „Stadtbezirksrat Linden-Limmer"
 *   - context.location – freier Ortshinweis (kann Straße oder Bezirk sein)
 *   - context.street   – expliziter Straßenname (optional)
 *   - context.district – expliziter Stadtteil/Stadtbezirk (optional)
 *
 * @param {string[]} originalTerms
 * @param {object}   [context]
 * @returns {string[]}  Liste der Suchvarianten (Originale zuerst, max. {@link MAX_VARIANTS})
 */
function buildSearchVariants(originalTerms, context) {
  const ctx = (context && typeof context === 'object') ? context : {};
  const bucket = new Map();

  const terms = Array.isArray(originalTerms)
    ? originalTerms.filter(t => typeof t === 'string' && t.trim())
    : [];

  // 1. Originalbegriffe immer zuerst (Reihenfolge bleibt)
  for (const t of terms) add(bucket, t);

  // Aus den Begriffen + dem expliziten Kontext Straßen-/Bezirks-Kandidaten
  // ableiten.
  const explicitStreet   = clean(ctx.street);
  const explicitDistrict = stripDistrictMarker(clean(ctx.district));

  const streetCandidates   = new Set();
  const districtCandidates = new Set();

  if (explicitStreet)   streetCandidates.add(explicitStreet);
  if (explicitDistrict) districtCandidates.add(explicitDistrict);

  for (const t of terms) {
    if (looksLikeStreet(t))   streetCandidates.add(t);
    if (looksLikeDistrict(t)) districtCandidates.add(stripDistrictMarker(t));
  }

  // Auch context.location klassifizieren (Straße ODER Bezirk).
  const loc = clean(ctx.location);
  if (loc) {
    if (looksLikeStreet(loc))         streetCandidates.add(loc);
    else if (looksLikeDistrict(loc))  districtCandidates.add(stripDistrictMarker(loc));
    // Wenn nicht eindeutig, nicht als Variante hinzufügen – der Fall wird
    // bereits durch die Originalbegriffe abgedeckt.
  }

  // 2./3. Straße + Verkehrsthemen
  for (const street of streetCandidates) {
    for (const topic of TRAFFIC_TOPICS) {
      add(bucket, `${street} ${topic}`);
    }
  }

  // 4. Straße + Gremium (gekürzt)
  const gremium = clean(ctx.gremium);
  if (gremium) {
    for (const street of streetCandidates) {
      add(bucket, `${street} ${gremium}`);
    }
  }

  // 5. Kreuzung – nur wenn ein Originalbegriff bereits als Kreuzung erkennbar
  // ist; dann den Begriff "as-is" als Variante belassen (Original bleibt
  // ohnehin enthalten, aber wir generieren zusätzlich „<Begriff> Kreuzung",
  // falls das Wort fehlt).  Damit fragen wir das Portal auch explizit nach
  // Vorgängen zur Kreuzungssituation.
  for (const t of terms) {
    if (looksLikeIntersection(t)) {
      add(bucket, t);
    } else if (looksLikeStreet(t)) {
      // Straßenname ohne Kreuzungs-Marker → ergänzen, falls noch nicht da
      add(bucket, `${t} Kreuzung`);
    }
  }

  // 6. Stadtbezirk + Straße
  for (const district of districtCandidates) {
    for (const street of streetCandidates) {
      add(bucket, `${district} ${street}`);
    }
  }

  // 7./8. Thema + Stadtteil
  for (const district of districtCandidates) {
    for (const topic of TRAFFIC_TOPICS) {
      add(bucket, `${topic} ${district}`);
    }
  }

  return [...bucket.values()].slice(0, MAX_VARIANTS);
}

module.exports = {
  buildSearchVariants,
  // exportiert für Tests / Wiederverwendung
  looksLikeStreet,
  looksLikeDistrict,
  looksLikeIntersection,
  MAX_VARIANTS
};
