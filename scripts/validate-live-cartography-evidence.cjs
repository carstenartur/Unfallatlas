'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_MANIFEST = 'docs/media-manifest.json';
const EVIDENCE_DIRECTORY = 'out/qa/screenshot-readiness';
const NON_CARTOGRAPHIC_SCREENSHOTS = new Set(['15-export-pdf-rendered.png']);
const RASTER_CONTENT_TYPE = /^image\/(?:png|jpe?g|webp)(?:;|$)/i;
const MINIMUM_STABLE_TILE_SAMPLES = 3;
const MAXIMUM_CAPTURE_ATTEMPTS = 3;

function parseArgs(argv) {
  const options = { report: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--report') options.report = argv[++index] || null;
    else throw new Error(`[live-cartography-evidence] Unknown argument: ${argv[index]}`);
  }
  return options;
}

function classifyProviderUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch (_) { return null; }
  if (url.protocol !== 'https:') return null;
  if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname) &&
      /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) return 'standard';
  if (/(^|\.)basemaps\.cartocdn\.com$/i.test(url.hostname) &&
      /^\/light_only_labels\/\d+\/\d+\/\d+(?:@2x)?\.png$/.test(url.pathname)) return 'labels';
  if ((url.hostname === 'www.bonn.de' &&
       url.pathname === '/stadtplan-wms/services/orthofoto/MapServer/WMSServer') ||
      (url.hostname === 'www.wms.nrw.de' && url.pathname === '/geobasis/wms_nw_dop') ||
      (url.hostname === 'opendata.lgln.niedersachsen.de' &&
       url.pathname === '/doorman/noauth/dop_wms') ||
      (url.hostname === 'sg.geodatenzentrum.de' && url.pathname === '/wms_dop20') ||
      (url.hostname === 'server.arcgisonline.com' &&
       /^\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(url.pathname))) {
    return 'orthophoto';
  }
  return null;
}

function canonicalUrl(rawUrl) {
  try { return new URL(rawUrl).href; }
  catch (_) { return null; }
}

function positiveFinite(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validateTileSignature(record, screenshotPath, visibleTiles, errors) {
  if (typeof record.tileSignature !== 'string' || !record.tileSignature.trim()) {
    errors.push(`${screenshotPath}: cartography tileSignature is missing`);
    return;
  }
  let signature;
  try { signature = JSON.parse(record.tileSignature); }
  catch (error) {
    errors.push(`${screenshotPath}: cartography tileSignature is not valid JSON: ${error.message}`);
    return;
  }
  if (!positiveFinite(signature.mapWidth) || !positiveFinite(signature.mapHeight) ||
      !Array.isArray(signature.tiles) || signature.tiles.length === 0) {
    errors.push(`${screenshotPath}: cartography tileSignature has no positive map dimensions or tiles`);
    return;
  }
  if (signature.tiles.length !== visibleTiles.length) {
    errors.push(
      `${screenshotPath}: cartography tileSignature covers ${signature.tiles.length} tiles, ` +
      `but ${visibleTiles.length} visible ready tiles are recorded`
    );
  }
  for (const [index, tile] of signature.tiles.entries()) {
    if (!tile || classifyProviderUrl(tile.url) !== tile.kind ||
        !positiveFinite(tile.width) || !positiveFinite(tile.height) ||
        typeof tile.layerKey !== 'string' || !tile.layerKey) {
      errors.push(`${screenshotPath}: cartography tileSignature tile ${index} is invalid`);
    }
  }
}

function validateCartographyRecord(record, screenshotPath) {
  const errors = [];
  if (!record || record.source !== 'live') {
    errors.push(`${screenshotPath}: cartography source is not live`);
    return errors;
  }
  const requiredKinds = Array.isArray(record.requiredKinds) ? record.requiredKinds : [];
  const visibleTiles = Array.isArray(record.visibleTiles) ? record.visibleTiles : [];
  const invalidTiles = Array.isArray(record.invalidTiles) ? record.invalidTiles : [];
  const successfulResponses = Array.isArray(record.successfulResponses) ? record.successfulResponses : [];
  const coverageByKind = record.coverageByKind && typeof record.coverageByKind === 'object'
    ? record.coverageByKind
    : {};

  if (record.valid !== true || record.error != null) {
    errors.push(`${screenshotPath}: cartography capture is not marked valid`);
  }
  if (requiredKinds.length === 0 ||
      requiredKinds.some(kind => !['standard', 'orthophoto', 'labels'].includes(kind)) ||
      new Set(requiredKinds).size !== requiredKinds.length) {
    errors.push(`${screenshotPath}: cartography requiredKinds is empty, duplicated or invalid`);
  }
  if (!Number.isInteger(record.requiredStableSamples) ||
      record.requiredStableSamples < MINIMUM_STABLE_TILE_SAMPLES) {
    errors.push(
      `${screenshotPath}: cartography requires fewer than ${MINIMUM_STABLE_TILE_SAMPLES} stable tile samples`
    );
  }
  if (!Number.isInteger(record.stableSamples) ||
      record.stableSamples < Math.max(MINIMUM_STABLE_TILE_SAMPLES, Number(record.requiredStableSamples) || 0)) {
    errors.push(`${screenshotPath}: cartography tile signature was not stable for the required samples`);
  }
  if (!Number.isInteger(record.captureAttempts) || record.captureAttempts < 1 ||
      record.captureAttempts > MAXIMUM_CAPTURE_ATTEMPTS) {
    errors.push(`${screenshotPath}: cartography captureAttempts is outside the bounded retry contract`);
  }
  if (invalidTiles.length !== 0) {
    errors.push(`${screenshotPath}: cartography contains invalid visible Leaflet tiles`);
  }
  if (!record.animationState || record.animationState.active !== false ||
      record.animationState.zoom !== false || record.animationState.pan !== false ||
      record.animationState.drag !== false) {
    errors.push(`${screenshotPath}: cartography was captured during a Leaflet animation`);
  }
  const mapRect = record.mapRect;
  if (!mapRect || !positiveFinite(mapRect.width) || !positiveFinite(mapRect.height) ||
      !Number.isFinite(Number(mapRect.left)) || !Number.isFinite(Number(mapRect.top)) ||
      !Number.isFinite(Number(mapRect.right)) || !Number.isFinite(Number(mapRect.bottom)) ||
      Number(mapRect.right) <= Number(mapRect.left) || Number(mapRect.bottom) <= Number(mapRect.top)) {
    errors.push(`${screenshotPath}: cartography mapRect is missing or invalid`);
  }

  for (const [index, response] of successfulResponses.entries()) {
    const classified = response && classifyProviderUrl(response.url);
    if (!response || classified !== response.kind ||
        !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 ||
        !RASTER_CONTENT_TYPE.test(String(response.contentType || ''))) {
      errors.push(`${screenshotPath}: cartography response ${index} is not an allowed successful raster provider response`);
    }
  }
  for (const [index, tile] of visibleTiles.entries()) {
    const classified = tile && classifyProviderUrl(tile.url);
    if (!tile || classified !== tile.kind) {
      errors.push(`${screenshotPath}: visible cartography tile ${index} is not an allowed provider tile`);
      continue;
    }
    if (tile.ready !== true || tile.visible !== true || tile.intersectsMap !== true ||
        tile.decoded !== true || tile.successful !== true || tile.loading !== false || tile.error !== false ||
        !positiveFinite(tile.naturalWidth) || !positiveFinite(tile.naturalHeight) ||
        !positiveFinite(tile.rectWidth) || !positiveFinite(tile.rectHeight)) {
      errors.push(`${screenshotPath}: visible cartography tile ${index} is not a decoded successful ready tile`);
    }
  }

  const successfulUrls = new Set(successfulResponses
    .filter(response => response && response.status >= 200 && response.status < 300 &&
      RASTER_CONTENT_TYPE.test(String(response.contentType || '')))
    .map(response => canonicalUrl(response.url))
    .filter(Boolean));
  for (const kind of requiredKinds) {
    const coverage = coverageByKind[kind];
    if (!coverage || coverage.kind !== kind || coverage.complete !== true ||
        !Number.isInteger(coverage.readyTiles) || coverage.readyTiles < 1 ||
        coverage.invalidTiles !== 0 || !Number.isInteger(coverage.samplePoints) ||
        coverage.samplePoints < 1 || coverage.uncoveredCount !== 0 ||
        !Array.isArray(coverage.uncovered) || coverage.uncovered.length !== 0) {
      errors.push(`${screenshotPath}: real ${kind} tiles do not completely cover the visible map viewport`);
    }
    if (!visibleTiles.some(tile => tile && tile.kind === kind && tile.ready === true &&
        classifyProviderUrl(tile.url) === kind && successfulUrls.has(canonicalUrl(tile.url)))) {
      errors.push(`${screenshotPath}: no visible successful real ${kind} tile is recorded`);
    }
  }

  validateTileSignature(record, screenshotPath, visibleTiles, errors);
  return errors;
}

function validate(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MEDIA_MANIFEST), 'utf8'));
  const screenshotPaths = (Array.isArray(manifest.assets) ? manifest.assets : [])
    .map(asset => asset && asset.path)
    .filter(assetPath => typeof assetPath === 'string' &&
      path.posix.dirname(assetPath.replace(/\\/g, '/')) === 'docs/screenshots' &&
      path.posix.extname(assetPath).toLowerCase() === '.png')
    .sort((a, b) => a.localeCompare(b));
  const rows = [];
  const errors = [];

  for (const screenshotPath of screenshotPaths) {
    const screenshotName = path.posix.basename(screenshotPath);
    if (NON_CARTOGRAPHIC_SCREENSHOTS.has(screenshotName)) {
      rows.push({ path: screenshotPath, status: 'exempt', reason: 'rendered document preview without a map' });
      continue;
    }
    const evidencePath = path.join(
      root,
      EVIDENCE_DIRECTORY,
      `${path.posix.basename(screenshotName, '.png')}.json`
    );
    let evidence;
    try { evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); }
    catch (error) {
      const message = `${screenshotPath}: cartography evidence sidecar is missing or unreadable: ${error.message}`;
      errors.push(message);
      rows.push({ path: screenshotPath, status: 'error', errors: [message] });
      continue;
    }
    const rowErrors = validateCartographyRecord(evidence.cartography, screenshotPath);
    errors.push(...rowErrors);
    rows.push({
      path: screenshotPath,
      status: rowErrors.length === 0 ? 'valid' : 'error',
      requiredKinds: evidence.cartography && evidence.cartography.requiredKinds || [],
      visibleTiles: evidence.cartography && evidence.cartography.visibleTiles || [],
      invalidTiles: evidence.cartography && evidence.cartography.invalidTiles || [],
      coverageByKind: evidence.cartography && evidence.cartography.coverageByKind || {},
      tileSignature: evidence.cartography && evidence.cartography.tileSignature || null,
      stableSamples: evidence.cartography && evidence.cartography.stableSamples || 0,
      responses: evidence.cartography && evidence.cartography.successfulResponses || [],
      errors: rowErrors
    });
  }

  return {
    schemaVersion: 3,
    valid: screenshotPaths.length > 0 && errors.length === 0,
    revision: process.env.GITHUB_SHA || null,
    screenshots: rows,
    totals: {
      screenshots: screenshotPaths.length,
      validCartographic: rows.filter(row => row.status === 'valid').length,
      exempt: rows.filter(row => row.status === 'exempt').length
    },
    errors
  };
}

function writeReport(root, reportPath, report) {
  const absolute = path.resolve(root, reportPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('report path escapes repository root');
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
}

function main(argv) {
  const options = parseArgs(argv);
  const report = validate({ root: ROOT });
  if (options.report) writeReport(ROOT, options.report, report);
  process.stdout.write(
    `[live-cartography-evidence] ${report.totals.validCartographic} live-map screenshots valid, ` +
    `${report.totals.exempt} exempt\n`
  );
  if (!report.valid) {
    for (const error of report.errors) process.stderr.write(`ERROR\t${error}\n`);
    process.exitCode = 1;
  }
  return report;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { classifyProviderUrl, parseArgs, validate, validateCartographyRecord, writeReport };
