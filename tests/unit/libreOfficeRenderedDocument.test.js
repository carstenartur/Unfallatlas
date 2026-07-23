'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDeterministicMapPng } = require('../../scripts/deterministic-map-fixture');
const adapter = require('../../scripts/libreoffice-rendered-document');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unfallwerkbank-lo-'));
}

function writeDocx(directory, name = 'sample.docx') {
  const filePath = path.join(directory, name);
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

function fakeSpawnFactory(options = {}) {
  return jest.fn((command, args) => {
    if (args.includes('--version')) {
      return { status: 0, stdout: 'LibreOffice 26.2.0.1\n', stderr: '' };
    }
    if (args.includes('--convert-to')) {
      const outputDir = args[args.indexOf('--outdir') + 1];
      const source = args.at(-1);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, `${path.basename(source, path.extname(source))}.pdf`),
        pdfBytes(),
      );
      return {
        status: 0,
        stdout: 'convert /tmp/sample.docx as Writer PDF\n',
        stderr: options.repairWarning ? 'Warning: repaired damaged document' : '',
      };
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
    return { status: 1, stdout: '', stderr: `unexpected command: ${command} ${args.join(' ')}` };
  });
}

function fakePopplerMain({ writeAuditFile = true } = {}) {
  return jest.fn((args) => {
    const popplerOut = args[args.indexOf('--out-dir') + 1];
    fs.mkdirSync(popplerOut, { recursive: true });
    const modelPath = path.join(popplerOut, 'rendered-document.json');
    fs.writeFileSync(modelPath, '{"pages":1}\n');
    if (writeAuditFile) {
      fs.writeFileSync(
        path.join(popplerOut, 'rendered-document-audit.json'),
        '{"issues":[],"passed":true}\n',
      );
    }
    return {
      model: { pages: [{}] },
      report: {
        issues: [],
        passed: true,
        summary: { wordCount: 120, imageCount: 1, linkCount: 1 },
      },
      modelPath,
    };
  });
}

describe('LibreOffice DOCX rendered-artifact adapter', () => {
  let directory;

  beforeEach(() => {
    directory = tempDir();
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('requires the DOCX and output directory arguments', () => {
    expect(() => adapter.parseArgs([])).toThrow(/--docx is required/);
    expect(() => adapter.parseArgs(['--docx', 'a.docx'])).toThrow(/--out-dir is required/);
    expect(() => adapter.parseArgs(['--wat'])).toThrow(/unknown_argument/);
    expect(adapter.parseArgs([
      '--docx', 'a.docx',
      '--out-dir', 'out',
      '--document-id', 'golden',
      '--contract', 'contract.json',
      '--libreoffice', 'libreoffice',
      '--pdftoppm', 'pdftoppm',
      '--no-audit',
    ])).toEqual({
      docx: 'a.docx',
      outDir: 'out',
      documentId: 'golden',
      contractPath: 'contract.json',
      libreOffice: 'libreoffice',
      pdftoppm: 'pdftoppm',
      audit: false,
    });
  });

  test('validates DOCX and converted PDF signatures', () => {
    const docx = writeDocx(directory);
    const pdf = path.join(directory, 'sample.pdf');
    fs.writeFileSync(pdf, pdfBytes());

    expect(adapter.assertDocx(docx)).toBe(path.resolve(docx));
    expect(adapter.assertPdf(pdf)).toBe(path.resolve(pdf));

    const invalid = path.join(directory, 'invalid.bin');
    fs.writeFileSync(invalid, Buffer.alloc(2048));
    expect(() => adapter.assertDocx(invalid)).toThrow(/invalid_docx/);
    expect(() => adapter.assertPdf(invalid)).toThrow(/invalid_converted_pdf/);
  });

  test('uses an isolated profile and verifies the converted PDF', () => {
    const docx = writeDocx(directory, 'Bonn Antrag.docx');
    const outDir = path.join(directory, 'evidence');
    const spawnSync = fakeSpawnFactory();

    const result = adapter.convertDocxToPdf(docx, outDir, {
      spawnSync,
      libreOffice: 'soffice-test',
    });

    expect(result.version).toBe('LibreOffice 26.2.0.1');
    expect(result.pdfPath).toBe(
      path.join(outDir, 'libreoffice-output', 'Bonn Antrag.pdf'),
    );
    expect(fs.existsSync(result.pdfPath)).toBe(true);
    const conversionCall = spawnSync.mock.calls.find(([, args]) => args.includes('--convert-to'));
    expect(conversionCall[0]).toBe('soffice-test');
    expect(conversionCall[1]).toContain('--headless');
    expect(conversionCall[1]).toContain('pdf:writer_pdf_Export');
    expect(conversionCall[1].some((arg) => arg.startsWith('-env:UserInstallation=file:'))).toBe(true);
  });

  test('fails closed when LibreOffice reports a repair warning', () => {
    const docx = writeDocx(directory);
    expect(() => adapter.convertDocxToPdf(docx, path.join(directory, 'evidence'), {
      spawnSync: fakeSpawnFactory({ repairWarning: true }),
    })).toThrow(/libreoffice_repair_warning/);
  });

  test('renders every PDF page to a sufficiently large PNG', () => {
    const pdf = path.join(directory, 'sample.pdf');
    fs.writeFileSync(pdf, pdfBytes());

    const pages = adapter.renderPdfPages(pdf, path.join(directory, 'pages'), {
      spawnSync: fakeSpawnFactory(),
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1, width: 1200, height: 1697 });
    expect(pages[0].bytes).toBeGreaterThan(10_000);
    expect(pages[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('writes linked source, PDF, page and audit evidence metadata', () => {
    const docx = writeDocx(directory, 'source.docx');
    const outDir = path.join(directory, 'qa');
    const popplerMain = fakePopplerMain();

    const result = adapter.main([
      '--docx', docx,
      '--out-dir', outDir,
      '--document-id', 'bonn-docx-golden',
    ], {
      spawnSync: fakeSpawnFactory(),
      popplerMain,
    });

    expect(result.metadata).toMatchObject({
      schemaVersion: 'unfallwerkbank.docx-rendered-evidence/v1',
      documentId: 'bonn-docx-golden',
      renderer: 'docx-libreoffice-poppler',
      convertedPdf: { pages: 1 },
      audit: {
        report: 'poppler/rendered-document-audit.json',
        asserted: true,
        issues: 0,
        passed: true,
      },
    });
    expect(fs.existsSync(path.join(outDir, 'source.docx'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'converted.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'pages', 'page-1.png'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.metadataPath, 'utf8')).source.sha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(popplerMain.mock.calls[0][0]).toEqual(expect.arrayContaining([
      '--renderer', 'docx-libreoffice-poppler',
    ]));
  });

  test('does not inventory a nonexistent audit report in no-audit mode', () => {
    const docx = writeDocx(directory, 'source.docx');
    const outDir = path.join(directory, 'qa-no-audit');
    const popplerMain = fakePopplerMain({ writeAuditFile: false });

    const result = adapter.main([
      '--docx', docx,
      '--out-dir', outDir,
      '--no-audit',
    ], {
      spawnSync: fakeSpawnFactory(),
      popplerMain,
    });

    expect(result.metadata.audit).toMatchObject({
      report: null,
      asserted: false,
      issues: 0,
      passed: true,
    });
    expect(fs.existsSync(path.join(outDir, 'poppler', 'rendered-document-audit.json')))
      .toBe(false);
    expect(popplerMain.mock.calls[0][0]).toContain('--no-audit');
  });
});
