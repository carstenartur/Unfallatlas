'use strict';

/**
 * Provider für das Hannover SIM-Ratsinformationssystem.
 *
 * Kapselt die Such-URL, Parameter und HTML-Extraktion des Hannoverer Portals.
 * Das Portal basiert auf der IBM-Lotus-Notes-Web-Oberfläche des
 * Sitzungsmanagement-Systems (SIM) der Stadt Hannover.
 *
 * Öffentliche Suche:
 *   https://e-government.hannover-stadt.de/lhhsimwebre.nsf/ds_suchformular
 *
 * Such-Endpunkt (GET):
 *   https://e-government.hannover-stadt.de/lhhsimwebre.nsf/dsSearchView
 *   Parameter: Query (Suchbegriff), SearchOrder=4 (Relevanz)
 *
 * @module server/political-context/providers/hannoverSimProvider
 */

const https = require('https');

const PORTAL_BASE = 'https://e-government.hannover-stadt.de';
const SEARCH_PATH = '/lhhsimwebre.nsf/dsSearchView';

// Timeout für HTTP-Anfragen in ms
const REQUEST_TIMEOUT_MS = parseInt(process.env.PORTAL_SEARCH_TIMEOUT_MS || '10000', 10);

// Maximale Anzahl Treffer pro Suchanfrage
const MAX_RESULTS = 20;

/**
 * @typedef {object} RawResult
 * @property {string}      title
 * @property {string}      url
 * @property {string|null} date
 * @property {string|null} gremium
 * @property {string|null} number
 * @property {string|null} snippet
 * @property {string}      rawType
 * @property {string}      [referenceType]   – Folge-PR A: feinere fachliche Klassifikation
 * @property {string|null} [reason]          – Folge-PR A: kurze Begründung
 * @property {string|null} [locationMatch]   – Folge-PR A: 'street'|'district'|'bbox'|'topic-only'
 * @property {string[]}    [topicMatch]      – Folge-PR A: getroffene Suchbegriffe
 * @property {string[]}    [streetHints]     – Folge-PR A: erkannte Straßennamen
 * @property {string[]}    [areaHints]       – Folge-PR A: erkannte Stadtbezirke
 */

/**
 * Gibt true zurück – dieser Provider unterstützt nur Hannover.
 *
 * @param {string} city
 * @returns {boolean}
 */
function supportsCity(city) {
  if (!city) return false;
  const n = city.toLowerCase().replace(/ä/g, 'ae').replace(/[^a-z0-9]/g, '');
  return n === 'hannover';
}

/**
 * Führt eine einzelne HTTP-GET-Anfrage durch.
 * Nutzt das eingebaute Node.js-https-Modul (keine externen Abhängigkeiten).
 *
 * @param {string} url
 * @returns {Promise<string>} HTML-Inhalt
 */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} für ${url}`));
      }
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(chunks.join('')));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout (${REQUEST_TIMEOUT_MS}ms) für ${url}`));
    });
    req.on('error', reject);
  });
}

/**
 * Baut die Such-URL für das Hannover-SIM-Portal.
 *
 * @param {string} term
 * @returns {string}
 */
function buildSearchUrl(term) {
  const params = new URLSearchParams({
    SearchView: '',
    Query: term,
    SearchOrder: '4',
    SearchMax: String(MAX_RESULTS),
    SearchWV: 'true'
  });
  return `${PORTAL_BASE}${SEARCH_PATH}?${params.toString()}`;
}

/**
 * Extrahiert den Textinhalt aus einem HTML-String (entfernt Tags).
 *
 * @param {string} html
 * @returns {string}
 */
function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Dekodiert HTML-Entities (&amp; &lt; &gt; &quot; &#xNN; &#NN;) in einem
 * einzigen Durchlauf, um doppeltes Dekodieren zu vermeiden
 * (z. B. &amp;lt; → &lt; → < bei sequentiellem Ersetzen).
 *
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  return str.replace(/&(?:amp|lt|gt|quot|#x([0-9a-fA-F]+)|#(\d+));/g,
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
 * Leitet aus einem Titelstring den wahrscheinlichen Vorgangstyp ab.
 *
 * @param {string} title
 * @param {string} rawType
 * @returns {string}
 */
function inferType(title, rawType) {
  const s = (title + ' ' + rawType).toLowerCase();
  if (s.includes('änderungsantrag')) return 'Änderungsantrag';
  if (s.includes('antrag')) return 'Antrag';
  if (s.includes('anfrage')) return 'Anfrage';
  if (s.includes('beschluss') || s.includes('beschlüsse')) return 'Beschluss';
  if (s.includes('antwort') || s.includes('stellungnahme') || s.includes('bericht')) return 'Verwaltungsantwort';
  if (s.includes('protokoll') || s.includes('niederschrift')) return 'Protokoll';
  return 'Sonstige';
}

/**
 * Mapping vom internen `type` (Schema-Enum) auf die feinere `referenceType`-
 * Klassifikation für Antragsschreiber.  Folge-PR C verfeinert dies anhand
 * von Doc-Typ + Titel-Heuristik + Gremium; hier liefern wir nur die
 * grundlegende Zuordnung, damit das Feld stets präsent und sinnvoll ist.
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

/** Heuristik: enthält der Suchbegriff einen Straßen-/Wegnamen?
 *  Hinweis: kein führendes \b, weil deutsche Komposita (z. B. „Limmerstraße")
 *  ohne Wortgrenze vor „straße" stehen. */
const STREET_RE = /(?:straße|strasse|str\.?\b|\bplatz\b|\ballee\b|\bweg\b|\bgasse\b|\bring\b|\bufer\b|\bdamm\b|\bchaussee\b|\bbrücke\b|\bbruecke\b)/i;
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
 * Reicheres Referenzmodell (Folge-PR A): ergänzt einen rohen Treffer um
 * `referenceType`, `reason`, `locationMatch`, `topicMatch`, `streetHints`
 * und `areaHints`.  Die Heuristik bleibt bewusst einfach; spätere PRs
 * (B = Variantensuche, C = Klassifikator) verfeinern sie.
 *
 * @param {RawResult} raw
 * @param {string}    matchedTerm – Suchbegriff, mit dem der Treffer geliefert wurde
 * @returns {RawResult}
 */
function enrichWithReferenceModel(raw, matchedTerm) {
  const title   = raw.title   || '';
  const snippet = raw.snippet || '';
  const haystack = `${title} ${snippet}`.toLowerCase();
  const term = String(matchedTerm || '').trim();
  const termLower = term.toLowerCase();

  const inTitle   = !!term && title.toLowerCase().includes(termLower);
  const inSnippet = !!term && snippet.toLowerCase().includes(termLower);

  const topicMatch = (inTitle || inSnippet) ? [term] : [];
  const locationMatch = term ? classifyTermLocation(term) : null;

  // Reason – kurz, deutsch, ohne PII (nur der Suchbegriff selbst).
  let reason = null;
  if (term) {
    if (inTitle)        reason = `Suchbegriff „${term}" im Titel.`;
    else if (inSnippet) reason = `Suchbegriff „${term}" im Auszug.`;
    else                reason = `Treffer der Portalsuche zu „${term}".`;
  }
  if (reason && reason.length > 240) reason = reason.substring(0, 237) + '…';

  // Straßen-/Bezirkshinweise aus Titel + Snippet (Heuristik).
  const streetHints = [];
  const areaHints   = [];
  const streetMatch  = haystack.match(/\b[a-zäöüß-]+(?:straße|strasse|str\.?|platz|allee|weg|gasse|ring|ufer|damm|chaussee|brücke|bruecke)\b/gi) || [];
  for (const s of streetMatch) {
    const v = s.trim();
    if (v && !streetHints.includes(v)) streetHints.push(v);
  }
  const areaMatch = haystack.match(/\b(?:stadtbezirk|stadtteil|ortsteil)\s+[a-zäöüß-][a-zäöüß0-9 -]{2,40}/gi) || [];
  for (const s of areaMatch) {
    const v = s.trim();
    if (v && !areaHints.includes(v)) areaHints.push(v);
  }

  // referenceType: über inferType auf Schema-Enum gemappt
  const inferredType = inferType(title, raw.rawType || '');
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
 * Parst die HTML-Trefferliste des Hannover-SIM-Portals.
 *
 * Das Portal gibt Treffer in einer Tabelle (oder als div-Liste) aus.
 * Relevante Felder je Treffer:
 *   - Link + Titel (im <a>-Tag)
 *   - Datum (Spalte oder Metatext)
 *   - Gremium
 *   - Drucksachennummer
 *
 * @param {string} html
 * @param {string} searchTerm
 * @returns {RawResult[]}
 */
function parseResults(html, searchTerm) {
  const results = [];

  // Treffer-Zeilen: im SIM-Portal sind Ergebnisse als <tr>-Elemente in einer
  // Tabelle strukturiert.  Wir extrahieren alle <a href=...>-Links, die auf
  // Dokumentenseiten zeigen, und die umgebenden Tabellenzeilen.
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    // Link zur Dokumentenseite (enthält '/lhh' oder 'nsf/')
    const linkMatch = row.match(/<a\s+href="([^"]*(?:nsf|lhh)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const rawTitle = decodeEntities(stripTags(linkMatch[2])).trim();

    if (!rawTitle || rawTitle.length < 5) continue;

    // Relative URLs zu absoluten machen
    const url = href.startsWith('http') ? href : `${PORTAL_BASE}${href.startsWith('/') ? '' : '/'}${href}`;

    // Zellen der Tabellenzeile extrahieren
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    // eslint-disable-next-line no-cond-assign
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(decodeEntities(stripTags(cellMatch[1])).trim());
    }

    // Datum: ISO-ähnlich oder deutsches Format
    let date = null;
    const datePattern = /\b(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})\b/;
    for (const cell of cells) {
      const dm = cell.match(datePattern);
      if (dm) { date = dm[1]; break; }
    }

    // Gremium: Zelle, die typische Gremienbegriffe enthält
    let gremium = null;
    const gremiumKeywords = /rat|ausschuss|bezirk|stadtbezirk|gremium|kommission|arbeitsgruppe|konferenz/i;
    for (const cell of cells) {
      if (gremiumKeywords.test(cell) && cell.length < 120) {
        gremium = cell;
        break;
      }
    }

    // Nummer: Drucksachen- oder Vorgangsnummer (z. B. "2023-01234" oder "DS 1234/2023")
    let number = null;
    const numberPattern = /\b(?:DS\s*|Drs\.\s*|Drs\s*)?(\d{4}[-/]\d{3,6}|\d{3,6}[-/]\d{4})\b/;
    for (const cell of cells) {
      const nm = cell.match(numberPattern);
      if (nm) { number = nm[0].trim(); break; }
    }

    // Snippet: alle Zellen zusammenführen
    const snippet = cells.filter(c => c && c !== rawTitle && c.length > 10).slice(0, 3).join(' | ') || null;

    results.push({
      title: rawTitle,
      url,
      date,
      gremium,
      number,
      snippet: snippet ? snippet.substring(0, 300) : null,
      rawType: cells.find(c => /antrag|anfrage|beschluss|protokoll|antwort/i.test(c)) || ''
    });
  }

  return results.slice(0, MAX_RESULTS);
}

/**
 * Durchsucht das Hannover-SIM-Portal nach politischen Vorgängen.
 *
 * @param {object}   params
 * @param {string[]} params.searchTerms   – Suchbegriffe (je ein HTTP-Request)
 * @param {string}   [params.city]        – Stadt (muss 'Hannover' sein)
 * @returns {Promise<RawResult[]>}
 */
async function search(params) {
  const { searchTerms = [] } = params || {};
  if (!searchTerms.length) return [];

  const allResults = [];

  for (const term of searchTerms) {
    if (!term || typeof term !== 'string' || !term.trim()) continue;
    try {
      const trimmed = term.trim();
      const url = buildSearchUrl(trimmed);
      const html = await fetchHtml(url);
      const results = parseResults(html, trimmed)
        .map((r) => enrichWithReferenceModel(r, trimmed));
      allResults.push(...results);
    } catch (err) {
      // Einzelne Suchanfragen sollen andere nicht blockieren
      console.warn(`[hannoverSimProvider] Suche nach "${term}" fehlgeschlagen:`, err.message);
    }
  }

  return allResults;
}

module.exports = { _key: 'hannover-sim', supportsCity, search, enrichWithReferenceModel, mapReferenceType, classifyTermLocation };
