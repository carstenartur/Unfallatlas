/** @jest-environment node */
'use strict';

const { createHash } = require('node:crypto');
const docx = require('docx');
const JSZip = require('jszip');
const { createDeterministicMapPng } = require('../../scripts/deterministic-map-fixture');
const { inspectDocx, assertPreserved } = require('../../scripts/lib/docx-package-audit');

const URL = 'https://example.org/dataset';
const MAIN = 'word/document.xml';
const RELATIONSHIPS = 'word/_rels/document.xml.rels';

let bytes;

beforeAll(async () => {
  const cell = text => new docx.TableCell({ children: [new docx.Paragraph(text)] });
  const image = new docx.ImageRun({
    type: 'png', data: createDeterministicMapPng({ width: 300, height: 200 }),
    transformation: { width: 300, height: 200 },
    altText: { name: 'map', title: 'Unfallkarte', description: 'Unfall A001 im Ausschnitt' },
  });
  bytes = await docx.Packer.toBuffer(new docx.Document({ sections: [{
    properties: { page: { size: { orientation: docx.PageOrientation.LANDSCAPE } } },
    children: [
      new docx.Paragraph({ text: 'Quelle', keepNext: true }),
      new docx.Paragraph({ children: [new docx.ExternalHyperlink({
        link: URL, children: [new docx.TextRun('Unfallatlas')],
      })] }),
      new docx.Paragraph({ children: [image] }),
      new docx.Table({ rows: [
        new docx.TableRow({ tableHeader: true, cantSplit: true, children: [cell('ID'), cell('Jahr')] }),
        new docx.TableRow({ cantSplit: true, children: [cell('A001'), cell('2024')] }),
      ] }),
    ],
  }] }));
}, 20000);

async function change(bytes, part, transform) {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(part, transform(await zip.file(part).async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('reads WordprocessingML content, images and page controls from a real DOCX', async () => {
  const document = await inspectDocx(bytes);
  expect(document.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(document.signature).toMatchObject({
    paragraphs: expect.arrayContaining([{ text: 'Quelle', keepNext: true }]),
    tables: [[
      { repeatedHeader: true, cantSplit: true, cells: ['ID', 'Jahr'] },
      { repeatedHeader: false, cantSplit: true, cells: ['A001', '2024'] },
    ]],
    pageSizes: [expect.objectContaining({ orientation: 'landscape' })],
    links: [URL],
    images: [expect.objectContaining({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      title: 'Unfallkarte', description: 'Unfall A001 im Ausschnitt',
    })],
  });
});

test('rejects a dangling image relationship even when the ZIP and XML are readable', async () => {
  const changed = await change(bytes, RELATIONSHIPS, xml => xml.replace(/Target="media\/[^\"]+"/, 'Target="media/missing.png"'));
  await expect(inspectDocx(changed)).rejects.toThrow(/missing.*media\/missing\.png/i);
});

test('rejects an undeclared relationship ID referenced by the WordprocessingML body', async () => {
  const changed = await change(bytes, MAIN, xml => xml.replace(/r:embed="[^"]+"/, 'r:embed="rIdMissing"'));
  await expect(inspectDocx(changed)).rejects.toThrow(/rIdMissing/);
});

test('rejects malformed XML that a permissive office importer might repair', async () => {
  const changed = await change(bytes, MAIN, xml => xml.replace('</w:body>', ''));
  await expect(inspectDocx(changed)).rejects.toThrow(/invalid XML.*word\/document\.xml/i);
});

test('accepts DOCX written with streaming ZIP data descriptors by an office converter', async () => {
  const zip = await JSZip.loadAsync(bytes);
  const streamed = await zip.generateAsync({ type: 'nodebuffer', streamFiles: true });
  await expect(inspectDocx(streamed, { officeSavedCopy: true })).resolves.toMatchObject({
    signature: { links: [URL] },
  });
});

test.each([
  ['changed table cell', MAIN, xml => xml.replace('>A001<', '>A002<'), 'paragraphs'],
  ['removed repeated header', MAIN, xml => xml.replace('<w:tblHeader/>', ''), 'tables'],
  ['changed hyperlink target', RELATIONSHIPS, xml => xml.replace(URL, `${URL}/other`), 'links'],
  ['removed image description', MAIN, xml => xml.replace(' descr="Unfall A001 im Ausschnitt"', ''), 'images'],
])('rejects a %s after saving and reopening', async (_label, part, transform, field) => {
  const original = await inspectDocx(bytes);
  const saved = await inspectDocx(await change(bytes, part, transform));
  expect(() => assertPreserved(original, saved)).toThrow(field);
});
