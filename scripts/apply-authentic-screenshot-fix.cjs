'use strict';

const fs = require('fs');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(source, oldValue, newValue, label) {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
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
source = source.replace("import { readFileSync } from 'node:fs';\n", '');
source = source.replace("import { resolve } from 'node:path';\n", '');
source = replaceOnce(source,
  "import networkFixtureRouting from './fixtures/network/routing.cjs';\n",
  "import networkFixtureRouting from './fixtures/network/routing.cjs';\n" +
  "import {\n" +
  "  assertNoUnexpectedScreenshotRequests,\n" +
  "  attachBasemapCapture,\n" +
  "  collectBasemapCapture,\n" +
  "  setupScreenshotNetwork\n" +
  "} from './screenshot-map-profile.js';\n",
  'screenshot profile import');

const blockStart = source.indexOf('const DETERMINISTIC_MAP_TILES = Object.freeze({');
const blockEnd = source.indexOf('/**\n * Frame the fixed-height panel', blockStart);
if (blockStart < 0 || blockEnd < 0) throw new Error('Old deterministic map block not found');
source = source.slice(0, blockStart) + source.slice(blockEnd);
source = source.replaceAll('await captureDataScreenshot(page, {', 'await captureDocumentationScreenshot(page, {');
source = source.replaceAll('assertNoUnexpectedExternalRequests', 'assertNoUnexpectedScreenshotRequests');
source = source.replaceAll(
  'await setupDeterministicBasemapTiles(page, {',
  'await setupScreenshotNetwork(page, classifyNominatimFixture, classifyOverpassFixture, {');
source = source.replaceAll(
  'await setupDeterministicBasemapTiles(page);',
  'await setupScreenshotNetwork(page, classifyNominatimFixture, classifyOverpassFixture);');

const wrapperAnchor = "function parseLocalAccidentCount(text) {\n" +
  "  const match = String(text || '').match(/lokal\\s+([\\d.\\s]+)\\s+Unfälle/i);\n" +
  "  if (!match) return 0;\n" +
  "  return Number(match[1].replace(/\\D/g, '')) || 0;\n" +
  "}\n";
const wrapper = wrapperAnchor +
  "\nasync function captureDocumentationScreenshot(page, options) {\n" +
  "  const snapshot = await captureDataScreenshot(page, options);\n" +
  "  const capture = await collectBasemapCapture(\n" +
  "    page, options.basemap || 'standard', options.path);\n" +
  "  await attachBasemapCapture(options.path, capture);\n" +
  "  return snapshot;\n" +
  "}\n";
source = replaceOnce(source, wrapperAnchor, wrapper, 'capture wrapper');
source = addBasemapRequirement(source, 'docs/screenshots/22-mapmode-orthophoto.png', 'orthophoto');
source = addBasemapRequirement(source, 'docs/screenshots/23-mapmode-hybrid.png', 'hybrid');
source = addBasemapRequirement(source, 'docs/screenshots/24-mapmode-analysis.png', 'orthophoto');
source = addBasemapRequirement(source, 'docs/screenshots/25-mapmode-orthophoto-fallback.png', 'fallback');
source = replaceOnce(source,
  "    const readinessSnapshot = await waitForScreenshotReady(page, { city: 'Bonn', layers: ['cluster'] });\n",
  "    const readinessSnapshot = await waitForScreenshotReady(page, { city: 'Bonn', layers: ['cluster'] });\n" +
  "    const pdfBasemapCapture = await collectBasemapCapture(\n" +
  "      page, 'standard', 'docs/screenshots/15-export-pdf-rendered.png');\n",
  'PDF basemap capture');
source = replaceOnce(source,
  "    // Kartenausschnitt deaktivieren (vermeidet leaflet-image-Abhängigkeit)\n" +
  "    await page.locator('#cbIncludeMap').uncheck();\n",
  "    // Publication evidence must exercise the real map export path.\n" +
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
  'PDF basemap evidence');
write(path, source);

path = 'scripts/validate-screenshot-evidence.js';
source = read(path);
source = replaceOnce(source,
  "const path = require('path');\n",
  "const path = require('path');\n" +
  "const { validatePublicationBasemap } = require('./screenshot-basemap-evidence.cjs');\n",
  'evidence validator import');
source = replaceOnce(source,
  '  const args = { report: null };',
  '  const args = { report: null, requireAuthenticBasemap: false };',
  'evidence validator args');
source = replaceOnce(source,
  "    if (argv[index] === '--report') args.report = argv[++index] || null;\n" +
  "    else throw new Error(`[validate-screenshot-evidence] Unknown argument: ${argv[index]}`);",
  "    if (argv[index] === '--report') args.report = argv[++index] || null;\n" +
  "    else if (argv[index] === '--require-authentic-basemap') args.requireAuthenticBasemap = true;\n" +
  "    else throw new Error(`[validate-screenshot-evidence] Unknown argument: ${argv[index]}`);",
  'evidence validator flag');
source = replaceOnce(source,
  "    const expectedScreenshots = (Array.isArray(mediaManifest.assets) ? mediaManifest.assets : [])\n" +
  "      .map(asset => asset && asset.path)",
  "    const manifestAssets = Array.isArray(mediaManifest.assets) ? mediaManifest.assets : [];\n" +
  "    const manifestAssetsByPath = new Map(manifestAssets.map(asset => [asset && asset.path, asset]));\n" +
  "    const defaultBasemapRequirement = mediaManifest.defaults && mediaManifest.defaults.publicationBasemap || 'standard';\n" +
  "    const expectedScreenshots = manifestAssets\n" +
  "      .map(asset => asset && asset.path)",
  'evidence manifest index');
source = replaceOnce(source,
  '        validateLifecycle(evidence, screenshotPath, rowErrors);\n',
  "        validateLifecycle(evidence, screenshotPath, rowErrors);\n" +
  "        if (options.requireAuthenticBasemap === true) {\n" +
  "          const manifestAsset = manifestAssetsByPath.get(screenshotPath) || {};\n" +
  "          validatePublicationBasemap(\n" +
  "            evidence.capture,\n" +
  "            manifestAsset.basemap || defaultBasemapRequirement,\n" +
  "            screenshotPath,\n" +
  "            rowErrors\n" +
  "          );\n" +
  "        }\n",
  'evidence authentic gate');
source = replaceOnce(source,
  '  const report = validate({ root: ROOT });',
  '  const report = validate({ root: ROOT, requireAuthenticBasemap: args.requireAuthenticBasemap });',
  'evidence main');
write(path, source);

path = 'scripts/validate-doc-media.js';
source = read(path);
source = replaceOnce(source,
  "const path = require('path');\n",
  "const path = require('path');\n" +
  "const { validatePublicationBasemap } = require('./screenshot-basemap-evidence.cjs');\n",
  'media validator import');
source = replaceOnce(source,
  '  const expectedPaths = assets\n',
  "  const requirePublicationBasemap = manifest && manifest.defaults &&\n" +
  "    manifest.defaults.requirePublicationBasemapEvidence === true;\n" +
  "  const defaultBasemapRequirement = manifest && manifest.defaults &&\n" +
  "    manifest.defaults.publicationBasemap || 'standard';\n" +
  "  const assetsByPath = new Map(assets.map(asset => [asset && asset.path, asset]));\n" +
  '  const expectedPaths = assets\n',
  'media policy');
source = replaceOnce(source,
  '    const shot = sidecar && sidecar.screenshot || {};\n',
  "    const shot = sidecar && sidecar.screenshot || {};\n" +
  "    if (requirePublicationBasemap) {\n" +
  "      const asset = assetsByPath.get(entryPath) || {};\n" +
  "      validatePublicationBasemap(\n" +
  "        sidecar.capture,\n" +
  "        asset.basemap || defaultBasemapRequirement,\n" +
  "        sidecarName,\n" +
  "        errors\n" +
  "      );\n" +
  "    }\n",
  'media authentic gate');
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
