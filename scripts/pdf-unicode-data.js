'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestFile = path.join(__dirname, '../vendor/pdfmake-build/unicode-data.json');
const asset = 'vendor/export/pdfmake.js';

function manifest(expectedHash) {
  const bytes = fs.readFileSync(manifestFile);
  if (sha256(bytes) !== expectedHash) throw new Error('Unicode source manifest differs from the PDF inventory');
  return JSON.parse(bytes);
}

function unicodeDataRecords(expectedHash) {
  const { sources, license, outputs } = manifest(expectedHash);
  return outputs.map(item => ({
    ref: 'urn:unfallatlas:vendor-source:ucd:' + item.package + ':' + item.file,
    component: item.package + ' generated ' + item.file,
    sourcePath: item.package + '/' + item.file,
    sourceSha256: item.sha256,
    sourceUrl: sources[item.ucd].url,
    spdx: license.spdx,
    copyright: license.copyright,
    licenseUrl: license.url,
    path: 'vendor/licenses/components/' + license.file,
    sha256: license.sha256,
  }));
}

function collectUnicodeData(repo, out, outer, expectedHash) {
  const evidence = manifest(expectedHash);
  const records = unicodeDataRecords(expectedHash);
  // Standalone notice generation also supports a checkout before assets are copied.
  const delivered = path.join(out, asset);
  const bundle = fs.readFileSync(fs.existsSync(delivered)
    ? delivered : path.join(repo, 'node_modules/pdfmake/build/pdfmake.min.js'), 'utf8');
  for (const item of evidence.outputs) {
    const modulePath = 'node_modules/' + item.package + '/dist/module.mjs';
    const id = 'webpack://pdfmake/./' + modulePath;
    const index = outer.sources.indexOf(id);
    const source = fs.readFileSync(path.join(repo, modulePath), 'utf8');
    if (index < 0 || outer.sources.lastIndexOf(id) !== index || source !== outer.sourcesContent[index]) {
      throw new Error('Unicode module differs from PDF source map: ' + modulePath);
    }
    const candidates = item.encoding === 'json'
      ? [...source.matchAll(/JSON\.parse\('([^']+)'\)/g)].map(match => match[1])
      : [...source.matchAll(/"([A-Za-z0-9+/=]{100,})"/g)].map(match => match[1]);
    const verified = candidates.filter(value => {
      const bytes = Buffer.from(value, item.encoding === 'json' ? 'utf8' : 'base64');
      return bytes.length === item.bytes && sha256(bytes) === item.sha256;
    });
    const value = verified[0];
    if (verified.length !== 1 || !bundle.includes(value) || bundle.indexOf(value) !== bundle.lastIndexOf(value)) {
      throw new Error('Regenerated Unicode bytes differ from the delivered PDF: ' + item.file);
    }
  }
  const terms = fs.readFileSync(path.join(repo, 'vendor/pdfmake-build/licenses', evidence.license.file));
  if (sha256(terms) !== evidence.license.sha256) throw new Error('Unexpected Unicode data license');
  const destination = path.join(out, records[0].path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, terms);
  return records.map(record => ({ ...record, asset, copyrightIncluded: true }));
}

module.exports = { collectUnicodeData, unicodeDataRecords };
