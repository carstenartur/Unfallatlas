'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_MANIFEST = 'docs/media-manifest.json';
const EVIDENCE_DIRECTORY = 'out/qa/screenshot-readiness';
const NON_CARTOGRAPHIC_SCREENSHOTS = new Set(['15-export-pdf-rendered.png']);
const RASTER_CONTENT_TYPE = /^image\/(?:png|jpe?g|webp)(?:;|$)/i;

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
  if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname)) return 'standard';
  if (/(^|\.)basemaps\.cartocdn\.com$/i.test(url.hostname) &&
      url.pathname.startsWith('/light_only_labels/')) return 'labels';
  if ((url.hostname === 'www.bonn.de' &&
       url.pathname.startsWith('/stadtplan-wms/services/orthofoto/MapServer/WMSServer')) ||
      (url.hostname === 'www.wms.nrw.de' && url.pathname.startsWith('/geobasis/wms_nw_dop')) ||
      (url.hostname === 'opendata.lgln.niedersachsen.de' &&
       url.pathname.startsWith('/doorman/noauth/dop_wms')) ||
      (url.hostname === 'sg.geodatenzentrum.de' && url.pathname.startsWith('/wms_dop20')) ||
      (url.hostname === 'server.arcgisonline.com' &&
       url.pathname.startsWith('/ArcGIS/rest/services/World_Imagery/MapServer/tile/'))) {
    return 'orthophoto';
  }
  return null;
}

function validateCartographyRecord(record, screenshotPath) {
  const errors = [];
  if (!record || record.source !== 'live') {
    errors.push(`${screenshotPath}: cartography source is not live`);
    return errors;
  }
  const requiredKinds = Array.isArray(record.requiredKinds) ? record.requiredKinds : [];
  const successfulResponses = Array.isArray(record.successfulResponses) ? record.successfulResponses : [];
  if (requiredKinds.length === 0 || requiredKinds.some(kind => !['standard', 'orthophoto', 'labels'].includes(kind))) {
    errors.push(`${screenshotPath}: cartography requiredKinds is empty or invalid`);
  }
  for (const [index, response] of successfulResponses.entries()) {
    const classified = response && classifyProviderUrl(response.url);
    if (!response || classified !== response.kind ||
        !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 ||
        !RASTER_CONTENT_TYPE.test(String(response.contentType || ''))) {
      errors.push(`${screenshotPath}: cartography response ${index} is not an allowed successful raster provider response`);
    }
  }
  for (const kind of requiredKinds) {
    if (!successfulResponses.some(response => response && response.kind === kind &&
        classifyProviderUrl(response.url) === kind && response.status >= 200 && response.status < 300 &&
        RASTER_CONTENT_TYPE.test(String(response.contentType || '')))) {
      errors.push(`${screenshotPath}: no successful real ${kind} response is recorded`);
    }
  }
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
      responses: evidence.cartography && evidence.cartography.successfulResponses || [],
      errors: rowErrors
    });
  }

  return {
    schemaVersion: 1,
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
