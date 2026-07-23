/**
 * DOCX pagination integrity adapter.
 *
 * Keeps short subsection headings with the table/content that follows them.
 * The adapter wraps the already serialized Word-export boundary, loads the
 * lazy DOCX library before decoration and scopes a configurable Paragraph
 * constructor only for the duration of one export. It therefore composes with
 * the document-provenance proxy without adding a permanent library mutation.
 */
(function initDocxPagination(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.docxPagination = api;
    try {
      api.install(UA, root);
    } catch (error) {
      UA.docxPaginationError = error;
      root.console?.error?.('DOCX-Paginierung konnte nicht initialisiert werden', error);
    }
  }
})(typeof window !== 'undefined' ? window : null, function createDocxPaginationApi() {
  'use strict';

  const KEEP_WITH_NEXT_TEXTS = Object.freeze([
    'Top-Abweichungen (Ausschnitt vs. Stadt):',
  ]);
  const KEEP_WITH_NEXT_SET = new Set(KEEP_WITH_NEXT_TEXTS);

  class DocxPaginationError extends Error {
    constructor(code, message) {
      super(`${code}: ${message}`);
      this.name = 'DocxPaginationError';
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new DocxPaginationError(code, message);
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function shouldKeepWithNext(options) {
    return Boolean(
      options &&
      typeof options === 'object' &&
      !Array.isArray(options) &&
      typeof options.text === 'string' &&
      KEEP_WITH_NEXT_SET.has(normalizeText(options.text)),
    );
  }

  function paginationSafeParagraphOptions(options) {
    if (!shouldKeepWithNext(options)) return options;
    return { ...options, keepNext: true };
  }

  function createPaginationParagraphConstructor(docx) {
    if (typeof docx?.Paragraph !== 'function') {
      fail('missing_docx_paragraph', 'docx Paragraph constructor is required');
    }
    const OriginalParagraph = docx.Paragraph;
    return class PaginationSafeParagraph extends OriginalParagraph {
      constructor(options) {
        super(paginationSafeParagraphOptions(options));
      }
    };
  }

  async function withPaginationParagraph(rootValue, callback) {
    if (typeof callback !== 'function') {
      fail('invalid_callback', 'Word export callback is required');
    }
    const originalDocx = rootValue?.docx;
    if (!originalDocx) {
      fail('missing_docx_api', 'DOCX library is unavailable after export-library initialization');
    }

    const decoratedDocx = Object.create(originalDocx);
    Object.defineProperty(decoratedDocx, 'Paragraph', {
      configurable: true,
      enumerable: true,
      writable: false,
      value: createPaginationParagraphConstructor(originalDocx),
    });
    rootValue.docx = decoratedDocx;
    try {
      return await callback();
    } finally {
      rootValue.docx = originalDocx;
    }
  }

  function install(UA, rootValue) {
    if (!UA || !rootValue) return Object.freeze({ available: false });
    if (UA.__docxPaginationInstalled) return UA.docxPaginationRuntime;

    const originalExporter = UA.exportToWord;
    if (typeof originalExporter !== 'function') {
      return Object.freeze({ available: false, reason: 'word_export_unavailable' });
    }
    const ensureLibraries = typeof UA.ensureExportLibraries === 'function'
      ? UA.ensureExportLibraries
      : null;

    let queue = Promise.resolve();
    const wrappedExporter = function exportWordWithPaginationIntegrity(...args) {
      const receiver = this;
      const run = async () => {
        if (!rootValue.docx) {
          if (!ensureLibraries) {
            fail('missing_export_library_loader', 'UA.ensureExportLibraries is required for lazy DOCX loading');
          }
          await ensureLibraries.call(UA);
        }
        return withPaginationParagraph(
          rootValue,
          () => originalExporter.apply(receiver, args),
        );
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    };

    UA.exportToWord = wrappedExporter;
    UA.__docxPaginationInstalled = true;
    UA.docxPaginationRuntime = Object.freeze({
      available: true,
      originalExporter,
      wrappedExporter,
      ensureLibraries,
      keepWithNextTexts: KEEP_WITH_NEXT_TEXTS,
    });
    return UA.docxPaginationRuntime;
  }

  return Object.freeze({
    KEEP_WITH_NEXT_TEXTS,
    DocxPaginationError,
    normalizeText,
    shouldKeepWithNext,
    paginationSafeParagraphOptions,
    createPaginationParagraphConstructor,
    withPaginationParagraph,
    install,
  });
});
