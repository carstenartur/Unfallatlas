'use strict';

/** Provider für die Bonner Bürgerinfo (ALLRIS / Sitzung Online). */

const {
  fetchHtml,
  stripTags,
  decodeEntities,
  enrichWithReferenceModel,
  normCityKey
} = require('./_portalUtils.js');

const PORTAL_BASE = 'https://www.bonn.sitzung-online.de';
const SEARCH_PATH = '/public/tr010';
const DETAIL_DIR = '/public/';

const LEGACY_PORTAL_BASE = 'https://www2.bonn.de';
const LEGACY_SEARCH_PATH = '/bo_ris/ws_buergerinfo/suche.asp';
const LEGACY_DETAIL_DIR = '/bo_ris/ws_buergerinfo/';

const MAX_RESULTS = 20;
const PROVIDER_KEY = 'bonn-allris';

function supportsCity(city) {
  return normCityKey(city) === 'bonn';
}

function buildSearchUrl(term) {
  const params = new URLSearchParams({ q: term });
  return `${PORTAL_BASE}${SEARCH_PATH}?${params.toString()}`;
}

function buildLegacySearchUrl(term) {
  const params = new URLSearchParams({
    SUCH: term,
    SUCH_OBJ: 'V',
    SUCHMAX: String(MAX_RESULTS)
  });
  return `${LEGACY_PORTAL_BASE}${LEGACY_SEARCH_PATH}?${params.toString()}`;
}

function buildSearchRequests(term) {
  return [
    { url: buildSearchUrl(term), portalBase: PORTAL_BASE, detailDir: DETAIL_DIR, label: 'sitzung-online' },
    { url: buildLegacySearchUrl(term), portalBase: LEGACY_PORTAL_BASE, detailDir: LEGACY_DETAIL_DIR, label: 'legacy-buergerinfo' }
  ];
}

function normalizeHref(href, portalBase, detailDir) {
  const decoded = decodeEntities(String(href || '')).trim();
  if (/^https?:\/\//i.test(decoded)) return decoded;
  if (decoded.startsWith('/')) return `${portalBase}${decoded}`;
  return `${portalBase}${detailDir}${decoded.replace(/^\.?\/?/, '')}`;
}

function collectCells(row) {
  const cells = [];
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let cellMatch;
  // eslint-disable-next-line no-cond-assign
  while ((cellMatch = cellRegex.exec(row)) !== null) {
    cells.push(decodeEntities(stripTags(cellMatch[1])).trim());
  }
  return cells.filter(Boolean);
}

function isUsableTitle(value) {
  const text = String(value || '').trim();
  if (text.length < 5) return false;
  if (/^(anzeigen|details?|mehr|öffnen|oeffnen|open|vorlage|sitzung|tagesordnungspunkt)$/i.test(text)) return false;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) return false;
  if (/^(?:DS\s*|Drs\.\s*|Drs\s*)?\d{2,6}[-/]\d{2,6}$/i.test(text)) return false;
  return true;
}

function pickTitle(linkText, cells) {
  return [linkText, ...cells].find(isUsableTitle) || '';
}

function parseResults(html, options = {}) {
  const results = [];
  const portalBase = options.portalBase || PORTAL_BASE;
  const detailDir = options.detailDir || DETAIL_DIR;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];
    const linkMatch = row.match(/<a\s+[^>]*href\s*=\s*(['"])([^'"]*(?:\/?public\/)?(?:vo|to|si|kp)0?\d+(?:\.asp)?(?:\?[^'"]*)?)[^'"]*\1[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const href = linkMatch[2];
    const rawLinkText = decodeEntities(stripTags(linkMatch[3])).trim();
    const cells = collectCells(row);
    const rawTitle = pickTitle(rawLinkText, cells);
    if (!rawTitle) continue;
    const url = normalizeHref(href, portalBase, detailDir);

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
    const numberPattern = /\b(?:DS\s*|Drs\.\s*|Drs\s*|Drucksachen(?:nr\.?|nummer)\s*)?(\d{2,6}[-/]\d{2,6}|\d{4}[-/]\d{2,6}|\d{2,6}[-/]\d{4})\b/i;
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

async function search(params) {
  const { searchTerms = [] } = params || {};
  if (!searchTerms.length) return [];
  const allResults = [];
  for (const term of searchTerms) {
    if (!term || typeof term !== 'string' || !term.trim()) continue;
    const trimmed = term.trim();
    for (const request of buildSearchRequests(trimmed)) {
      try {
        const html = await fetchHtml(request.url);
        const results = parseResults(html, request).map((r) => enrichWithReferenceModel(r, trimmed));
        if (results.length > 0 || request.label === 'legacy-buergerinfo') {
          allResults.push(...results);
          break;
        }
      } catch (err) {
        console.warn(`[${PROVIDER_KEY}] ${request.label} Suche fehlgeschlagen: ${err.message}`);
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
  buildSearchUrl,
  buildLegacySearchUrl,
  buildSearchRequests
};
