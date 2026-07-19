'use strict';

const fs = require('fs');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(source, oldValue, newValue, label) {
  const matches = source.split(oldValue).length - 1;
  if (matches !== 1) throw new Error(`${label}: expected one match, found ${matches}`);
  return source.replace(oldValue, newValue);
}

function addBasemapRequirement(source, screenshotPath, requirement) {
  const escaped = screenshotPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(path:\\s*'${escaped}',[\\s\\S]*?layers:\\s*\\[[^\\]]+\\])`);
  const match = source.match(pattern);
  if (!match) throw new Error(`Screenshot block not found: ${screenshotPath}`);
  if (match[1].includes('basemap:')) return source;
  return source.replace(match[1], `${match[1]},\n      basemap: '${requirement}'`);
}

let path = 'tests/e2e/screenshots.spec.js';
let source = read(path);
const blockStart = source.indexOf('const DETERMINISTIC_MAP_TILES = Object.freeze({');
const blockEnd = source.indexOf('/**\n * Frame the fixed-height panel', blockStart);
if (blockStart < 0 || blockEnd < 0) throw new Error('Screenshot network block not found');

const networkBlock = String.raw`const SCREENSHOT_PROFILE = process.env.UA_SCREENSHOT_PROFILE === 'publication'
  ? 'publication'
  : 'regression';

const DETERMINISTIC_MAP_TILES = Object.freeze({
  standard: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/standard.svg')),
  orthophoto: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/orthophoto.svg')),
  labels: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/labels.svg'))
});
const DETERMINISTIC_EXTERNAL_DATA = Object.freeze({
  nominatim: Object.freeze({
    bonn: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/nominatim-reverse-bonn.json')),
    hannover: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/nominatim-reverse-hannover.json'))
  }),
  overpass: Object.freeze({
    bonn: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/overpass-bonn.json')),
    hannover: readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/overpass-hannover.json'))
  })
});
const SCREENSHOT_NETWORK = new WeakMap();

function classifyMapResource(rawUrl) {
  const url = new URL(rawUrl);
  if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname)) {
    return { kind: 'standard', provider: 'OpenStreetMap', officialForExport: true };
  }
  if (/(^|\.)basemaps\.cartocdn\.com$/i.test(url.hostname) &&
      url.pathname.startsWith('/light_only_labels/')) {
    return { kind: 'labels', provider: 'CARTO / OpenStreetMap', officialForExport: true };
  }
  if (url.hostname === 'www.bonn.de' &&
      url.pathname.startsWith('/stadtplan-wms/services/orthofoto/MapServer/WMSServer')) {
    return { kind: 'orthophoto', provider: 'Bundesstadt Bonn', officialForExport: true };
  }
  if (url.hostname === 'www.wms.nrw.de' && url.pathname.startsWith('/geobasis/wms_nw_dop')) {
    return { kind: 'orthophoto', provider: 'Geobasis NRW', officialForExport: true };
  }
  if (url.hostname === 'opendata.lgln.niedersachsen.de' &&
      url.pathname.startsWith('/doorman/noauth/dop_wms')) {
    return { kind: 'orthophoto', provider: 'LGLN Niedersachsen', officialForExport: true };
  }
  if (url.hostname === 'sg.geodatenzentrum.de' && url.pathname.startsWith('/wms_dop20')) {
    return { kind: 'orthophoto', provider: 'BKG', officialForExport: true };
  }
  if (url.hostname === 'server.arcgisonline.com' &&
      url.pathname.startsWith('/ArcGIS/rest/services/World_Imagery/MapServer/tile/')) {
    return { kind: 'orthophoto', provider: 'Esri', officialForExport: false };
  }
  return null;
}

function isAuthenticRaster(response) {
  return response && response.status >= 200 && response.status < 300 &&
    /^image\/(?:png|jpe?g|webp)(?:;|$)/i.test(String(response.contentType || '')) &&
    response.fixture !== true;
}

function summarizedMapResponses(page) {
  const state = SCREENSHOT_NETWORK.get(page) || { responses: [] };
  const grouped = new Map();
  for (const response of state.responses) {
    const key = [response.kind, response.provider, response.officialForExport,
      response.status, response.contentType, response.fixture].join('\t');
    const current = grouped.get(key) || { ...response, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).sort((a, b) =>
    `${a.kind}\t${a.provider}\t${a.status}`.localeCompare(`${b.kind}\t${b.provider}\t${b.status}`));
}

function assertAuthenticBasemap(basemap, requirement, screenshotPath) {
  const responses = basemap.responses || [];
  const standard = responses.some(response => response.kind === 'standard' && isAuthenticRaster(response));
  const labels = responses.some(response => response.kind === 'labels' && isAuthenticRaster(response));
  const officialOrthophoto = responses.some(response =>
    response.kind === 'orthophoto' && response.officialForExport === true && isAuthenticRaster(response));
  const orthophotoFailure = responses.some(response =>
    response.kind === 'orthophoto' && (response.status >= 400 || response.status === 0));
  const hasOsmAttribution = /OpenStreetMap/i.test(String(basemap.attribution || ''));
  let valid = false;
  if (requirement === 'standard') valid = standard && hasOsmAttribution;
  else if (requirement === 'orthophoto') valid = officialOrthophoto;
  else if (requirement === 'hybrid') valid = officialOrthophoto && labels && hasOsmAttribution;
  else if (requirement === 'fallback') valid = orthophotoFailure && standard && hasOsmAttribution;
  if (!valid) {
    throw new Error(`Publication screenshot lacks authentic ${requirement} basemap evidence: ${screenshotPath}\n` +
      JSON.stringify(basemap, null, 2));
  }
}

async function collectBasemapCapture(page, requirement, screenshotPath) {
  const ui = await page.evaluate(() => ({
    attribution: (document.querySelector('.leaflet-control-attribution')?.textContent || '').trim(),
    mapLayerStatus: (document.querySelector('#mapLayerStatus')?.textContent || '').trim()
  }));
  const capture = {
    profile: SCREENSHOT_PROFILE,
    basemap: {
      requirement,
      authentic: false,
      ...ui,
      responses: summarizedMapResponses(page)
    }
  };
  if (SCREENSHOT_PROFILE === 'publication') {
    assertAuthenticBasemap(capture.basemap, requirement, screenshotPath);
    capture.basemap.authentic = true;
  }
  return capture;
}

async function attachBasemapCapture(screenshotPath, capture) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const sidecarPath = path.resolve(process.cwd(), 'out/qa/screenshot-readiness',
    `${path.basename(screenshotPath, path.extname(screenshotPath))}.json`);
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  sidecar.capture = capture;
  await fs.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
}

async function captureDocumentationScreenshot(page, options) {
  const snapshot = await captureDataScreenshot(page, options);
  await attachBasemapCapture(options.path,
    await collectBasemapCapture(page, options.basemap || 'standard', options.path));
  return snapshot;
}

async function setupScreenshotNetwork(page, options = {}) {
  const { orthophotoAvailable = true } = options;
  const state = { responses: [], unexpectedExternalRequests: [] };
  SCREENSHOT_NETWORK.set(page, state);
  page.on('response', response => {
    const mapResource = classifyMapResource(response.url());
    if (!mapResource) return;
    state.responses.push({
      ...mapResource,
      status: response.status(),
      contentType: response.headers()['content-type'] || '',
      fixture: SCREENSHOT_PROFILE === 'regression'
    });
  });
  await page.route(/^https:\/\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const mapResource = classifyMapResource(request.url());
    const nominatimFixture = classifyNominatimFixture(request.url());
    const overpassFixture = classifyOverpassFixture(request.url(),
      request.postDataBuffer() || request.postData());
    if (nominatimFixture) {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
        body: DETERMINISTIC_EXTERNAL_DATA.nominatim[nominatimFixture] });
      return;
    }
    if (overpassFixture) {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
        body: DETERMINISTIC_EXTERNAL_DATA.overpass[overpassFixture] });
      return;
    }
    if (url.hostname === 'pdfjs-test-cdn') {
      await route.fallback();
      return;
    }
    if (mapResource) {
      if (!orthophotoAvailable && mapResource.kind === 'orthophoto') {
        await route.fulfill({ status: 503, contentType: 'text/plain; charset=utf-8',
          body: 'Orthophoto unavailable' });
        return;
      }
      if (SCREENSHOT_PROFILE === 'regression') {
        const body = mapResource.kind === 'standard' ? DETERMINISTIC_MAP_TILES.standard
          : mapResource.kind === 'labels' ? DETERMINISTIC_MAP_TILES.labels
            : DETERMINISTIC_MAP_TILES.orthophoto;
        await route.fulfill({ status: 200, contentType: 'image/svg+xml', body });
        return;
      }
      await route.continue();
      return;
    }
    state.unexpectedExternalRequests.push(`${request.method()} ${request.resourceType()} ${request.url()}`);
    await route.abort('blockedbyclient');
  });
}

function assertNoUnexpectedExternalRequests(page) {
  const unexpected = (SCREENSHOT_NETWORK.get(page) || { unexpectedExternalRequests: [] })
    .unexpectedExternalRequests;
  if (unexpected.length) {
    throw new Error(`Screenshot requested unapproved external resources:\n${unexpected.join('\n')}`);
  }
}

`;

source = source.slice(0, blockStart) + networkBlock + source.slice(blockEnd);
source = source.replaceAll('setupDeterministicBasemapTiles', 'setupScreenshotNetwork');
source = source.replaceAll('await captureDataScreenshot(page, {', 'await captureDocumentationScreenshot(page, {');
source = addBasemapRequirement(source, 'docs/screenshots/22-mapmode-orthophoto.png', 'orthophoto');
source = addBasemapRequirement(source, 'docs/screenshots/23-mapmode-hybrid.png', 'hybrid');
source = addBasemapRequirement(source, 'docs/screenshots/24-mapmode-analysis.png', 'orthophoto');
source = addBasemapRequirement(source, 'docs/screenshots/25-mapmode-orthophoto-fallback.png', 'fallback');
source = replaceOnce(source,
  "    const readinessSnapshot = await waitForScreenshotReady(page, { city: 'Bonn', layers: ['cluster'] });\n",
  "    const readinessSnapshot = await waitForScreenshotReady(page, { city: 'Bonn', layers: ['cluster'] });\n" +
  "    const pdfBasemapCapture = await collectBasemapCapture(page, 'standard', 'docs/screenshots/15-export-pdf-rendered.png');\n",
  'PDF basemap capture');
source = replaceOnce(source,
  "    // Kartenausschnitt deaktivieren (vermeidet leaflet-image-Abhängigkeit)\n" +
  "    await page.locator('#cbIncludeMap').uncheck();\n",
  "    // The publication PDF must contain its actual map section.\n" +
  "    await expect(page.locator('#cbIncludeMap')).toBeChecked();\n",
  'PDF map enabled');
source = replaceOnce(source,
  "    await recordScreenshotEvidence(screenshotPath, afterCaptureSnapshot, {\n" +
  "      city: 'Bonn',\n" +
  "      layers: ['cluster']\n" +
  "    });\n",
  "    await recordScreenshotEvidence(screenshotPath, afterCaptureSnapshot, {\n" +
  "      city: 'Bonn',\n" +
  "      layers: ['cluster']\n" +
  "    });\n" +
  "    await attachBasemapCapture(screenshotPath, pdfBasemapCapture);\n",
  'PDF evidence attachment');
write(path, source);

path = 'scripts/validate-screenshot-evidence.js';
source = read(path);
source = replaceOnce(source, "  const args = { report: null };",
  "  const args = { report: null, requireAuthenticBasemap: false };", 'validator args');
source = replaceOnce(source,
  "    if (argv[index] === '--report') args.report = argv[++index] || null;\n" +
  "    else throw new Error(`[validate-screenshot-evidence] Unknown argument: ${argv[index]}`);",
  "    if (argv[index] === '--report') args.report = argv[++index] || null;\n" +
  "    else if (argv[index] === '--require-authentic-basemap') args.requireAuthenticBasemap = true;\n" +
  "    else throw new Error(`[validate-screenshot-evidence] Unknown argument: ${argv[index]}`);",
  'validator flag');
const validatorHelper = String.raw`function validateAuthenticBasemap(evidence, screenshotPath, requirement, errors) {
  const capture = evidence && evidence.capture;
  const basemap = capture && capture.basemap;
  if (!capture || capture.profile !== 'publication' || !basemap || basemap.authentic !== true) {
    errors.push(`${screenshotPath}: authentic publication basemap evidence is missing`);
    return;
  }
  const responses = Array.isArray(basemap.responses) ? basemap.responses : [];
  const raster = response => response && response.status >= 200 && response.status < 300 &&
    /^image\/(?:png|jpe?g|webp)(?:;|$)/i.test(String(response.contentType || '')) &&
    response.fixture !== true;
  if (responses.some(response => /svg/i.test(String(response.contentType || '')) || response.fixture === true)) {
    errors.push(`${screenshotPath}: synthetic/SVG map responses cannot certify publication media`);
  }
  const standard = responses.some(response => response.kind === 'standard' && raster(response));
  const labels = responses.some(response => response.kind === 'labels' && raster(response));
  const officialOrthophoto = responses.some(response =>
    response.kind === 'orthophoto' && response.officialForExport === true && raster(response));
  const orthophotoFailure = responses.some(response =>
    response.kind === 'orthophoto' && (response.status >= 400 || response.status === 0));
  const osm = /OpenStreetMap/i.test(String(basemap.attribution || ''));
  const valid = requirement === 'standard' ? standard && osm
    : requirement === 'orthophoto' ? officialOrthophoto
      : requirement === 'hybrid' ? officialOrthophoto && labels && osm
        : requirement === 'fallback' ? orthophotoFailure && standard && osm
          : false;
  if (!valid) errors.push(`${screenshotPath}: authentic ${requirement} basemap requirement is not met`);
}

`;
source = source.replace('function listFlatFiles(directory, suffix, label, options = {}) {',
  validatorHelper + 'function listFlatFiles(directory, suffix, label, options = {}) {');
source = replaceOnce(source,
  "    const expectedScreenshots = (Array.isArray(mediaManifest.assets) ? mediaManifest.assets : [])\n" +
  "      .map(asset => asset && asset.path)",
  "    const manifestAssets = Array.isArray(mediaManifest.assets) ? mediaManifest.assets : [];\n" +
  "    const manifestAssetsByPath = new Map(manifestAssets.map(asset => [asset && asset.path, asset]));\n" +
  "    const defaultBasemapRequirement = mediaManifest.defaults && mediaManifest.defaults.publicationBasemap || 'standard';\n" +
  "    const expectedScreenshots = manifestAssets\n" +
  "      .map(asset => asset && asset.path)",
  'validator manifest index');
source = replaceOnce(source,
  '        validateLifecycle(evidence, screenshotPath, rowErrors);\n',
  "        validateLifecycle(evidence, screenshotPath, rowErrors);\n" +
  "        if (options.requireAuthenticBasemap === true) {\n" +
  "          const manifestAsset = manifestAssetsByPath.get(screenshotPath) || {};\n" +
  "          validateAuthenticBasemap(evidence, screenshotPath,\n" +
  "            manifestAsset.basemap || defaultBasemapRequirement, rowErrors);\n" +
  "        }\n",
  'validator authentic gate');
source = replaceOnce(source, '  const report = validate({ root: ROOT });',
  '  const report = validate({ root: ROOT, requireAuthenticBasemap: args.requireAuthenticBasemap });',
  'validator main');
write(path, source);

path = 'scripts/validate-doc-media.js';
source = read(path);
const mediaHelper = validatorHelper
  .replace('validateAuthenticBasemap(evidence, screenshotPath, requirement, errors)',
    'validatePublicationBasemapSidecar(sidecar, requirement, label, errors)')
  .replaceAll('evidence && evidence.capture', 'sidecar && sidecar.capture')
  .replaceAll('screenshotPath', 'label');
source = source.replace('function validateScreenshotEvidenceLedger(repoRoot, manifest, assets) {',
  mediaHelper + 'function validateScreenshotEvidenceLedger(repoRoot, manifest, assets) {');
source = replaceOnce(source, '  const expectedPaths = assets\n',
  "  const requirePublicationBasemap = manifest && manifest.defaults &&\n" +
  "    manifest.defaults.requirePublicationBasemapEvidence === true;\n" +
  "  const defaultBasemapRequirement = manifest && manifest.defaults &&\n" +
  "    manifest.defaults.publicationBasemap || 'standard';\n" +
  "  const assetsByPath = new Map(assets.map(asset => [asset && asset.path, asset]));\n" +
  '  const expectedPaths = assets\n', 'media policy');
source = replaceOnce(source, '    const shot = sidecar && sidecar.screenshot || {};\n',
  "    const shot = sidecar && sidecar.screenshot || {};\n" +
  "    if (requirePublicationBasemap) {\n" +
  "      const asset = assetsByPath.get(entryPath) || {};\n" +
  "      validatePublicationBasemapSidecar(sidecar,\n" +
  "        asset.basemap || defaultBasemapRequirement, sidecarName, errors);\n" +
  "    }\n", 'media ledger gate');
write(path, source);

path = 'package.json';
const packageJson = JSON.parse(read(path));
packageJson.scripts['test:screenshots:regression'] =
  'UA_SCREENSHOT_PROFILE=regression playwright test tests/e2e/screenshots.spec.js --project=chromium';
packageJson.scripts['generate:screenshots:publication'] =
  'UA_SCREENSHOT_PROFILE=publication playwright test tests/e2e/screenshots.spec.js --project=chromium';
write(path, `${JSON.stringify(packageJson, null, 2)}\n`);

path = '.github/workflows/generate-screenshots.yml';
source = read(path)
  .replace('name: Generate Documentation Screenshots', 'name: Generate Publication Screenshots')
  .replace('run: npx playwright test tests/e2e/screenshots.spec.js --project=chromium',
    'run: npm run generate:screenshots:publication')
  .replace('npm run validate:screenshot-evidence -- --report',
    'npm run validate:screenshot-evidence -- --require-authentic-basemap --report')
  .replace('name: documentation-screenshots-${{ github.sha }}',
    'name: publication-screenshots-${{ github.sha }}');
write(path, source);

path = '.github/workflows/visual-check.yml';
source = read(path)
  .replace('run: npx playwright test tests/e2e/screenshots.spec.js --project=chromium',
    'run: npm run test:screenshots:regression')
  .replaceAll('pr-screenshots-${{ github.event.pull_request.number }}',
    'pr-screenshot-regression-${{ github.event.pull_request.number }}');
write(path, source);

path = '.github/workflows/test.yml';
source = read(path).replace(
  '      - name: Run E2E tests\n        run: npm run test:e2e',
  '      - name: Run E2E tests with deterministic regression maps\n' +
  '        env:\n          UA_SCREENSHOT_PROFILE: regression\n' +
  '        run: npm run test:e2e');
write(path, source);

path = 'docs/media-manifest.json';
const manifest = JSON.parse(read(path));
manifest.defaults.requirePublicationBasemapEvidence = true;
manifest.defaults.publicationBasemap = 'standard';
const assets = new Map(manifest.assets.map(asset => [asset.path, asset]));
assets.get('docs/screenshots/15-export-pdf-rendered.png').purpose =
  'Gerenderter PDF-Export mit aktiviertem Kartenausschnitt und authentischer Basiskarte.';
assets.get('docs/screenshots/21-mapmode-standard.png').purpose =
  'Publikationsansicht mit echter OpenStreetMap-Grundkarte.';
assets.get('docs/screenshots/22-mapmode-orthophoto.png').basemap = 'orthophoto';
assets.get('docs/screenshots/23-mapmode-hybrid.png').basemap = 'hybrid';
assets.get('docs/screenshots/24-mapmode-analysis.png').basemap = 'orthophoto';
assets.get('docs/screenshots/25-mapmode-orthophoto-fallback.png').basemap = 'fallback';
write(path, `${JSON.stringify(manifest, null, 2)}\n`);

path = 'docs/screenshots/README.md';
source = read(path).replace(
  /## Deterministische Grundkarte[\s\S]*?(?=\n## Review-Kandidaten)/,
  '## Getrennte Regressions- und Publikationsverträge\n\n' +
  'Automatische PR-/E2E-Läufe verwenden synthetische SVG-Tiles ausschließlich für reproduzierbare Regressionstests. ' +
  'Diese Artefakte sind keine Dokumentationsmedien. Eingecheckte Screenshots müssen aus dem Publikationsprofil stammen: ' +
  'echte allowlist-geprüfte Rasterkarten, Providerstatus und sichtbare Attribution werden im Evidence-Sidecar gebunden; ' +
  'SVG-/Fixture-Antworten werden fail-closed abgelehnt.\n');
write(path, source);
