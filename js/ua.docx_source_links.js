/**
 * DOCX source-link integrity adapter.
 *
 * The legacy report renderer creates the final data-source notice as one plain
 * text paragraph. Word therefore cannot expose the dataset or licence as
 * clickable links even though the visible text is correct. This narrowly
 * scoped adapter decorates the docx Paragraph constructor only for the duration
 * of a Word export and only for the canonical source paragraph.
 *
 * The full document-provenance runtime already replaces the whole legacy source
 * section with manifest-driven paragraphs and real hyperlinks. When that
 * runtime is installed this adapter deliberately becomes a no-op; stacking two
 * constructor proxies would be redundant and can violate JavaScript Proxy
 * invariants in browsers.
 */
(function initDocxSourceLinks(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.docxSourceLinks = api;
    try {
      api.install(UA, root);
    } catch (error) {
      UA.docxSourceLinksError = error;
      root.console?.error?.("DOCX-Quellenlinks konnten nicht initialisiert werden", error);
    }
  }
})(typeof window !== "undefined" ? window : null, function createDocxSourceLinksApi() {
  "use strict";

  const SOURCE_PARAGRAPH_TEXT =
    "Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).";
  const DATASET_URL = "https://www.statistikportal.de/de/karten/unfallatlas";
  const LICENSE_URL = "https://www.govdata.de/dl-de/by-2-0";

  class DocxSourceLinkError extends Error {
    constructor(code, message) {
      super(`${code}: ${message}`);
      this.name = "DocxSourceLinkError";
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new DocxSourceLinkError(code, message);
  }

  function isCanonicalSourceParagraph(options) {
    return Boolean(
      options &&
        typeof options === "object" &&
        !Array.isArray(options) &&
        options.text === SOURCE_PARAGRAPH_TEXT,
    );
  }

  function linkedSourceParagraphOptions(docx, options) {
    if (!docx?.TextRun || !docx?.ExternalHyperlink) {
      fail(
        "missing_docx_link_api",
        "docx TextRun and ExternalHyperlink constructors are required",
      );
    }
    const TextRun = docx.TextRun;
    const ExternalHyperlink = docx.ExternalHyperlink;
    const spacing = options?.spacing ? { ...options.spacing } : undefined;
    return {
      ...options,
      text: undefined,
      children: [
        new TextRun({ text: "Unfallatlas / Open-Data-Downloads: " }),
        new ExternalHyperlink({
          link: DATASET_URL,
          children: [
            new TextRun({
              text: "Unfallatlas der Statistischen Ämter des Bundes und der Länder",
              style: "Hyperlink",
            }),
          ],
        }),
        new TextRun({ text: ". Lizenz: " }),
        new ExternalHyperlink({
          link: LICENSE_URL,
          children: [
            new TextRun({
              text: "Datenlizenz Deutschland – Namensnennung – Version 2.0",
              style: "Hyperlink",
            }),
          ],
        }),
        new TextRun({ text: "." }),
      ],
      ...(spacing ? { spacing } : {}),
    };
  }

  function createLinkedParagraphConstructor(docx) {
    if (typeof docx?.Paragraph !== "function") {
      fail("missing_docx_paragraph", "docx Paragraph constructor is required");
    }
    const OriginalParagraph = docx.Paragraph;
    return class LinkedSourceParagraph extends OriginalParagraph {
      constructor(options) {
        super(
          isCanonicalSourceParagraph(options)
            ? linkedSourceParagraphOptions(docx, options)
            : options,
        );
      }
    };
  }

  async function withLinkedSourceParagraph(rootValue, callback) {
    if (typeof callback !== "function") {
      fail("invalid_callback", "Word export callback is required");
    }
    const originalDocx = rootValue?.docx;
    if (!originalDocx) {
      return callback();
    }
    const decoratedDocx = Object.create(originalDocx);
    Object.defineProperty(decoratedDocx, "Paragraph", {
      // Keep the temporary namespace composable with other legitimate library
      // boundaries. A non-configurable own property would prevent an outer
      // Proxy from returning its own Paragraph constructor.
      configurable: true,
      enumerable: true,
      writable: false,
      value: createLinkedParagraphConstructor(originalDocx),
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
    if (UA.__docxSourceLinksInstalled) return UA.docxSourceLinksRuntime;

    if (UA.__documentExportProvenanceInstalled === true) {
      UA.__docxSourceLinksInstalled = true;
      UA.docxSourceLinksRuntime = Object.freeze({
        available: true,
        delegated: true,
        reason: "document_provenance_owns_source_links",
        originalExporter: UA.exportToWord,
        wrappedExporter: null,
      });
      return UA.docxSourceLinksRuntime;
    }

    const originalExporter = UA.exportToWord;
    if (typeof originalExporter !== "function") {
      return Object.freeze({ available: false, reason: "word_export_unavailable" });
    }

    let queue = Promise.resolve();
    const wrappedExporter = function exportWordWithClickableSources(...args) {
      const receiver = this;
      const run = () =>
        withLinkedSourceParagraph(rootValue, () =>
          originalExporter.apply(receiver, args),
        );
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    UA.exportToWord = wrappedExporter;
    UA.__docxSourceLinksInstalled = true;
    UA.docxSourceLinksRuntime = Object.freeze({
      available: true,
      delegated: false,
      originalExporter,
      wrappedExporter,
    });
    return UA.docxSourceLinksRuntime;
  }

  return Object.freeze({
    SOURCE_PARAGRAPH_TEXT,
    DATASET_URL,
    LICENSE_URL,
    DocxSourceLinkError,
    isCanonicalSourceParagraph,
    linkedSourceParagraphOptions,
    createLinkedParagraphConstructor,
    withLinkedSourceParagraph,
    install,
  });
});
