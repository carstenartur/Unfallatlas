'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pdfAsset = 'vendor/export/pdfmake.js';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function hashSourceRecords(expected) {
  return Object.entries(expected.files).map(([name, sourceSha256]) => ({
    ref: 'urn:unfallatlas:vendor-source:pdfkit:noble-hashes:' + name,
    component: '@noble/hashes in PDFKit: ' + name,
    sourcePath: expected.packagePath + '/esm/' + name,
    sourceSha256,
    spdx: 'MIT',
    path: expected.licensePath,
    sha256: expected.licenseSha256,
  }));
}

function pdfkitSourceRecords(expected) {
  return [...hashSourceRecords(expected), expected.colorProfile];
}

// PDFKit bundles part of @noble/hashes before pdfmake runs its own Webpack build.
function collectPdfkitSources(repoRoot, outputRoot, pdfmake, expected) {
  const installed = lockPath => {
    const component = pdfmake.components.find(entry => entry.lockPath === lockPath);
    if (!component?.installedPath) throw new Error('Missing PDF build component ' + lockPath);
    return path.join(repoRoot, component.installedPath);
  };
  const kit = installed('node_modules/pdfkit');
  const noble = installed(expected.packagePath);
  const bundlePath = 'js/pdfkit.browser.mjs';
  const inner = fs.readFileSync(path.join(kit, bundlePath), 'utf8');
  const mapBytes = fs.readFileSync(path.join(kit, bundlePath + '.map'));
  const sourceId = 'webpack://pdfmake/./node_modules/pdfkit/' + bundlePath;
  const outer = pdfmake.sourceMap.sources.indexOf(sourceId);
  // The one upstream Webpack replacement turns the ICC URL into a stable resource key.
  const icc = "new URL('./data/sRGB_IEC61966_2_1.icc', import.meta.url).href";
  const converted = inner.replace(icc, "'pdfkit/builtin/sRGB_IEC61966_2_1.icc'");
  if (hash(inner) !== expected.bundleSha256 || hash(mapBytes) !== expected.mapSha256 ||
      outer < 0 || pdfmake.sourceMap.sources.lastIndexOf(sourceId) !== outer ||
      converted === inner || pdfmake.sourceMap.sourcesContent[outer] !== converted) {
    throw new Error('PDFKit browser module or source map differs from the PDF exporter');
  }
  const license = fs.readFileSync(path.join(noble, 'LICENSE'));
  if (hash(license) !== expected.licenseSha256) throw new Error('PDFKit hash source license differs');
  const map = JSON.parse(mapBytes);
  const hashes = hashSourceRecords(expected);
  const externalPaths = map.sources.filter(source => source.startsWith('../node_modules/')).sort();
  const verifiedPaths = hashes.map(record => '../' + record.sourcePath).sort();
  if (JSON.stringify(externalPaths) !== JSON.stringify(verifiedPaths)) {
    throw new Error('Unexpected external sources in the PDFKit browser module');
  }
  for (const record of hashes) {
    const file = record.sourcePath.slice(expected.packagePath.length + 1);
    const source = fs.readFileSync(path.join(noble, file));
    const original = map.sourcesContent[map.sources.indexOf('../' + record.sourcePath)];
    if (typeof original !== 'string' || hash(source) !== record.sourceSha256 || !source.equals(Buffer.from(original))) {
      throw new Error('PDFKit nested source differs from its original: ' + file);
    }
  }
  const profile = expected.colorProfile;
  const bytes = fs.readFileSync(path.join(kit, 'js/data/sRGB_IEC61966_2_1.icc'));
  const profileId = '../lib/mixins/data/sRGB_IEC61966_2_1.icc';
  const profileIndex = map.sources.indexOf(profileId);
  if (hash(bytes) !== profile.sourceSha256 || profileIndex < 0 ||
      map.sources.lastIndexOf(profileId) !== profileIndex ||
      map.sourcesContent[profileIndex] !== 'export default "' + bytes.toString('base64') + '";') {
    throw new Error('PDFKit ICC profile differs from the publisher bytes or nested source map');
  }
  const notice = fs.readFileSync(path.join(repoRoot, 'vendor/pdfmake-build/licenses/ICC-sRGB2014.txt'));
  if (hash(notice) !== profile.sha256) throw new Error('ICC profile license differs from the pinned terms');
  const destination = path.join(outputRoot, profile.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, notice);
  return [...hashes, profile].map(record => ({ ...record, asset: pdfAsset, copyrightIncluded: true }));
}

module.exports = { collectPdfkitSources, pdfkitSourceRecords };
