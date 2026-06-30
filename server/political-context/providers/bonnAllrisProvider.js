'use strict';

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

function buildSitzungOnlineSearchUrl(term) {
  const params = new URLSearchParams({ q: term });
  return `${PORTAL_BASE}${SEARCH_PATH}?${params.toString()}`;
}

function buildSearchUrl(term) {
  const params = new URLSearchParams({
    SUCH: term,
    SUCH_OBJ: 'V',
    SUCHMAX: String(MAX_RESULTS)
  });
  return `${LEGACY_PORTAL_BASE}${LEGACY_SEARCH_PATH}?${params.toString()}`;
}

const buildLegacySearchUrl = buildSearchUrl;

function normalizeHref(href, portalBase, detailDir) {
  const decoded = decodeEntities(String(href || '')).trim();
  if (/^https?:\/\//i.test(decoded)) return decoded;
  if (decoded.startsWith('/')) return `${portalBase}${decoded}`;
  const cleaned = decoded.replace(/^\.?\/?/, '');
  if (/\.asp(?:\?|$)/i.test(cleaned)) {
    return `${LEGACY_PORTAL_BASE}${LEGACY_DETAIL_DIR}${cleaned}`;
  }
  return `${portalBase}${detailDir}${cleaned}`;
}

function parseResults(html, options = {}) {
  const results = [];
  const portalBase = options.portalBase || PORTAL_BASE;
  const detailDir = options.detailDir || DETAIL_DIR;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];
    const linkMatch = row.match(/<a\s+[^>]*href="([^"]*(?:vo|to|si|kp)0?\d+(?:\.asp)?[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const rawTitle = decodeEntities(stripTags(linkMatch[2])).trim();
    if (!rawTitle || rawTitle.length < 5) continue;

    const url = normalizeHref(href, portalBase, detailDir);

    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
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

async function search(params) {
  const { searchTerms = [] } = params || {};
  if (!searchTerms.length) return [];

  const allResults = [];
  for (const term of searchTerms) {
    if (!term || typeof term !== 'string' || !term.trim()) continue;
    const trimmed = term.trim();
    const requests = [
      { url: buildSitzungOnlineSearchUrl(trimmed), portalBase: PORTAL_BASE, detailDir: DETAIL_DIR, label: 'sitzung-online' },
      { url: buildLegacySearchUrl(trimmed), portalBase: LEGACY_PORTAL_BASE, detailDir: LEGACY_DETAIL_DIR, label: 'legacy-buergerinfo' }
    ];

    for (const request of requests) {
      try {
        const html = await fetchHtml(request.url);
        const results = parseResults(html, request).map((r) => enrichWithReferenceModel(r, trimmed));
        allResults.push(...results);
        if (results.length > 0) break;
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
  buildSitzungOnlineSearchUrl
};
