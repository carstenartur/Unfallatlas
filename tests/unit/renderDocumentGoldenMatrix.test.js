'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const scenarios = require('../../scripts/document-golden-scenarios');
const generator = require('../../scripts/generate-document-golden-matrix');
const renderer = require('../../scripts/render-document-golden-matrix');

function fakeDocx(id) {
  return Buffer.concat([Buffer.from(`PK-${id}-`), Buffer.alloc(2048, id.length)]);
}

function argsToObject(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) out[argv[index]] = argv[index + 1];
  return out;
}

function writeFile(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function fakeRender(options = {}) {
  return async (argv) => {
    const args = argsToObject(argv);
    const scenarioId = String(args['--document-id']).replace(/^golden-/, '');
    const scenario = scenarios.getScenario(scenarioId);
    const pages = options.pages == null
      ? scenario.expectations.minimumRenderedPages
      : options.pages;
    const outDir = args['--out-dir'];
    writeFile(outDir, 'converted.pdf', Buffer.from('%PDF-' + scenarioId + '-'.repeat(300)));
    writeFile(outDir, 'poppler/rendered-document.json', '{}\n');
    writeFile(outDir, 'poppler/rendered-document-audit.json', '{}\n');
    const pageRows = [];
    for (let page = 1; page <= pages; page += 1) {
      const relative = `pages/page-${page}.png`;
      writeFile(outDir, relative, Buffer.from(`png-${scenarioId}-${page}`));
      pageRows.push({ page, file: relative, width: 1191, height: 1684 });
    }
    const metadata = {
      convertedPdf: { pages },
      libreOffice: { version: 'LibreOffice fixture 1.0' },
      audit: {
        model: 'poppler/rendered-document.json',
        report: 'poppler/rendered-document-audit.json',
        passed: options.auditPassed !== false,
        issues: options.auditPassed === false ? 1 : 0,
      },
    };
    writeFile(outDir, 'conversion-metadata.json', `${JSON.stringify(metadata, null, 2)}\n`);
    return { metadata, pages: pageRows };
  };
}

async function createMatrix(root) {
  return generator.generateGoldenMatrix({
    root,
    outDir: 'out/qa/document-golden-matrix',
    generator: async ({ scenario, outPath }) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, fakeDocx(scenario.id));
      return { scenarioId: scenario.id, outPath, bytes: fs.statSync(outPath).size };
    },
  });
}

function manifestFixture(artifact) {
  return {
    schemaVersion: generator.MATRIX_SCHEMA,
    scenarioContractSha256: 'a'.repeat(64),
    matrixFingerprint: 'b'.repeat(64),
    artifacts: [artifact],
  };
}

describe('rendered document Golden matrix', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test('renders all five DOCX scenarios and records only evidence actually verified', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-matrix-'));
    roots.push(root);
    const input = await createMatrix(root);
    const result = await renderer.renderGoldenMatrix({ root, renderer: fakeRender() });

    expect(result.matrix.schemaVersion).toBe(renderer.RENDERED_MATRIX_SCHEMA);
    expect(result.matrix.artifacts).toHaveLength(5);
    expect(result.matrix.sourceMatrix.matrixFingerprint).toBe(input.matrix.matrixFingerprint);
    expect(result.matrix.matrixFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifestPath).toBe(path.join(result.renderedDir, 'rendered-matrix.json'));
    expect(result.matrix.truthBoundary).toEqual({
      renderedPageCountsVerified: true,
      genericFinalPageAuditVerified: true,
      renderedMapSemanticsVerified: false,
      renderedTableSemanticsVerified: false,
      microsoftWordEvidenceVerified: false,
    });

    for (const artifact of result.matrix.artifacts) {
      const scenario = scenarios.getScenario(artifact.scenarioId);
      expect(artifact.automatedEvidence.renderedPageCount)
        .toBe(scenario.expectations.minimumRenderedPages);
      expect(artifact.automatedEvidence.renderedMapSemantics).toBeNull();
      expect(artifact.automatedEvidence.renderedTableSemantics).toBeNull();
      expect(artifact.manualWordEvidence.status).toBe('not-performed');
      expect(artifact.renderedEvidence.pdf.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.renderedEvidence.auditReport.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.renderedEvidence.pageImages)
        .toHaveLength(scenario.expectations.minimumRenderedPages);
      for (const evidence of [
        artifact.renderedEvidence.pdf,
        artifact.renderedEvidence.metadata,
        artifact.renderedEvidence.auditModel,
        artifact.renderedEvidence.auditReport,
        ...artifact.renderedEvidence.pageImages,
      ]) {
        expect(fs.existsSync(path.join(result.renderedDir, evidence.path))).toBe(true);
      }
    }
    expect(JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))).toEqual(result.matrix);
  });

  test('fails before rendering when a generated DOCX drifts from the input matrix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-drift-'));
    roots.push(root);
    const input = await createMatrix(root);
    fs.appendFileSync(path.join(input.outDir, 'few-cases.docx'), 'drift');
    const render = jest.fn(fakeRender());

    await expect(renderer.renderGoldenMatrix({ root, renderer: render }))
      .rejects.toThrow(/docx_drift/);
    expect(render).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(input.outDir, 'rendered'))).toBe(false);
  });

  test('fails atomically when one scenario renders fewer than its declared minimum pages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-pages-'));
    roots.push(root);
    const input = await createMatrix(root);

    await expect(renderer.renderGoldenMatrix({ root, renderer: fakeRender({ pages: 1 }) }))
      .rejects.toThrow(/minimum_page_count_not_met/);
    expect(fs.existsSync(path.join(input.outDir, 'rendered'))).toBe(false);
  });

  test('rejects an audit with findings instead of recording a false-green matrix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-audit-'));
    roots.push(root);
    const input = await createMatrix(root);

    await expect(renderer.renderGoldenMatrix({
      root,
      renderer: fakeRender({ auditPassed: false }),
    })).rejects.toThrow(/rendered_audit_failed/);
    expect(fs.existsSync(path.join(input.outDir, 'rendered'))).toBe(false);
  });

  test('produces deterministic evidence fingerprints for identical rendered bytes', async () => {
    const rootsForRun = [
      fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-deterministic-a-')),
      fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-deterministic-b-')),
    ];
    roots.push(...rootsForRun);
    const results = [];
    for (const root of rootsForRun) {
      await createMatrix(root);
      results.push(await renderer.renderGoldenMatrix({ root, renderer: fakeRender() }));
    }
    expect(results[0].matrix.matrixFingerprint).toBe(results[1].matrix.matrixFingerprint);
  });

  test('reports an incomplete artifact envelope as an invalid matrix instead of TypeError', () => {
    expect(() => renderer.normalizeInputMatrix(manifestFixture({
      scenarioId: 'few-cases',
      artifact: null,
    }))).toThrow(/invalid_matrix/);
  });

  test('rejects evidence symlinks even when their string path looks confined', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-symlink-'));
    roots.push(root);
    const renderRoot = path.join(root, 'rendered.tmp');
    const scenarioRoot = path.join(renderRoot, 'few-cases');
    fs.mkdirSync(scenarioRoot, { recursive: true });
    const outside = writeFile(root, 'outside.pdf', '%PDF-outside');
    fs.symlinkSync(outside, path.join(scenarioRoot, 'converted.pdf'));

    expect(() => renderer.evidenceFile(
      renderRoot,
      scenarioRoot,
      'converted.pdf',
      'fixture PDF',
    )).toThrow(/unsafe_renderer_output/);
  });

  test('rejects a matrix directory whose realpath escapes the repository root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-matrix-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-matrix-outside-'));
    roots.push(root, outside);
    fs.mkdirSync(path.join(root, 'out', 'qa'), { recursive: true });
    const link = path.join(root, 'out', 'qa', 'document-golden-matrix');
    fs.symlinkSync(outside, link, 'dir');

    expect(() => renderer.resolveMatrixDirectory(root, link))
      .toThrow(/unsafe_matrix_directory/);
  });

  test('keeps a previous rendered package when writing the staged manifest fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-rendered-publish-'));
    roots.push(root);
    const stage = path.join(root, 'rendered.tmp');
    const final = path.join(root, 'rendered');
    writeFile(stage, 'few-cases/converted.pdf', '%PDF-new');
    writeFile(final, 'previous-marker.txt', 'previous');

    expect(() => renderer.publishRenderedDirectory(
      stage,
      final,
      'rendered-matrix.json',
      { schemaVersion: renderer.RENDERED_MATRIX_SCHEMA },
      { writeFileSync: () => { throw new Error('disk full'); } },
    )).toThrow(/manifest_write_failed/);
    expect(fs.readFileSync(path.join(final, 'previous-marker.txt'), 'utf8')).toBe('previous');
    expect(fs.existsSync(stage)).toBe(true);
  });

  test('rejects unsafe artifact and CLI paths', () => {
    expect(() => renderer.parseArgs(['--matrix-dir', '../outside'])).not.toThrow();
    expect(() => renderer.safeChild('/tmp/root', '../outside', 'fixture'))
      .toThrow(/unsafe_path/);
    expect(() => renderer.normalizeInputMatrix(manifestFixture({
      scenarioId: 'few-cases',
      artifact: { filename: '../few.docx', bytes: 2048, sha256: 'c'.repeat(64) },
    }))).toThrow(/unsafe_path/);
  });
});
