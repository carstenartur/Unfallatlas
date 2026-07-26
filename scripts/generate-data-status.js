#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

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
  const args = { site: '_site', cities: 'cities.txt', outputDir: null, badgeDir: null };
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
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
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
  const matcher = /["'](?:ujahr|jahr|year)["']\s*:\s*["']?(19\d{2}|20\d{2}|21\d{2})["']?/gi;
  let carry = '';
  const source = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
  input.setEncoding('utf8');
  for await (const chunk of input) {
    const text = carry + chunk;
    matcher.lastIndex = 0;
    let match;
    while ((match = matcher.exec(text))) years.add(Number(match[1]));
    carry = text.slice(-160);
  }
  return [...years].sort((a, b) => a - b);
}

function readOptionalJson(filePath) {
  if (!filePath) return null;
  try { return readJsonMaybeGz(filePath.replace(/\.gz$/i, '')); }
  catch (_) { return null; }
}

function resolveManifestPath(siteRoot, manifestPath) {
  return manifestPath ? path.resolve(siteRoot, manifestPath.replace(/^\/+/, '')) : null;
}

function coverageLevel(present, total) {
  if (total <= 0 || present <= 0) return 'critical';
  return present === total ? 'success' : 'warning';
}

function combineLevel(level, unknownMetadata) {
  return level === 'success' && unknownMetadata ? 'unknown' : level;
}

function dateExtent(values) {
  const dates = values.map(normalizeDate).filter(Boolean).sort();
  return { oldest: dates[0] || null, newest: dates.at(-1) || null, known: dates.length };
}

function yearExtent(values) {
  const years = values.filter(Number.isInteger).sort((a, b) => a - b);
  return { oldest: years[0] || null, newest: years.at(-1) || null, known: years.length };
}

function formatDecimal(value) {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10).replace('.', ',') : null;
}

function oldestDateMessage(extent) {
  return extent.oldest ? `ältester Stand ${extent.oldest}` : 'Stand unbekannt';
}

function trafficKind(sources) {
  const normalized = sources.filter(Boolean).map((value) => String(value).toLowerCase());
  if (!normalized.length) return 'Quelle unbekannt';
  const proxyCount = normalized.filter((value) => value.includes('proxy')).length;
  if (proxyCount === normalized.length) return 'OSM-Proxy';
  if (proxyCount === 0) return 'Mess-/Modelldaten';
  return 'gemischte Quellen';
}

function aggregateStatus(cities) {
  const total = cities.length;
  const count = (selector) => cities.filter(selector).length;
  const family = (label, present, unknownMetadata, message, extra = {}) => ({
    label,
    present,
    total,
    level: combineLevel(coverageLevel(present, total), unknownMetadata > 0),
    unknownMetadataCities: unknownMetadata,
    message,
    ...extra,
  });

  const accidentPresent = count((row) => row.accidents.present);
  const accidentYears = yearExtent(cities.flatMap((row) => row.accidents.years));
  const accidentUnknown = count((row) => row.accidents.present && row.accidents.years.length === 0);

  const poiPresent = count((row) => row.poi.present);
  const poiDates = dateExtent(cities.map((row) => row.poi.observedAt));
  const poiUnknown = count((row) => row.poi.present && !row.poi.observedAt);

  const roadPresent = count((row) => row.roads.present);
  const roadDates = dateExtent(cities.map((row) => row.roads.observedAt));
  const roadUnknown = count((row) => row.roads.present && !row.roads.observedAt);

  const slopePresent = count((row) => row.slope.present);
  const slopeDates = dateExtent(cities.map((row) => row.slope.observedAt));
  const slopeUnknown = count((row) => row.slope.present && !row.slope.observedAt);
  const slopeCoverage = cities
    .filter((row) => row.slope.present)
    .map((row) => row.slope.coveragePercent)
    .filter(Number.isFinite);
  const minimumSlopeCoverage = slopeCoverage.length ? Math.min(...slopeCoverage) : null;

  const trafficPresent = count((row) => row.traffic.present);
  const trafficDates = dateExtent(cities.map((row) => row.traffic.observedAt));
  const trafficUnknown = count((row) => row.traffic.present && !row.traffic.observedAt);
  const sourceKind = trafficKind(cities.filter((row) => row.traffic.present).map((row) => row.traffic.source));

  return {
    accidents: family(
      FAMILY_LABELS.accidents,
      accidentPresent,
      accidentUnknown,
      `${accidentPresent}/${total} Städte · ${accidentYears.newest ? `bis ${accidentYears.newest}` : 'Jahre unbekannt'}`,
      { years: accidentYears }
    ),
    poi: family(
      FAMILY_LABELS.poi,
      poiPresent,
      poiUnknown,
      `${poiPresent}/${total} Städte · ${oldestDateMessage(poiDates)}`,
      { dates: poiDates }
    ),
    roads: family(
      FAMILY_LABELS.roads,
      roadPresent,
      roadUnknown,
      `${roadPresent}/${total} Städte · ${oldestDateMessage(roadDates)}`,
      { dates: roadDates }
    ),
    slope: family(
      FAMILY_LABELS.slope,
      slopePresent,
      slopeUnknown,
      `${slopePresent}/${total} Städte · ${Number.isFinite(minimumSlopeCoverage) ? `min. ${formatDecimal(minimumSlopeCoverage)} % Wege` : 'Abdeckung unbekannt'} · ${oldestDateMessage(slopeDates)}`,
      { dates: slopeDates, minimumCoveragePercent: minimumSlopeCoverage }
    ),
    traffic: family(
      FAMILY_LABELS.traffic,
      trafficPresent,
      trafficUnknown,
      `${trafficPresent}/${total} Städte · ${sourceKind} · ${oldestDateMessage(trafficDates)}`,
      { dates: trafficDates, sourceKind }
    ),
  };
}

function escapeXml(value) {
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
  const width = left + right;
  const color = LEVEL_COLORS[level] || LEVEL_COLORS.unknown;
  const title = `${label}: ${message}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(title)}">\n` +
    `<title>${escapeXml(title)}</title><clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${color}"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${Math.round(left / 2)}" y="14">${escapeXml(label)}</text>` +
    `<text x="${left + Math.round(right / 2)}" y="14">${escapeXml(message)}</text></g></svg>\n`;
}

function dateCell(date) {
  return date
    ? `<time datetime="${escapeXml(date)}" data-relative-date>${escapeXml(date)}</time>`
    : '<span class="unknown">unbekannt</span>';
}

function renderHtml(status) {
  const badges = FAMILY_ORDER.map((key) =>
    `<a href="#${key}"><img src="../status/${key}.svg" alt="${escapeXml(status.families[key].label)}"></a>`
  ).join('\n');
  const summaries = FAMILY_ORDER.map((key) => {
    const item = status.families[key];
    return `<tr id="${key}"><th>${escapeXml(item.label)}</th><td>${item.present}/${item.total}</td><td>${escapeXml(item.message)}</td><td>${escapeXml(item.level)}</td></tr>`;
  }).join('\n');
  const rows = status.cities.map((row) => {
    const years = row.accidents.years;
    const yearText = years.length ? `${years[0]}–${years.at(-1)}` : 'vorhanden; Jahre unbekannt';
    return `<tr><th>${escapeXml(row.name)}</th>` +
      `<td>${row.accidents.present ? escapeXml(yearText) : 'fehlt'}</td>` +
      `<td>${row.poi.present ? `${row.poi.features} POIs; ${dateCell(row.poi.observedAt)}` : 'fehlt'}</td>` +
      `<td>${row.roads.present ? dateCell(row.roads.observedAt) : 'fehlt'}</td>` +
      `<td>${row.slope.present ? `${Number.isFinite(row.slope.coveragePercent) ? `${formatDecimal(row.slope.coveragePercent)} %; ` : ''}${dateCell(row.slope.observedAt)}` : 'fehlt'}</td>` +
      `<td>${row.traffic.present ? `${escapeXml(row.traffic.source || 'Quelle unbekannt')}; ${dateCell(row.traffic.observedAt)}` : 'fehlt'}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Datenstatus – Unfallwerkbank</title><style>body{font-family:system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#24292f}a{color:#0969da}.badges{display:grid;gap:.35rem;justify-items:start;margin:1rem 0 2rem}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{border:1px solid #d0d7de;padding:.45rem;text-align:left;vertical-align:top}thead th{background:#f6f8fa}.unknown{color:#6e7781}.note{background:#fff8c5;border:1px solid #d4a72c;padding:.75rem}</style></head><body><h1>Datenstatus der Unfallwerkbank</h1><p>Die Angaben werden aus dem Maven-erzeugten <code>data-manifest.json</code> und den ausgelieferten Quellenmetadaten abgeleitet. Unbekannte Zeitstände werden nicht aus Datei-Zeitstempeln geraten.</p><div class="badges">${badges}</div><h2>Zusammenfassung</h2><table><thead><tr><th>Datenfamilie</th><th>Abdeckung</th><th>Stand</th><th>Statusklasse</th></tr></thead><tbody>${summaries}</tbody></table><p class="note">„Stand“ bezeichnet je nach Datenfamilie das Unfalljahr, den Quellenabruf oder den Zeitpunkt der Kontextanreicherung. POI-Dateien ohne eingebettete Abrufmetadaten werden ausdrücklich als unbekannt ausgewiesen.</p><h2>Stadtmatrix</h2><table><thead><tr><th>Stadt</th><th>Unfalldaten</th><th>Schulen &amp; Kitas</th><th>Straßenkontext</th><th>Steigung</th><th>Verkehr</th></tr></thead><tbody>${rows}</tbody></table><p><a href="../werkbank_v2.html">Zur Unfallwerkbank</a></p><script>document.querySelectorAll('[data-relative-date]').forEach(function(el){var d=new Date(el.dateTime+'T00:00:00Z');if(!Number.isFinite(d.getTime()))return;var days=Math.floor((Date.now()-d.getTime())/86400000);if(days>=0)el.append(' (vor '+days+' Tagen)');});</script></body></html>\n`;
}

async function buildCityRows(siteRoot, manifest, configuredCities) {
  const rows = [];
  for (const name of configuredCities) {
    const slug = slugify(name);
    const city = (manifest.cities || {})[slug] || {};
    const accidentPath = city.accidents && resolveManifestPath(siteRoot, city.accidents.gzipPath || city.accidents.logicalPath);
    const manifestYears = city.accidents && Array.isArray(city.accidents.years)
      ? [...new Set(city.accidents.years.filter(Number.isInteger))].sort((a, b) => a - b)
      : [];
    const accidentYears = manifestYears.length > 0
      ? manifestYears
      : (city.accidents ? await scanAccidentYears(accidentPath) : []);
    const poiPath = city.poi && resolveManifestPath(siteRoot, city.poi.gzipPath);
    const metaPath = city.enrichment && resolveManifestPath(siteRoot, city.enrichment.metaPath);
    const poi = readOptionalJson(poiPath);
    const meta = readOptionalJson(metaPath);
    const generatedAt = normalizeDate(meta && meta.generatedAt);
    const osm = meta && meta.sources && meta.sources.osm;
    const dem = meta && meta.sources && meta.sources.dem;
    const traffic = meta && meta.sources && meta.sources.traffic;
    const rawSlopeCoveragePercent = meta && meta.slope && meta.slope.coveragePercent;
    const slopeCoveragePercent = rawSlopeCoveragePercent == null ? null : Number(rawSlopeCoveragePercent);
    rows.push({
      name,
      slug,
      accidents: {
        present: !!city.accidents,
        features: Number(city.accidents && city.accidents.features || 0),
        years: accidentYears,
      },
      poi: {
        present: !!city.poi,
        features: Number(city.poi && city.poi.features || 0),
        observedAt: metadataDate(poi),
      },
      roads: {
        present: !!city.enrichment && Number(city.enrichment.contextTiles || 0) > 0,
        observedAt: normalizeDate(osm && osm.extractDate) || generatedAt,
        source: osm && osm.source || null,
      },
      slope: {
        present: !!(city.enrichment && city.enrichment.hasSlope),
        observedAt: generatedAt,
        source: dem && dem.source || null,
        coveragePercent: Number.isFinite(slopeCoveragePercent) ? slopeCoveragePercent : null,
      },
      traffic: {
        present: !!(city.enrichment && city.enrichment.hasTrafficProxy),
        observedAt: generatedAt,
        source: traffic && traffic.source || null,
      },
    });
  }
  return rows;
}

async function generateDataStatus(options = {}) {
  const repoRoot = path.resolve(options.root || path.join(__dirname, '..'));
  const siteRoot = path.resolve(repoRoot, options.site || '_site');
  const citiesFile = path.resolve(repoRoot, options.cities || 'cities.txt');
  const outputDir = options.outputDir ? path.resolve(repoRoot, options.outputDir) : path.join(siteRoot, 'data-status');
  const badgeDir = options.badgeDir ? path.resolve(repoRoot, options.badgeDir) : path.join(siteRoot, 'status');
  const manifestPath = path.join(siteRoot, 'out', 'data-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`[data-status] Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cities = await buildCityRows(siteRoot, manifest, readCitiesFile(citiesFile));
  const status = {
    schemaVersion: 1,
    configuredCities: cities.length,
    dataMode: manifest.dataMode || null,
    families: aggregateStatus(cities),
    cities,
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(badgeDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'index.html'), renderHtml(status));
  for (const key of FAMILY_ORDER) {
    const item = status.families[key];
    fs.writeFileSync(path.join(badgeDir, `${key}.svg`), renderBadge(item.label, item.message, item.level));
  }
  process.stdout.write(`[data-status] Wrote ${FAMILY_ORDER.length} badges for ${cities.length} cities.\n`);
  return status;
}

async function main(argv) {
  await generateDataStatus(parseArgs(argv));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FAMILY_ORDER,
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
