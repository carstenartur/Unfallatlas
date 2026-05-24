'use strict';

/**
 * Generischer Provider für SessionNet-/Allris-klassische Bürger-
 * informationssysteme (CC e-gov / Sternberg SessionNet, klassische
 * `<base>/bi/info.asp`-Variante).
 *
 * Viele deutsche Städte betreiben dieses System mit ähnlicher HTML-Struktur
 * (Tabelle mit Detail-Links auf `vo0\d+.asp` / `to0\d+.asp` / `si0\d+.asp`).
 * Die Recherche-Endpunkte unterscheiden sich jedoch je Installation
 * (`yw010.asp`, `suche.asp`, `suchen01.asp` mit festen Parametern etc.).
 * Deshalb ist der Suchpfad pro Stadt konfigurierbar.
 *
 * Architektur-Hinweis: Stadt-/Portal-spezifische Sonderlogik wird bewusst
 * NICHT hier eingebaut. Wer ein Portal anbinden will, das vom Standard
 * abweicht (z. B. Allris 4 mit JSON-API), schreibt einen eigenen Provider.
 *
 * Quelle der Parser-Heuristik: `bonnAllrisProvider.js` (klassisches
 * SessionNet, dort über Jahre stabil).
 *
 * @module server/political-context/providers/sessionNetProvider
 */

const {
  fetchHtml,
  stripTags,
  decodeEntities,
  enrichWithReferenceModel,
  normCityKey
} = require('./_portalUtils.js');

/** Maximale Trefferanzahl pro Suchanfrage. */
const MAX_RESULTS = 20;

/**
 * @typedef {object} SessionNetProviderConfig
 * @property {string} cityKey      Normalisierter Stadtschlüssel (z. B. `bielefeld`)
 * @property {string} providerKey  Provider-Kürzel für Logging / `meta.providerKey`
 * @property {string} baseUrl      Portal-Basis ohne Pfad (z. B. `https://anwendungen.bielefeld.de`)
 * @property {string} searchPath   Pfad des Such-Endpunkts (z. B. `/bi/suchen01.asp`)
 * @property {object} [searchParams] Feste portal-spezifische Parameter, z. B. `{ smcrecherche: '7020' }`
 * @property {string} [detailDir]  Verzeichnis für relative Detail-Links
 *                                 (Standard: aus searchPath abgeleitet)
 */

/**
 * Baut die Such-URL für ein klassisches SessionNet-Portal.  Standardparameter:
 *   - `MM`        – Modul (`Suche`)
 *   - `SUCH`      – Suchbegriff
 *   - `SUCH_OBJ`  – `'V'` (Vorlagen/Drucksachen)
 *   - `SUCHMAX`   – Trefferlimit
 *
 * Manche Installationen benötigen zusätzlich feste Parameter wie
 * `smcrecherche=7020`; diese werden vor den Standards eingefügt und können
 * bei Bedarf überschrieben werden.
 *
 * @param {SessionNetProviderConfig} config
 * @param {string} term
 * @returns {string}
 */
function buildSearchUrl(config, term) {
  const params = new URLSearchParams({
    ...(config.searchParams || {}),
    MM:       'Suche',
    SUCH:     term,
    SUCH_OBJ: 'V',
    SUCHMAX:  String(MAX_RESULTS)
  });
  return `${config.baseUrl}${config.searchPath}?${params.toString()}`;
}

/**
 * Berechnet das Detail-Verzeichnis (für relative Links wie `vo020.asp?…`)
 * aus `searchPath` (z. B. `/bi/suchen01.asp` → `/bi/`).
 *
 * @param {SessionNetProviderConfig} config
 * @returns {string}
 */
function detailDirOf(config) {
  if (config.detailDir) return config.detailDir;
  const idx = config.searchPath.lastIndexOf('/');
  return idx >= 0 ? config.searchPath.substring(0, idx + 1) : '/';
}

/**
 * Parst die HTML-Trefferliste eines klassischen SessionNet-Portals.
 *
 * Akzeptierte Detail-Links:
 *   - `vo0\d+.asp`  – Vorlage
 *   - `to0\d+.asp`  – Tagesordnungspunkt
 *   - `si0\d+.asp`  – Sitzung
 *   - `kp0\d+.asp`  – Kennzahl/Person (selten)
 *
 * @param {string}                    html
 * @param {SessionNetProviderConfig}  config
 * @returns {object[]}
 */
function parseResults(html, config) {
  const results  = [];
  const detail   = detailDirOf(config);
  const baseUrl  = config.baseUrl;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    const linkMatch = row.match(/<a\s+href="([^"]*(?:vo0\d+|to0\d+|si0\d+|kp0\d+)\.asp[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const rawTitle = decodeEntities(stripTags(linkMatch[2])).trim();
    if (!rawTitle || rawTitle.length < 5) continue;

    let url;
    if (/^https?:\/\//i.test(href)) {
      url = href;
    } else if (href.startsWith('/')) {
      url = `${baseUrl}${href}`;
    } else {
      url = `${baseUrl}${detail}${href.replace(/^\.?\/?/, '')}`;
    }

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

    const snippet = cells
      .filter((c) => c && c !== rawTitle && c.length > 10)
      .slice(0, 3)
      .join(' | ') || null;

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
 * Erzeugt einen SessionNet-Provider für eine konkrete Stadt.
 *
 * @param {SessionNetProviderConfig} config
 * @returns {object} Provider-Objekt mit `_key`, `supportsCity`, `search`,
 *                   `parseResults`, `buildSearchUrl`.
 */
function createSessionNetProvider(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('createSessionNetProvider: config required');
  }
  for (const key of ['cityKey', 'providerKey', 'baseUrl', 'searchPath']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new TypeError(`createSessionNetProvider: config.${key} required (string)`);
    }
  }
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    throw new TypeError('createSessionNetProvider: config.baseUrl must be http(s) URL');
  }
  if (!config.searchPath.startsWith('/')) {
    throw new TypeError('createSessionNetProvider: config.searchPath must start with "/"');
  }

  const cfg = Object.freeze({
    ...config,
    searchParams: Object.freeze({ ...(config.searchParams || {}) })
  });

  return Object.freeze({
    _key: cfg.providerKey,
    _config: cfg,
    supportsCity(city) {
      return normCityKey(city) === normCityKey(cfg.cityKey);
    },
    buildSearchUrl(term) {
      return buildSearchUrl(cfg, String(term || ''));
    },
    parseResults(html) {
      return parseResults(String(html || ''), cfg);
    },
    async search(params) {
      const { searchTerms = [] } = params || {};
      if (!Array.isArray(searchTerms) || !searchTerms.length) return [];
      const allResults = [];
      for (const term of searchTerms) {
        if (!term || typeof term !== 'string' || !term.trim()) continue;
        const trimmed = term.trim();
        try {
          const url  = buildSearchUrl(cfg, trimmed);
          const html = await fetchHtml(url);
          const out  = parseResults(html, cfg)
            .map((r) => enrichWithReferenceModel(r, trimmed));
          allResults.push(...out);
        } catch (err) {
          // Suchbegriff bewusst NICHT loggen (Datenschutz / Log-Injection-Schutz).
          console.warn(`[${cfg.providerKey}] Suche fehlgeschlagen: ${err.message}`);
        }
      }
      return allResults;
    }
  });
}

module.exports = {
  createSessionNetProvider,
  // exposed für Tests:
  buildSearchUrl,
  parseResults,
  detailDirOf,
  MAX_RESULTS
};
