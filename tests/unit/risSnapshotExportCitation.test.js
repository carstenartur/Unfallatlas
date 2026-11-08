/** @jest-environment node */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const JSZip = require('jszip');
const hash = '0123456789abcdef'.repeat(4), mapHash = 'fedcba9876543210'.repeat(4);
const snapshot = { generatedAt: '2026-11-07T09:00:00.000Z', sha256: hash, mapSha256: mapHash,
  complete: false, stale: true, warnings: ['Amtliche Auswahl bleibt eingeschränkt.'] };
const reference = { title: 'Schulwegsicherheit', url: 'https://example.org/ris/one', type: 'Antrag', source: 'RIS', snapshot };
const load = (win, name) => new Function('window', fs.readFileSync(path.resolve(__dirname, '../../js', name), 'utf8'))(win);
const bounds = { getSouthWest: () => ({ lat: 52, lng: 9 }), getNorthEast: () => ({ lat: 53, lng: 10 }), contains: () => true };
let win, savedFetch;
beforeEach(() => {
  savedFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  win = { UA: {}, location: { href: 'https://example.org/' }, fetch: global.fetch, L: { latLngBounds: () => {} } };
  for (const script of ['ua.utils.js', 'ua.filters.js', 'ua.accident_views.js', 'ua.export_v2.js']) load(win, script);
});
afterEach(() => { global.fetch = savedFetch; jest.restoreAllMocks(); });
function expectCitation(text, distinct = true) {
  expect(text).toContain('Recherchequelle: veröffentlichter Ratsdaten-Snapshot');
  expect(text.replace(/\s+/g, '')).toContain(('Snapshot-SHA-256: ' + hash).replace(/\s+/g, ''));
  if (distinct) expect(text.replace(/\s+/g, '')).toContain(('Karten-SHA-256: ' + mapHash).replace(/\s+/g, ''));
  else expect(text).not.toContain('Karten-SHA-256:');
  expect(text).toContain('Katalogstand: 2026-11-07');
  expect(text).toContain('Katalogabdeckung: eingeschränkt');
  expect(text).toContain('Der Katalogstand ist veraltet.');
  expect(text).toContain('Amtliche Auswahl bleibt eingeschränkt.');
}
test.each([true, false])('text and HTML include full immutable digests without repeating a v2 map digest (distinct=%s)', async distinct => {
  const ref = { ...reference, snapshot: { ...snapshot, mapSha256: distinct ? mapHash : hash } };
  const report = await win.UA.computeExportReport({ CITY_RAW: 'Bonn', allPts: [], selectionBounds: bounds, ui: {},
    politicalReferences: [ref], exportOptions: { includeCosts: false, includeMeasures: false } });
  expectCitation(report.text, distinct); expectCitation(report.html, distinct);
  const ordinary = await win.UA.computeExportReport({ CITY_RAW: 'Bonn', allPts: [], selectionBounds: bounds, ui: {},
    politicalReferences: [{ ...ref, snapshot: undefined }], exportOptions: { includeCosts: false, includeMeasures: false } });
  expect(ordinary.text).not.toContain('Snapshot-SHA-256:');
});

test('real DOCX and rendered PDF preserve full digests and permit line wrapping', async () => {
  win.docx = require('docx');
  win.pdfMake = require('../../scripts/pdfmake-node');
  win.saveAs = () => {};
  load(win, 'ua.report_v2.js');
  const report = { text: 'Sachverhalt:\nAmtlicher Bezug\n\nBeschlussvorschlag:\nSchulweg prüfen', structured: {
    meta: { city: 'Bonn', date: '08.11.2026', gremium: { typ: 'Rat' } }, politicalReferences: [reference] } };
  let docxBytes;
  jest.spyOn(win.docx.Packer, 'toBlob').mockImplementation(async doc => { docxBytes = await win.docx.Packer.toBuffer(doc); return new Blob([docxBytes]); });
  await win.UA.exportToWord({ CITY_RAW: 'Bonn' }, report, { includeMap: false, includeReferences: true, _skipQAGate: true });
  const zip = await JSZip.loadAsync(docxBytes);
  const xml = await zip.file('word/document.xml').async('string');
  expectCitation(xml.replace(/<[^>]+>/g, ' '));
  const createPdf = win.pdfMake.createPdf.bind(win.pdfMake);
  let document;
  jest.spyOn(win.pdfMake, 'createPdf').mockImplementation(def => { document = createPdf(def); document.download = () => {}; return document; });
  await win.UA.exportToPDF({ CITY_RAW: 'Bonn' }, report, { includeMap: false, includeReferences: true, _skipQAGate: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ris-citation-render-'));
  try {
    const file = path.join(dir, 'citation.pdf');
    fs.writeFileSync(file, await document.getBuffer());
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    expectCitation(text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
