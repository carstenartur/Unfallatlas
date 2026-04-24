'use strict';

/**
 * Provider für Berlin: Pardok/RIS des Abgeordnetenhauses sowie die
 * Allris-Instanzen der Berliner Bezirke (BVV-Ratsinformationssysteme).
 *
 * Die landesweite Suche im Pardok bildet die Basis; zusätzlich kann eine
 * konfigurierbare Liste von Bezirks-Allris-Endpunkten abgefragt werden.
 *
 * Pardok-Suche (Abgeordnetenhaus):
 *   https://pardok.parlament-berlin.de/starweb/adis/citat/VT/19/Suche.html
 *
 * Bezirks-Allris-Endpunkte werden hartkodiert geführt (kein User-Input
 * → keine SSRF-Naht).  Erweiterbar im konstanten `BEZIRKS_ENDPUNKTE`.
 *
 * @module server/political-context/providers/berlinAllrisProvider
 */

const {
  fetchHtml,
  stripTags,
  decodeEntities,
  enrichWithReferenceModel,
  normCityKey
} = require('./_portalUtils.js');

const PROVIDER_KEY = 'berlin-allris';

/** Maximale Anzahl Treffer pro Endpunkt-Suchanfrage. */
const MAX_RESULTS_PER_ENDPOINT = 15;

/**
 * Liste fest hinterlegter Such-Endpunkte für Berlin.
 * Jeder Eintrag liefert eine `buildUrl`-Funktion, die aus dem Suchbegriff
 * die vollständige URL erzeugt.  URLs sind ausschließlich hartkodiert.
 */
const BEZIRKS_ENDPUNKTE = [
  {
    key:  'pardok',
    label: 'Abgeordnetenhaus Berlin – Pardok',
    base: 'https://pardok.parlament-berlin.de',
    buildUrl(term) {
      const params = new URLSearchParams({
        SUCH: term,
        SUCHMAX: String(MAX_RESULTS_PER_ENDPOINT)
      });
      return `${this.base}/starweb/adis/citat/VT/19/Suche.html?${params.toString()}`;
    }
  }
  // Bezirks-Allris-Endpunkte können hier ergänzt werden.  Beispiel-Schema:
  // {
  //   key:  'mitte-allris',
  //   label: 'BVV Mitte – Allris',
  //   base: 'https://www.berlin.de',
  //   buildUrl(term) { ... }
  // }
];

/**
 * Gibt true zurück, wenn dieser Provider die Stadt unterstützt.
 *
 * @param {string} city
 * @returns {boolean}
 */
function supportsCity(city) {
  return normCityKey(city) === 'berlin';
}

/**
 * Parst eine HTML-Trefferliste im Pardok-/Allris-Stil.
 *
 * Sowohl Pardok als auch Berliner Bezirks-Allris-Instanzen liefern
 * Treffer in Tabellenform mit einem Detail-Link je Zeile.
 *
 * @param {string} html
 * @param {string} portalBase Absolute Basis-URL des Portals
 * @returns {object[]}
 */
function parseResults(html, portalBase) {
  const results = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    // Pardok-Detail: .Document oder .DocumentDetail; Allris: vo0?.asp / si0?.asp
    const linkMatch = row.match(/<a\s+href="([^"]*(?:Document|vo0\d+|to0\d+|si0\d+|drucksache)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const rawTitle = decodeEntities(stripTags(linkMatch[2])).trim();
    if (!rawTitle || rawTitle.length < 5) continue;

    const url = href.startsWith('http')
      ? href
      : `${portalBase}${href.startsWith('/') ? '' : '/'}${href}`;

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
    const gremiumKeywords = /(?:abgeordnetenhaus|bvv|bezirksverordnetenversammlung|ausschuss|plenum|bezirksamt|hauptausschuss)/i;
    for (const cell of cells) {
      if (gremiumKeywords.test(cell) && cell.length < 140 && cell !== rawTitle) {
        gremium = cell;
        break;
      }
    }

    let number = null;
    // Pardok-Drucksachennummern: "Drs 19/12345"; Allris: "1234/2024"
    const numberPattern = /\b(?:Drs\.?\s*|DS\s*)?(\d{2}\/\d{3,6}|\d{4}[-/]\d{3,6}|\d{3,6}[-/]\d{4})\b/;
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
      rawType: cells.find((c) => /antrag|anfrage|beschluss|protokoll|antwort|vorlage|mitteilung|gesetzentwurf/i.test(c)) || ''
    });
  }

  return results.slice(0, MAX_RESULTS_PER_ENDPOINT);
}

/**
 * Durchsucht alle hinterlegten Berliner Endpunkte.
 *
 * @param {object}   params
 * @param {string[]} params.searchTerms
 * @returns {Promise<object[]>}
 */
async function search(params) {
  const { searchTerms = [] } = params || {};
  if (!searchTerms.length) return [];

  const allResults = [];

  for (const term of searchTerms) {
    if (!term || typeof term !== 'string' || !term.trim()) continue;
    const trimmed = term.trim();

    for (const ep of BEZIRKS_ENDPUNKTE) {
      try {
        const url = ep.buildUrl(trimmed);
        const html = await fetchHtml(url);
        const results = parseResults(html, ep.base).map((r) => enrichWithReferenceModel(r, trimmed));
        allResults.push(...results);
      } catch (err) {
        // Datenschutz: kein Suchbegriff im Log, nur Endpoint-Key + Fehlermeldung.
        console.warn(`[${PROVIDER_KEY}] Endpunkt "${ep.key}" fehlgeschlagen: ${err.message}`);
      }
    }
  }

  return allResults;
}

module.exports = {
  _key: PROVIDER_KEY,
  supportsCity,
  search,
  parseResults,
  BEZIRKS_ENDPUNKTE
};
