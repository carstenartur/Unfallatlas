'use strict';

/**
 * Provider für Hamburg: Parldok der Hamburgischen Bürgerschaft sowie die
 * Allris-Instanzen der sieben Bezirksversammlungen.
 *
 * Parldok-Suche (Bürgerschaft):
 *   https://www.buergerschaft-hh.de/parldok/formalkriterien
 *
 * Bezirks-Allris-Endpunkte (Hamburg-Mitte, Altona, Eimsbüttel, Hamburg-Nord,
 * Wandsbek, Bergedorf, Harburg) werden hartkodiert hinterlegt.  URLs sind
 * ausschließlich im Modul fixiert (kein User-Input → keine SSRF-Naht).
 *
 * @module server/political-context/providers/hamburgParldokProvider
 */

const {
  fetchHtml,
  stripTags,
  decodeEntities,
  enrichWithReferenceModel,
  normCityKey
} = require('./_portalUtils.js');

const PROVIDER_KEY = 'hamburg-parldok';

/** Maximale Anzahl Treffer pro Endpunkt-Suchanfrage. */
const MAX_RESULTS_PER_ENDPOINT = 15;

/**
 * Liste fest hinterlegter Such-Endpunkte für Hamburg.
 * Jeder Eintrag liefert eine `buildUrl`-Funktion für eine GET-Suche.
 */
const HAMBURG_ENDPUNKTE = [
  {
    key:  'parldok',
    label: 'Hamburgische Bürgerschaft – Parldok',
    base: 'https://www.buergerschaft-hh.de',
    buildUrl(term) {
      const params = new URLSearchParams({
        suchbegriff: term,
        max: String(MAX_RESULTS_PER_ENDPOINT)
      });
      return `${this.base}/parldok/formalkriterien?${params.toString()}`;
    }
  }
  // Bezirks-Allris-Endpunkte können hier ergänzt werden, z. B.:
  // {
  //   key:  'altona-allris',
  //   label: 'Bezirksversammlung Altona – Allris',
  //   base: 'https://sitzungsdienst-altona.hamburg.de',
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
  return normCityKey(city) === 'hamburg';
}

/**
 * Parst eine HTML-Trefferliste im Parldok-/Allris-Stil.
 * Parldok liefert Treffer als Tabelle oder als Liste von <li>-Elementen.
 *
 * @param {string} html
 * @param {string} portalBase Absolute Basis-URL des Portals
 * @returns {object[]}
 */
function parseResults(html, portalBase) {
  const results = [];
  const seen = new Set();

  // 1) Tabellenzeilen (klassisches Parldok / Allris)
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const block = rowMatch[1];
    pushFromBlock(block);
  }

  // 2) Listenelemente (neuere Parldok-Trefferseiten)
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  // eslint-disable-next-line no-cond-assign
  while ((liMatch = liRegex.exec(html)) !== null) {
    const block = liMatch[1];
    pushFromBlock(block);
  }

  return results.slice(0, MAX_RESULTS_PER_ENDPOINT);

  function pushFromBlock(block) {
    const linkMatch = block.match(/<a\s+href="([^"]*(?:Drucksache|drucksache|vo0\d+|to0\d+|si0\d+|parldok)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) return;

    const href = linkMatch[1];
    const rawTitle = decodeEntities(stripTags(linkMatch[2])).trim();
    if (!rawTitle || rawTitle.length < 5) return;

    const url = href.startsWith('http')
      ? href
      : `${portalBase}${href.startsWith('/') ? '' : '/'}${href}`;

    if (seen.has(url)) return;
    seen.add(url);

    const cells = [];
    const cellRegex = /<(?:td|span|div|p)[^>]*>([\s\S]*?)<\/(?:td|span|div|p)>/gi;
    let cellMatch;
    // eslint-disable-next-line no-cond-assign
    while ((cellMatch = cellRegex.exec(block)) !== null) {
      const v = decodeEntities(stripTags(cellMatch[1])).trim();
      if (v) cells.push(v);
    }

    let date = null;
    const datePattern = /\b(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})\b/;
    for (const cell of cells) {
      const dm = cell.match(datePattern);
      if (dm) { date = dm[1]; break; }
    }

    let gremium = null;
    const gremiumKeywords = /(?:bürgerschaft|buergerschaft|bezirksversammlung|ausschuss|plenum|hauptausschuss|fachausschuss)/i;
    for (const cell of cells) {
      if (gremiumKeywords.test(cell) && cell.length < 140 && cell !== rawTitle) {
        gremium = cell;
        break;
      }
    }

    let number = null;
    // Parldok-Drucksachen: "21/12345"; Allris: "1234/2024"
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
      rawType: cells.find((c) => /antrag|anfrage|beschluss|protokoll|antwort|drucksache|mitteilung|bericht|gesetzentwurf/i.test(c)) || ''
    });
  }
}

/**
 * Durchsucht alle hinterlegten Hamburger Endpunkte.
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

    for (const ep of HAMBURG_ENDPUNKTE) {
      try {
        const url = ep.buildUrl(trimmed);
        const html = await fetchHtml(url);
        const results = parseResults(html, ep.base).map((r) => enrichWithReferenceModel(r, trimmed));
        allResults.push(...results);
      } catch (err) {
        // Datenschutz: kein Suchbegriff im Klartext.
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
  HAMBURG_ENDPUNKTE
};
