'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDeterministicMapPng } = require('../../scripts/deterministic-map-fixture');
const adapter = require('../../scripts/libreoffice-rendered-document');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unfallwerkbank-map-semantics-'));
}

function writeDocx(directory) {
  const filePath = path.join(directory, 'sample.docx');
  const content = Buffer.alloc(4096, 0);
  content[0] = 0x50;
  content[1] = 0x4b;
  content[2] = 0x03;
  content[3] = 0x04;
  fs.writeFileSync(filePath, content);
  return filePath;
}

function pdfBytes() {
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'ascii'),
    Buffer.alloc(4096, 0x20),
    Buffer.from('\n%%EOF\n', 'ascii'),
  ]);
}

function fakeSpawn(command, args) {
  if (args.includes('--version')) {
    return { status: 0, stdout: 'LibreOffice test\n', stderr: '' };
  }
  if (args.includes('--convert-to')) {
    const outputDir = args[args.indexOf('--outdir') + 1];
    const source = args.at(-1);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, `${path.basename(source, path.extname(source))}.pdf`),
      pdfBytes(),
    );
    return { status: 0, stdout: 'converted\n', stderr: '' };
  }
  if (args.includes('-png')) {
    const prefix = args.at(-1);
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    fs.writeFileSync(
      `${prefix}-1.png`,
      createDeterministicMapPng({ width: 1200, height: 1697 }),
    );
    return { status: 0, stdout: '', stderr: '' };
  }
  return { status: 1, stdout: '', stderr: `${command}: unexpected arguments` };
}

function contract() {
  return {
    requiredImageKinds: ['map'],
    expectedMapCount: 4,
    imageHints: [2, 3, 4, 5].map((page, index) => ({
      page,
      imageIndex: 0,
      kind: 'map',
      altText: `Karte ${index + 1} mit Unfallpunkten.`,
      caption: `Abbildung ${index + 1}: Kartendarstellung.`,
      sourceIds: ['accidents.de.unfallatlas', 'basemap.synthetic.qa'],
      sourceWidth: 960,
      sourceHeight: 640,
    })),
  };
}

describe('LibreOffice rendered map semantics', () => {
  let directory;

  beforeEach(() => {
    directory = tempDir();
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('passes contract image hints into the Poppler final-page adapter', () => {
    const docx = writeDocx(directory);
    const contractPath = path.join(directory, 'contract.json');
    fs.writeFileSync(contractPath, JSON.stringify(contract()));
    const popplerMain = jest.fn((args, runtimeOptions) => {
      const outDir = args[args.indexOf('--out-dir') + 1];
      fs.mkdirSync(outDir, { recursive: true });
      const modelPath = path.join(outDir, 'rendered-document.json');
      fs.writeFileSync(modelPath, '{"pages":[{}]}\n');
      fs.writeFileSync(path.join(outDir, 'rendered-document-audit.json'), '{"passed":true}\n');
      return {
        model: { pages: [{}] },
        report: {
          passed: true,
          issues: [],
          summary: { mapCount: 4, imageCount: 4, wordCount: 100, linkCount: 2 },
        },
        modelPath,
      };
    });

    const result = adapter.main([
      '--docx', docx,
      '--out-dir', path.join(directory, 'evidence'),
      '--contract', contractPath,
    ], {
      spawnSync: fakeSpawn,
      popplerMain,
    });

    expect(popplerMain.mock.calls[0][1].imageHints).toEqual(contract().imageHints);
    expect(result.metadata.semanticEvidence).toEqual({
      expectedMapCount: 4,
      mapCount: 4,
      imageHints: 4,
    });
  });

  test('fails closed when the final map count differs from the contract', () => {
    expect(() => adapter.assertExpectedMapCount(
      { summary: { mapCount: 3 } },
      { expectedMapCount: 4 },
    )).toThrow(/rendered_map_count_mismatch/);
  });

  test('rejects malformed semantic map contracts', () => {
    expect(() => adapter.assertExpectedMapCount(
      { summary: { mapCount: 4 } },
      { expectedMapCount: 4.5 },
    )).toThrow(/invalid_rendered_contract/);

    const invalidPath = path.join(directory, 'invalid.json');
    fs.writeFileSync(invalidPath, '[]');
    expect(() => adapter.loadContract(invalidPath)).toThrow(/invalid_rendered_contract/);
  });
});
