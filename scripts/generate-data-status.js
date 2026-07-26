#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const { readCitiesFile, slugify } = require('./lib/static-data-validation');
const { readJsonMaybeGz } = require('./lib/read-json-maybe-gz');

const FAMILY_ORDER = Object.freeze(['accidents', 'poi', 'roads', 'slope', 'traffic']);
const FAMILY_LABELS = Object.freeze({
  accidents: 'Unfalldaten',
  poi: 'Schulen & Kitas',
  roads: 'Straßenkontext',
  slope: 'Steigung',
  traffic: 'Verkehr',
});
const LEVEL_COLORS = Object.freeze({
  success: '#2da44e',
  warning: '#bf8700',
  critical: '#cf222e',
  unknown: '#6e7781',
});

function parseArgs(argv) {
  const args = {
    site: '_site',
    cities: 'cities.txt',
    outputDir: null,
    badgeDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--site') args.site = argv[++i] || args.site;
    else if (arg === '--cities') args.cities = argv[++i] || args.cities;
    else if (arg === '--output-dir') args.outputDir = argv[++i] || args.outputDir;
    else if (arg === '--badge-dir') args.badgeDir = argv[++i] || args.badgeDir;
    else throw new Error(`[data-status] Unknown argument: ${arg}`);
  }
  return args;
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function metadataDate(json) {
  const containers = [json, json && json.properties, json && json.metadata].filter(Boolean);
  for (const container of containers) {
    for (const key of ['retrievedAt', 'generatedAt', 'extractDate', 'updatedAt', 'date']) {
      const date = normalizeDate(container[key]);
      if (date) return date;
    }
  }
  return null;
}

async function scanAccidentYears(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const years = new Set();
  let carry = '';
  const matcher = /["'](?:ujahr|jahr|year)["']\s*:\s*["']?(19\d{2}|20\d{2}|21\d{2})["']?/gi;
  const source = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
  input.setEncoding('utf8');
  const sink = async function* (chunks) {
    for await (const chunk of chunks) {
      const text = carry + chunk;
      matcher.lastIndex = 0;
      let match;
      while ((match = matcher.exec(text))) years.add(Number(match[1]));
      carry = text.slice(-160);
      yield '';
    }
  };
  await pipeline(input, sink(), async function* (chunks) { for await (const _ of chunks) yield _; });
  return [...years].sort((a, b) => a - b);
}

function readOptionalJson(filePath) {
  if (!filePath) return null;
  const logical = filePath.replace(/\.gz$/i, '');
  try { return readJsonMaybeGz(logical); }
  catch (_) { return null; }
}

function resolveManifestPath(siteRoot, manifestPath) {
  if (!manifestPath) return null;
  return path.resolve(siteRoot, manifestPath.replace(/^\/+/, ''));
}

function coverageLevel(present, total) {
  if (total <= 0 || present <= 0) return 'critical';
  if (present === total) return 'success';
  return 'warning';
}

function combineLevel(coverage, hasUnknownMetadata) {
  if (coverage !== 'success') return coverage;
  return hasUnknownMetadata ? 'unknown' : 'success';
}

function dateExtent(values) {
  const dates = values.map(normalizeDate).filter(Boolean).sort();
  return {
    oldest: dates[0] || null,
    newest: dates[dates.length - 1] || null,
    known: dates.length,
  };
}

function yearExtent(values) {
  const years = values.filter(Number.isInteger).sort((a, b) => a - b);
  return {
    oldest: years[0] || null,
    newest: years[years.length - 1] || null,
    known: years.length,
  };
}

function formatDecimal(value) {
  if (!Number.isFinite(value)) return null;
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

function formatCoverage(present, total) {
  return `${present}/${total} Städte`;
}

function formatOldestDate(extent) {
  return extent.oldest ? `ältester Stand ${extent.oldest}` : 'Stand unbekannt';
}

function trafficKind(sources) {
  const normalized = sources.filter(Boolean).map((value) => String(value).toLowerCase());
  if (normalized.length === 0) return 'Quelle unbekannt';
  const proxy = normalized.filter((value) => value.includes('proxy')).length;
  if (proxy === normalized.length) return 'OSM-Proxy';
  if (proxy === 0) return 'Mess-/Modelldaten';
  return 'gemischte Quellen';
}

function aggregateStatus(cityRows) {
  const total = cityRows.length;
  const present = (selector) => cityRows.filter(selector).length;

  const accidentPresent = present((row) => row.accidents.present);
  const accidentYears = cityRows.flatMap((row) => row.accidents.years);
  const accidentYearExtent = yearExtent(accidentYears);
  const accidentUnknown = cityRows.filter((row) => row.accidents.present && row.accidents.years.length === 0).length;

  const poiPresent = present((row) => row.poi.present);
  const poiDates = dateExtent(cityRows.map((row) => row.poi.observedAt));
  const poiUnknown = cityRows.filter((row) => row.poi.present && !row.poi.observedAt).length;

  const roadPresent = present((row) => row.roads.present);
  const roadDates = dateExtent(cityRows.map((row) => row.roads.observedAt));
  const roadUnknown = cityRows.filter((row) => row.roads.present && !row.roads.observedAt).length;

  const slopePresent = present((row) => row.slope.present);
  const slopeDates = dateExtent(cityRows.map((row) => row.slope.observedAt));
  const slopeUnknown = cityRows.filter((row) => row.slope.present && !row.slope.observedAt).length;
  const slopeCoverage = cityRows
    .map((row) => row.slope.coveragePercent)
    .filter(Number.isFinite);
  const minimumSlopeCoverage = slopeCoverage.length ? Math.min(...slopeCoverage) : null;

  const trafficPresent = present((row) => row.traffic.present);
  const trafficDates = dateExtent(cityRows.map((row) => row.traffic.observedAt));
  const trafficUnknown = cityRows.filter((row) => row.traffic.present && !row.traffic.observedAt).length;
  const trafficSources = cityRows.filter((row) => row.traffic.present).map((row) => row.traffic.source);

  const accidentsLevel = combineLevel(coverageLevel(accidentPresent, total), accidentUnknown > 0);
  const poiLevel = combineLevel(coverageLevel(poiPresent, total), poiUnknown > 0);
  const roadsLevel = combineLevel(coverageLevel(roadPresent, total), roadUnknown > 0);
  const slopeLevel = combineLevel(coverageLevel(slopePresent, total), slopeUnknown > 0);
  const trafficLevel = combineLevel(coverageLevel(trafficPresent, total), trafficUnknown > 0);

  return {
    accidents: {
      label: FAMILY_LABELS.accidents,
      present: accidentPresent,
      total,
      level: accidentsLevel,
      years: accidentYearExtent,
      unknownMetadataCities: accidentUnknown,
      message: `${formatCoverage(accidentPresent, total)} · ${accidentYearExtent.newest ? `bis ${accidentYearExtent.newest}` : 'Jahre unbekannt'}`,
    },
    poi: {
      label: FAMILY_LABELS.poi,
      present: poiPresent,
      total,
      level: poiLevel,
      dates: poiDates,
      unknownMetadataCities: poiUnknown,
      message: `${formatCoverage(poiPresent, total)} · ${formatOldestDate(poiDates)}`,
    },
    roads: {
      label: FAMILY_LABELS.roads,
      present: roadPresent,
      total,
      level: roadsLevel,
      dates: roadDates,
      unknownMetadataCities: roadUnknown,
      message: `${formatCoverage(roadPresent, total)} · ${formatOldestDate(roadDates)}`,
    },
    slope: {
      label: FAMILY_LABELS.slope,
      present: slopePresent,
      total,
      level: slopeLevel,
      dates: slopeDates,
      minimumCoveragePercent: minimumSlopeCoverage,
      unknownMetadataCities: slopeUnknown,
      message: `${formatCoverage(slopePresent, total)} · ${Number.isFinite(minimumSlopeCoverage) ? `min. ${formatDecimal(minimumSlopeCoverage)} % Wege` : formatOldestDate(slopeDates)}`,
    },
    traffic: {
      label: FAMILY_LABELS.traffic,
      present: trafficPresent,
      total,
      level: trafficLevel,
      dates: trafficDates,
      sourceKind: trafficKind(trafficSources),
      unknownMetadataCities: trafficUnknown,
      message: `${formatCoverage(trafficPresent, total)} · ${trafficKind(trafficSources)}`,
    },
  };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function badgeWidth(text) {
  return Math.max(40, Array.from(String(text)).length * 7 + 12);
}

function renderBadge(label, message, level) {
  const left = badgeWidth(label);
  const right = badgeWidth(message);
  const total = left + right;
  const color = LEVEL_COLORS[level] || LEVEL_COLORS.unknown;
  const labelX = Math.round(left / 2);
  const messageX = left + Math.round(right / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${xmlEscape(`${label}: ${message}`)}">\n` +
    `  <title>${xmlEscape(`${label}: ${message}`)}</title>\n` +
    `  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#aaa" stop-opacity=".1"/><stop offset=".9" stop-opacity=".3"/><stop offset="1" stop-opacity=".5"/></linearGradient>\n` +
    `  <clipPath id="r"><rect width="${total}" height="20" rx="3"/></clipPath>\n` +
    `  <g clip-path="url(#r)"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g>\n` +
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${xmlEscape(label)}</text><text x="${labelX}" y="14">${xmlEscape(label)}</text><text x="${messageX}" y="15" fill="#010101" fill-opacity=".3">${xmlEscape(message)}</text><text x="${messageX}" y="14">${xmlEscape(message)}</text></g>\n` +
    `</svg>\n`;
}

function htmlEscape(value) {
  return xmlEscape(value);
}

function dateCell(date) {
  if (!date) return '<span class="unknown">unbekannt</span>';
  return `<time datetime="${htmlEscape(date)}" data-relative-date>${htmlEscape(date)}</time>`;
}

function renderHtml(status) {
  const badges = FAMILY_ORDER.map((key) =>
    `<a href="#${key}"><img src="../status/${key}.svg" alt="${htmlEscape(status.families[key].label)}"></a>`
  ).join('\n');
  const summaryRows = FAMILY_ORDER.map((key) => {
    const family = status.families[key];
    return `<tr id="${key}"><th>${htmlEscape(family.label)}</th><td>${family.present}/${family.total}</td><td>${htmlEscape(family.message)}</td><td>${htmlEscape(family.level)}</td></tr>`;
  }).join('\n');
  const cityRows = status.cities.map((row) =>
    `<tr><th>${htmlEscape(row.name)}</th>` +
    `<td>${row.accidents.present ? htmlEscape(row.accidents.years.length ? `${row.accidents.years[0]}–${row.accidents.years[row.accidents.years.length - 1]}` : 'vorhanden; Jahre unbekannt') : 'fehlt'}</td>` +
    `<td>${row.poi.present ? `${row.poi.features} POIs; ${dateCell(row.poi.observedAt)}` : 'fehlt'}</td>` +
    `<td>${row.roads.present ? dateCell(row.roads.observedAt) : 'fehlt'}</td>` +
    `<td>${row.slope.present ? `${Number.isFinite(row.slope.coveragePercent) ? `${formatDecimal(row.slope.coveragePercent)} %; ` : ''}${dateCell(row.slope.observedAt)}` : 'fehlt'}</td>` +
    `<td>${row.traffic.present ? `${htmlEscape(row.traffic.source || 'Quelle unbekannt')}; ${dateCell(row.traffic.observedAt)}` : 'fehlt'}</td></tr>`
  ).join('\n');
  return `<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Datenstatus – Unfallwerkbank</title>\n<style>body{font-family:system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#24292f}a{color:#0969da}.badges{display:grid;gap:.35rem;justify-items:start;margin:1rem 0 2rem}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{border:1px solid #d0d7de;padding:.45rem;text-align:left;vertical-align:top}thead th{background:#f6f8fa}.unknown{color:#6e7781}.note{background:#fff8c5;border:1px solid #d4a72c;padding:.75rem}</style>\n</head>\n<body>\n<h1>Datenstatus der Unfallwerkbank</h1>\n<p>Die Angaben werden aus dem Maven-erzeugten <code>data-manifest.json</code> und den mit ausgelieferten Quellenmetadaten abgeleitet. Ein unbekannter Stand wird nicht aus Datei-Zeitstempeln geraten.</p>\n<div class="badges">${badges}</div>\n<h2>Zusammenfassung</h2>\n<table><thead><tr><th>Datenfamilie</th><th>Abdeckung</th><th>Stand</th><th>Statusklasse</th></tr></thead><tbody>${summaryRows}</tbody></table>\n<p class="note">„Stand“ bezeichnet je nach Datenfamilie das Unfalljahr, den Quellenabruf oder den Zeitpunkt der Kontextanreicherung. Schulen-/Kita-Dateien ohne eingebettete Abrufmetadaten werden ausdrücklich als unbekannt ausgewiesen.</p>\n<h2>Stadtmatrix</h2>\n<table><thead><tr><th>Stadt</th><th>Unfalldaten</th><th>Schulen &amp; Kitas</th><th>Straßenkontext</th><th>Steigung</th><th>Verkehr</th></tr></thead><tbody>${cityRows}</tbody></table>\n<p><a href="../werkbank_v2.html">Zur Unfallwerkbank</a></p>\n<script>document.querySelectorAll('[data-relative-date]').forEach(function(el){var d=new Date(el.dateTime+'T00:00:00Z');if(!Number.isFinite(d.getTime()))return;var days=Math.floor((Date.now()-d.getTime())/86400000);if(days>=0)el.append(' (vor '+days+' Tagen)');});</script>\n</body>\n</html>\n`;
}

async function buildCityRows(siteRoot, manifest, configuredCities) {
  const rows = [];
  for (const name of configuredCities) {
    const slug = slugify(name);
    const city = (manifest.cities || {})[slug] || {};
    const accidentPath = city.accidents && resolveManifestPath(siteRoot, city.accidents.gzipPath || city.accidents.logicalPath);
    const years = city.accidents ? await scanAccidentYears(accidentPath) : [];
    const poiPath = city.poi && resolveManifestPath(siteRoot, city.poi.gzipPath);
    const poiJson = readOptionalJson(poiPath);
    const metaPath = city.enrichment && resolveManifestPath(siteRoot, city.enrichment.metaPath);
    const meta = readOptionalJson(metaPath);
    const generatedAt = normalizeDate(meta && meta.generatedAt);
    const osmSource = meta && meta.sources && meta.sources.osm;
    const demSource = meta && meta.sources && meta.sources.dem;
    const trafficSource = meta && meta.sources && meta.sources.traffic;
    rows.push({
      name,
      slug,
      accidents: {
        present: !!city.accidents,
        features: Number(city.accidents && city.accidents.features || 0),
        years,
      },
      poi: {
        present: !!city.poi,
        features: Number(city.poi && city.poi.features || 0),
        observedAt: metadataDate(poiJson),
      },
      roads: {
        present: !!city.enrichment && Number(city.enrichment.contextTiles || 0) > 0,
        observedAt: normalizeDate(osmSource && osmSource.extractDate) || generatedAt,
        source: osmSource && osmSource.source || null,
      },
      slope: {
        present: !!(city.enrichment && city.enrichment.hasSlope),
        observedAt: generatedAt,
        source: demSource && demSource.source || null,
        coveragePercent: Number.isFinite(Number(meta && meta.slope && meta.slope.coveragePercent))
          ? Number(meta.slope.coveragePercent) : null,
      },
      traffic: {
        present: !!(city.enrichment && city.enrichment.hasTrafficProxy),
        observedAt: generatedAt,
        source: trafficSource && trafficSource.source || null,
      },
    });
  }
  return rows;
}

async function generateDataStatus(options = {}) {
  const repoRoot = path.resolve(options.root || path.join(__dirname, '..'));
  const siteRoot = path.resolve(repoRoot, options.site || '_site');
  const citiesFile = path.resolve(repoRoot, options.cities || 'cities.txt');
  const outputDir = path.resolve(repoRoot, options.outputDir || path.join(path.relative(repoRoot, siteRoot), 'data-status'));
  const badgeDir = path.resolve(repoRoot, options.badgeDir || path.join(path.relative(repoRoot, siteRoot), 'status'));
  const manifestPath = path.join(siteRoot, 'out', 'data-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`[data-status] Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const configuredCities = readCitiesFile(citiesFile);
  const cities = await buildCityRows(siteRoot, manifest, configuredCities);
  const families = aggregateStatus(cities);
  const status = {
    schemaVersion: 1,
    configuredCities: configuredCities.length,
    dataMode: manifest.dataMode || null,
    families,
    cities,
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(badgeDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'index.html'), renderHtml(status));
  for (const key of FAMILY_ORDER) {
    const family = families[key];
    fs.writeFileSync(path.join(badgeDir, `${key}.svg`), renderBadge(family.label, family.message, family.level));
  }
  process.stdout.write(`[data-status] Wrote ${FAMILY_ORDER.length} badges and ${path.relative(repoRoot, outputDir)} for ${cities.length} cities.\n`);
  return status;
}

async function main(argv) {
  const args = parseArgs(argv);
  await generateDataStatus(args);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FAMILY_ORDER,
  FAMILY_LABELS,
  LEVEL_COLORS,
  aggregateStatus,
  buildCityRows,
  generateDataStatus,
  metadataDate,
  normalizeDate,
  parseArgs,
  renderBadge,
  renderHtml,
  scanAccidentYears,
};
