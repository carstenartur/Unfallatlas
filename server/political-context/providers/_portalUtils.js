'use strict';

/**
 * Gemeinsame Hilfsfunktionen für Portal-Provider.
 *
 * Enthält *portalunabhängige* Bausteine:
 *   - HTTP-GET mit hartem Timeout (`fetchHtml`)
 *   - HTML-Tag-/Entity-Helfer (`stripTags`, `decodeEntities`)
 *   - Vorgangstyp- und Referenzmodell-Heuristik
 *     (`inferType`, `mapReferenceType`, `classifyTermLocation`,
 *     `enrichWithReferenceModel`)
 *
 * Portal-spezifische Konstanten (Selektoren, URLs, Tabellenstruktur) bleiben
 * in den jeweiligen Provider-Modulen.  Der Hannover-Provider hat seine eigene,
 * historisch gewachsene Kopie dieser Helfer; neue Provider (Berlin, Bonn,
 * Hamburg) nutzen dieses Modul, um Code-Duplikation zu vermeiden.
 *
 * @module server/political-context/providers/_portalUtils
 */

const https = require('https');

/** HTTP-Timeout in ms (per ENV überschreibbar). */
const REQUEST_TIMEOUT_MS = parseInt(process.env.PORTAL_SEARCH_TIMEOUT_MS || '10000', 10);

/**
 * Führt eine einzelne HTTP-GET-Anfrage durch.
 * Nutzt das eingebaute Node.js-https-Modul (keine externen Abhängigkeiten).
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] Override für das Standard-Timeout
 * @returns {Promise<string>} HTML-Inhalt
 */
function fetchHtml(url, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(chunks.join('')));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout (${timeoutMs}ms)`));
    });
    req.on('error', reject);
  });
}

/**
 * Entfernt HTML-Tags und kollabiert Whitespace.
 *
 * @param {string} html
 * @returns {string}
 */
function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Dekodiert HTML-Entities (&amp; &lt; &gt; &quot; &#xNN; &#NN;) in einem
 * einzigen Durchlauf, um doppeltes Dekodieren zu vermeiden.
 *
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  return String(str || '').replace(/&(?:amp|lt|gt|quot|#x([0-9a-fA-F]+)|#(\d+));/g,
    (match, hex, dec) => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      if (dec !== undefined) return String.fromCharCode(parseInt(dec, 10));
      switch (match) {
        case '&amp;':  return '&';
        case '&lt;':   return '<';
        case '&gt;':   return '>';
        case '&quot;': return '"';
        default:       return match;
      }
    }
  );
}

/**
 * Leitet aus Titel + rawType den wahrscheinlichen Vorgangstyp ab.
 * Identisch zur Heuristik in `portalNormalizationService`.
 *
 * @param {string} title
 * @param {string} rawType
 * @returns {string}
 */
function inferType(title, rawType) {
  const s = ((title || '') + ' ' + (rawType || '')).toLowerCase();
  if (s.includes('änderungsantrag')) return 'Änderungsantrag';
  if (s.includes('antrag')) return 'Antrag';
  if (s.includes('anfrage') || s.includes('kleine anfrage') || s.includes('große anfrage')) return 'Anfrage';
  if (s.includes('beschluss') || s.includes('beschlüsse')) return 'Beschluss';
  if (s.includes('antwort') || s.includes('stellungnahme') || s.includes('bericht') || s.includes('mitteilung')) return 'Verwaltungsantwort';
  if (s.includes('protokoll') || s.includes('niederschrift')) return 'Protokoll';
  return 'Sonstige';
}

/**
 * Mapping vom internen `type` (Schema-Enum) auf die feinere
 * `referenceType`-Klassifikation für Antragsschreiber.
 *
 * @param {string} type
 * @returns {string}
 */
function mapReferenceType(type) {
  switch (type) {
    case 'Antrag':
    case 'Änderungsantrag':    return 'Antrag';
    case 'Anfrage':            return 'Anfrage';
    case 'Beschluss':          return 'Beschluss';
    case 'Verwaltungsantwort': return 'Verwaltungsantwort';
    case 'Protokoll':          return 'Protokollnotiz';
    default:                   return 'verwandtes Thema';
  }
}

/** Heuristik: enthält der Suchbegriff einen Straßen-/Wegnamen? */
const STREET_RE   = /(?:straße|strasse|str\.?\b|\bplatz\b|\ballee\b|\bweg\b|\bgasse\b|\bring\b|\bufer\b|\bdamm\b|\bchaussee\b|\bbrücke\b|\bbruecke\b)/i;
/** Heuristik: enthält der Suchbegriff einen Stadtbezirks-/Gebietshinweis? */
const DISTRICT_RE = /\b(stadtbezirk|bezirk|stadtteil|ortsteil|quartier|viertel)\b/i;

/**
 * Klassifiziert die Art eines Suchbegriffs (Straße / Bezirk / nur Thema).
 *
 * @param {string} term
 * @returns {'street'|'district'|'topic-only'}
 */
function classifyTermLocation(term) {
  const t = String(term || '');
  if (STREET_RE.test(t))   return 'street';
  if (DISTRICT_RE.test(t)) return 'district';
  return 'topic-only';
}

/**
 * Reichert einen rohen Treffer um die Felder des erweiterten
 * Referenzmodells an: `referenceType`, `reason`, `locationMatch`,
 * `topicMatch`, `streetHints`, `areaHints`.
 *
 * @param {object} raw
 * @param {string} matchedTerm Suchbegriff, der zum Treffer geführt hat
 * @returns {object}
 */
function enrichWithReferenceModel(raw, matchedTerm) {
  const title    = raw.title   || '';
  const snippet  = raw.snippet || '';
  const haystack = `${title} ${snippet}`.toLowerCase();
  const term     = String(matchedTerm || '').trim();
  const termLower = term.toLowerCase();

  const inTitle   = !!term && title.toLowerCase().includes(termLower);
  const inSnippet = !!term && snippet.toLowerCase().includes(termLower);

  const topicMatch    = (inTitle || inSnippet) ? [term] : [];
  const locationMatch = term ? classifyTermLocation(term) : null;

  let reason = null;
  if (term) {
    if (inTitle)        reason = `Suchbegriff „${term}" im Titel.`;
    else if (inSnippet) reason = `Suchbegriff „${term}" im Auszug.`;
    else                reason = `Treffer der Portalsuche zu „${term}".`;
  }
  if (reason && reason.length > 240) reason = reason.substring(0, 237) + '…';

  const streetHints = [];
  const areaHints   = [];
  const streetMatch = haystack.match(/\b[a-zäöüß-]+(?:straße|strasse|str\.?|platz|allee|weg|gasse|ring|ufer|damm|chaussee|brücke|bruecke)\b/gi) || [];
  for (const s of streetMatch) {
    const v = s.trim();
    if (v && !streetHints.includes(v)) streetHints.push(v);
  }
  const areaMatch = haystack.match(/\b(?:stadtbezirk|stadtteil|ortsteil|bezirk)\s+[a-zäöüß-][a-zäöüß0-9 -]{2,40}/gi) || [];
  for (const s of areaMatch) {
    const v = s.trim();
    if (v && !areaHints.includes(v)) areaHints.push(v);
  }

  const inferredType  = inferType(title, raw.rawType || '');
  const referenceType = mapReferenceType(inferredType);

  return {
    ...raw,
    referenceType,
    reason,
    locationMatch,
    topicMatch,
    streetHints,
    areaHints
  };
}

/**
 * Normalisiert eine Stadt für Whitelist-Vergleiche im Provider:
 *   Kleinbuchstaben, Umlaute → ae/oe/ue/ss, sonst alphanumerisch.
 *
 * @param {string} city
 * @returns {string}
 */
function normCityKey(city) {
  if (!city) return '';
  return String(city)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  fetchHtml,
  stripTags,
  decodeEntities,
  inferType,
  mapReferenceType,
  classifyTermLocation,
  enrichWithReferenceModel,
  normCityKey
};
