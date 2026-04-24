'use strict';

/**
 * Provider für die Bonner Bürgerinfo (Allris-/SessionNet-basiertes
 * Ratsinformationssystem der Stadt Bonn).
 *
 * Öffentliche Suche:
 *   https://www2.bonn.de/bo_ris/ws_buergerinfo/buergerinfo.asp
 *
 * Such-Endpunkt (GET):
 *   https://www2.bonn.de/bo_ris/ws_buergerinfo/suche.asp
 *   Parameter:
 *     - SUCH    – Suchbegriff
 *     - SUCH_OBJ – 'V' (Vorlagen/Drucksachen)
 *     - SUCHMAX – Trefferlimit
 *
 * URLs sind hartkodiert (kein User-Input → keine SSRF-Naht).
 *
 * @module server/political-context/providers/bonnAllrisProvider
 */

const {
  fetchHtml,
  stripTags,
  decodeEntities,
  enrichWithReferenceModel,
  normCityKey
} = require('./_portalUtils.js');

const PORTAL_BASE = 'https://www2.bonn.de';
const SEARCH_PATH = '/bo_ris/ws_buergerinfo/suche.asp';

/** Maximale Anzahl Treffer pro Suchanfrage. */
const MAX_RESULTS = 20;

/** Provider-Kürzel für Logging und `meta.providerKey`. */
const PROVIDER_KEY = 'bonn-allris';

/**
 * Gibt true zurück, wenn dieser Provider die Stadt unterstützt.
 *
 * @param {string} city
 * @returns {boolean}
 */
function supportsCity(city) {
  return normCityKey(city) === 'bonn';
}

/**
 * Baut die Such-URL.
 *
 * @param {string} term
 * @returns {string}
 */
function buildSearchUrl(term) {
  const params = new URLSearchParams({
    SUCH: term,
    SUCH_OBJ: 'V',
    SUCHMAX: String(MAX_RESULTS)
  });
  return `${PORTAL_BASE}${SEARCH_PATH}?${params.toString()}`;
}

/**
 * Parst die HTML-Trefferliste.  Die Bonner Bürgerinfo (Allris/SessionNet)
 * gibt Treffer in einer Tabelle aus; jede Zeile enthält einen Link auf
 * die Vorgangsdetails (vo020.asp / vo0050.asp), Datum, Gremium und
 * Drucksachennummer.
 *
 * @param {string} html
 * @returns {object[]}
 */
function parseResults(html) {
  const results = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    // Detail-Link: typischerweise vo020.asp / vo0050.asp / to010.asp
    const linkMatch = row.match(/<a\s+href="([^"]*(?:vo0\d+|to0\d+|si0\d+)\.asp[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const rawTitle = decodeEntities(stripTags(linkMatch[2])).trim();
    if (!rawTitle || rawTitle.length < 5) continue;

    const url = href.startsWith('http')
      ? href
      : `${PORTAL_BASE}/bo_ris/ws_buergerinfo/${href.replace(/^\.?\/?/, '')}`;

    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    // eslint-disable-next-line no-cond-assign
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(decodeEntities(stripTags(cellMatch[1])).trim());
    }

    let date = null;
    const datePattern = /\b(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})\b/;
    for (const cell of cells) {
      const dm = cell.match(datePattern);
      if (dm) { date = dm[1]; break; }
    }

    let gremium = null;
    const gremiumKeywords = /rat|ausschuss|bezirk|gremium|kommission|beirat|hauptausschuss/i;
    for (const cell of cells) {
      if (gremiumKeywords.test(cell) && cell.length < 120 && cell !== rawTitle) {
        gremium = cell;
        break;
      }
    }

    let number = null;
    const numberPattern = /\b(?:DS\s*|Drs\.\s*|Drs\s*)?(\d{4}[-/]\d{2,6}|\d{2,6}[-/]\d{4})\b/;
    for (const cell of cells) {
      const nm = cell.match(numberPattern);
      if (nm) { number = nm[0].trim(); break; }
    }

    const snippet = cells.filter((c) => c && c !== rawTitle && c.length > 10).slice(0, 3).join(' | ') || null;

    results.push({
      title: rawTitle,
      url,
      date,
      gremium,
      number,
      snippet: snippet ? snippet.substring(0, 300) : null,
      rawType: cells.find((c) => /antrag|anfrage|beschluss|protokoll|antwort|vorlage|mitteilung/i.test(c)) || ''
    });
  }

  return results.slice(0, MAX_RESULTS);
}

/**
 * Durchsucht die Bonner Bürgerinfo nach politischen Vorgängen.
 *
 * @param {object}   params
 * @param {string[]} params.searchTerms – Suchbegriffe (je ein HTTP-Request)
 * @returns {Promise<object[]>}
 */
async function search(params) {
  const { searchTerms = [] } = params || {};
  if (!searchTerms.length) return [];

  const allResults = [];

  for (const term of searchTerms) {
    if (!term || typeof term !== 'string' || !term.trim()) continue;
    const trimmed = term.trim();
    try {
      const url = buildSearchUrl(trimmed);
      const html = await fetchHtml(url);
      const results = parseResults(html).map((r) => enrichWithReferenceModel(r, trimmed));
      allResults.push(...results);
    } catch (err) {
      // Logging ohne Suchbegriff im Klartext (Datenschutz).
      console.warn(`[${PROVIDER_KEY}] Suche fehlgeschlagen: ${err.message}`);
    }
  }

  return allResults;
}

module.exports = {
  _key: PROVIDER_KEY,
  supportsCity,
  search,
  parseResults,
  buildSearchUrl
};
