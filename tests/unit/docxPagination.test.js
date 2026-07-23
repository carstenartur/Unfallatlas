'use strict';

const pagination = require('../../js/ua.docx_pagination');

class Paragraph {
  constructor(options) {
    this.options = options;
  }
}

function docxApi() {
  return { Paragraph };
}

describe('DOCX pagination integrity adapter', () => {
  test('marks only the canonical Top-Abweichungen heading as keep-with-next', () => {
    const heading = {
      text: 'Top-Abweichungen (Ausschnitt vs. Stadt):',
      spacing: { after: 100 },
    };
    expect(pagination.shouldKeepWithNext(heading)).toBe(true);
    expect(pagination.paginationSafeParagraphOptions(heading)).toEqual({
      ...heading,
      keepNext: true,
    });

    const unrelated = { text: 'Unfälle pro Jahr im Ausschnitt:', spacing: { after: 100 } };
    expect(pagination.shouldKeepWithNext(unrelated)).toBe(false);
    expect(pagination.paginationSafeParagraphOptions(unrelated)).toBe(unrelated);
  });

  test('normalizes harmless whitespace without broad substring matching', () => {
    expect(pagination.shouldKeepWithNext({
      text: '  Top-Abweichungen   (Ausschnitt vs. Stadt):  ',
    })).toBe(true);
    expect(pagination.shouldKeepWithNext({
      text: 'Hinweis zu Top-Abweichungen (Ausschnitt vs. Stadt):',
    })).toBe(false);
  });

  test('decorates the Paragraph constructor and preserves caller options', () => {
    const DecoratedParagraph = pagination.createPaginationParagraphConstructor(docxApi());
    const paragraph = new DecoratedParagraph({
      text: 'Top-Abweichungen (Ausschnitt vs. Stadt):',
      heading: 'Heading2',
      spacing: { before: 20, after: 100 },
    });

    expect(paragraph).toBeInstanceOf(Paragraph);
    expect(paragraph.options).toEqual({
      text: 'Top-Abweichungen (Ausschnitt vs. Stadt):',
      heading: 'Heading2',
      spacing: { before: 20, after: 100 },
      keepNext: true,
    });
  });

  test('scopes and restores the DOCX namespace after success and failure', async () => {
    const original = docxApi();
    const root = { docx: original };

    await pagination.withPaginationParagraph(root, async () => {
      expect(root.docx).not.toBe(original);
      expect(new root.docx.Paragraph({
        text: 'Top-Abweichungen (Ausschnitt vs. Stadt):',
      }).options.keepNext).toBe(true);
    });
    expect(root.docx).toBe(original);

    await expect(pagination.withPaginationParagraph(root, async () => {
      throw new Error('renderer failed');
    })).rejects.toThrow('renderer failed');
    expect(root.docx).toBe(original);
  });

  test('composes with an existing configurable provenance Paragraph proxy', async () => {
    const target = docxApi();
    class ProvenanceParagraph extends Paragraph {
      constructor(options) {
        super({ ...options, provenanceWrapped: true });
      }
    }
    const provenanceProxy = new Proxy(target, {
      get(current, property, receiver) {
        if (property === 'Paragraph') return ProvenanceParagraph;
        return Reflect.get(current, property, receiver);
      },
    });
    const root = { docx: provenanceProxy };

    await pagination.withPaginationParagraph(root, async () => {
      const paragraph = new root.docx.Paragraph({
        text: 'Top-Abweichungen (Ausschnitt vs. Stadt):',
      });
      expect(paragraph.options).toMatchObject({
        keepNext: true,
        provenanceWrapped: true,
      });
    });
    expect(root.docx).toBe(provenanceProxy);
  });

  test('loads the lazy DOCX API before applying the pagination boundary', async () => {
    const root = {};
    const ensureExportLibraries = jest.fn(async () => {
      root.docx = docxApi();
    });
    const originalExporter = jest.fn(async () => {
      const paragraph = new root.docx.Paragraph({
        text: 'Top-Abweichungen (Ausschnitt vs. Stadt):',
      });
      return paragraph.options;
    });
    const UA = { ensureExportLibraries, exportToWord: originalExporter };
    const runtime = pagination.install(UA, root);

    await expect(UA.exportToWord()).resolves.toMatchObject({ keepNext: true });
    expect(ensureExportLibraries).toHaveBeenCalledTimes(1);
    expect(originalExporter).toHaveBeenCalledTimes(1);
    expect(root.docx.Paragraph).toBe(Paragraph);
    expect(runtime.ensureLibraries).toBe(ensureExportLibraries);
  });

  test('serializes simultaneous Word exports so scoped libraries cannot cross', async () => {
    const root = { docx: docxApi() };
    const events = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let invocation = 0;
    const UA = {
      exportToWord: async () => {
        invocation += 1;
        const current = invocation;
        events.push(`start-${current}`);
        const paragraph = new root.docx.Paragraph({
          text: 'Top-Abweichungen (Ausschnitt vs. Stadt):',
        });
        expect(paragraph.options.keepNext).toBe(true);
        if (current === 1) await firstGate;
        events.push(`end-${current}`);
        return current;
      },
    };
    const runtime = pagination.install(UA, root);
    expect(runtime.available).toBe(true);

    const first = UA.exportToWord();
    const second = UA.exportToWord();
    await Promise.resolve();
    expect(events).toEqual(['start-1']);
    releaseFirst();

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  test('fails closed when lazy loading cannot provide the DOCX API', async () => {
    const originalExporter = jest.fn();
    const UA = { exportToWord: originalExporter };
    pagination.install(UA, {});

    await expect(UA.exportToWord()).rejects.toThrow(/missing_export_library_loader/);
    expect(originalExporter).not.toHaveBeenCalled();

    const root = {};
    const ensureExportLibraries = jest.fn(async () => undefined);
    const lazyUA = { ensureExportLibraries, exportToWord: originalExporter };
    pagination.install(lazyUA, root);
    await expect(lazyUA.exportToWord()).rejects.toThrow(/missing_docx_api/);
    expect(ensureExportLibraries).toHaveBeenCalledTimes(1);
    expect(originalExporter).not.toHaveBeenCalled();
  });

  test('fails closed for an invalid callback or missing Paragraph API', async () => {
    await expect(pagination.withPaginationParagraph({ docx: docxApi() }, null))
      .rejects.toThrow(/invalid_callback/);
    await expect(pagination.withPaginationParagraph({}, async () => undefined))
      .rejects.toThrow(/missing_docx_api/);
    expect(() => pagination.createPaginationParagraphConstructor({}))
      .toThrow(/missing_docx_paragraph/);
  });
});
