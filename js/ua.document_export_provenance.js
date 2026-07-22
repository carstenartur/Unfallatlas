/**
 * Live PDF/DOCX integration for the shared SourceManifest contract.
 *
 * The existing report renderer remains responsible for the document body.
 * This module scopes one validated manifest snapshot around that renderer and
 * decorates the document-library boundary. As a result, PDF and DOCX receive
 * the same source appendix without maintaining a second source model inside
 * the large report renderer.
 */
(function initDocumentExportProvenance(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.documentExportProvenance = api;
    if (UA.exportProvenanceRuntime && UA.artifactProvenance) api.install(UA, root);
  }
})(typeof window !== "undefined" ? window : null, function createDocumentExportProvenanceApi() {
  "use strict";

  const HEADING = "DATENQUELLEN, METHODIK UND NACHVOLLZIEHBARKEIT";
  const INSTALL_MARKER = "__documentExportProvenanceInstalled";
  const PDF_MARKER = "__unfallatlasSourceManifestSha256";

  function requiredFunction(value, name) {
    if (typeof value !== "function") {
      throw new Error(`missing_dependency: ${name} is unavailable`);
    }
    return value;
  }

  function text(value, fallback = "—") {
    const normalized = String(value == null ? "" : value).trim();
    return normalized || fallback;
  }

  function formatScenario(scenario) {
    const value = scenario || {};
    const years = Array.isArray(value.years) && value.years.length
      ? value.years.join(", ")
      : "nicht angegeben";
    return Object.freeze({
      city: text(value.city),
      years,
      bounds: value.bounds ? JSON.stringify(value.bounds) : "nicht angegeben",
      filters: value.filters && Object.keys(value.filters).length
        ? JSON.stringify(value.filters)
        : "keine dokumentierten Filter",
    });
  }

  function sourceView(source) {
    const value = source || {};
    return Object.freeze({
      sourceId: text(value.sourceId),
      role: text(value.role),
      publisher: text(value.publisher),
      datasetTitle: text(value.datasetTitle),
      datasetUrl: text(value.datasetUrl),
      distributionUrl: value.distributionUrl ? text(value.distributionUrl) : null,
      licenseId: text(value.licenseId),
      licenseName: text(value.licenseName),
      licenseUrl: text(value.licenseUrl),
      requiredAttribution: value.requiredAttribution ? text(value.requiredAttribution) : null,
      temporalCoverage: value.temporalCoverage ? text(value.temporalCoverage) : null,
      spatialCoverage: value.spatialCoverage ? text(value.spatialCoverage) : null,
      versionOrPublicationDate: value.versionOrPublicationDate
        ? text(value.versionOrPublicationDate)
        : null,
      retrievedAt: text(value.retrievedAt),
      contentHash: value.contentHash ? text(value.contentHash) : null,
      changedOrDerived: value.changedOrDerived === true,
      changeNotice: value.changeNotice ? text(value.changeNotice) : null,
      qualityNotes: Array.isArray(value.qualityNotes)
        ? Object.freeze(value.qualityNotes.map(note => text(note)).filter(Boolean))
        : Object.freeze([]),
    });
  }

  function transformationView(transformation) {
    const value = transformation || {};
    const entries = Object.entries(value)
      .filter(([, item]) => item != null && item !== "")
      .map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
    return text(entries.join("; "));
  }

  function buildSourceView(normalized) {
    const manifest = normalized && normalized.manifest;
    if (!manifest || !Array.isArray(manifest.sources) || !manifest.sources.length) {
      throw new Error("missing_sources: document provenance requires at least one source");
    }
    return Object.freeze({
      heading: HEADING,
      artifactId: text(manifest.artifactId),
      generatedAt: text(manifest.generatedAt),
      applicationVersion: text(manifest.applicationVersion),
      buildFingerprint: text(manifest.buildFingerprint),
      dataFingerprint: text(manifest.dataFingerprint),
      sourceManifestSha256: text(normalized.sha256),
      canonicalJson: text(normalized.canonicalJson),
      scenario: formatScenario(manifest.scenario),
      sources: Object.freeze(manifest.sources.map(sourceView)),
      transformations: Object.freeze((manifest.transformations || []).map(transformationView)),
    });
  }

  function docxTextRun(docx, value, options = {}) {
    return new docx.TextRun({ text: String(value), ...options });
  }

  function docxLink(docx, label, url) {
    requiredFunction(docx.ExternalHyperlink, "docx.ExternalHyperlink");
    return new docx.ExternalHyperlink({
      link: url,
      children: [docxTextRun(docx, label, { style: "Hyperlink" })],
    });
  }

  function buildDocxNodes(docx, view) {
    requiredFunction(docx.Paragraph, "docx.Paragraph");
    requiredFunction(docx.TextRun, "docx.TextRun");
    const headingLevel = docx.HeadingLevel && docx.HeadingLevel.HEADING_2;
    const nodes = [
      new docx.Paragraph({
        text: view.heading,
        ...(headingLevel ? { heading: headingLevel } : {}),
        pageBreakBefore: true,
        spacing: { before: 400, after: 200 },
      }),
      new docx.Paragraph({
        children: [
          docxTextRun(docx, "Dokument-ID: ", { bold: true }),
          docxTextRun(docx, view.artifactId),
        ],
        spacing: { after: 60 },
      }),
      new docx.Paragraph({
        children: [
          docxTextRun(docx, "SourceManifest SHA-256: ", { bold: true }),
          docxTextRun(docx, view.sourceManifestSha256),
        ],
        spacing: { after: 60 },
      }),
      new docx.Paragraph({
        text: `Erzeugt: ${view.generatedAt} · Anwendung: ${view.applicationVersion}`,
        spacing: { after: 60 },
      }),
      new docx.Paragraph({
        text: `Build-Fingerprint: ${view.buildFingerprint}`,
        spacing: { after: 40 },
      }),
      new docx.Paragraph({
        text: `Daten-Fingerprint: ${view.dataFingerprint}`,
        spacing: { after: 100 },
      }),
      new docx.Paragraph({
        children: [docxTextRun(docx, "Auswertungsszenario", { bold: true })],
        spacing: { before: 100, after: 40 },
      }),
      new docx.Paragraph({
        text: `Stadt: ${view.scenario.city} · Jahrgänge: ${view.scenario.years}`,
        spacing: { after: 40 },
      }),
      new docx.Paragraph({
        text: `Räumlicher Ausschnitt: ${view.scenario.bounds}`,
        spacing: { after: 40 },
      }),
      new docx.Paragraph({
        text: `Aktive Filter: ${view.scenario.filters}`,
        spacing: { after: 140 },
      }),
    ];

    view.sources.forEach((source, index) => {
      nodes.push(new docx.Paragraph({
        children: [docxTextRun(docx, `${index + 1}. ${source.datasetTitle}`, { bold: true })],
        spacing: { before: index ? 120 : 40, after: 40 },
      }));
      nodes.push(new docx.Paragraph({
        text: `Herausgeber: ${source.publisher} · Source-ID: ${source.sourceId} · Rolle: ${source.role}`,
        spacing: { after: 40 },
      }));
      nodes.push(new docx.Paragraph({
        children: [
          docxLink(docx, "Datensatzseite öffnen", source.datasetUrl),
          docxTextRun(docx, " · "),
          docxLink(docx, `Lizenztext öffnen (${source.licenseId})`, source.licenseUrl),
          ...(source.distributionUrl
            ? [docxTextRun(docx, " · "), docxLink(docx, "Verwendete Distribution öffnen", source.distributionUrl)]
            : []),
        ],
        spacing: { after: 40 },
      }));
      nodes.push(new docx.Paragraph({
        text: `Lizenz: ${source.licenseName} · Abruf: ${source.retrievedAt}`,
        spacing: { after: 40 },
      }));
      const coverage = [
        source.temporalCoverage ? `zeitlich ${source.temporalCoverage}` : null,
        source.spatialCoverage ? `räumlich ${source.spatialCoverage}` : null,
        source.versionOrPublicationDate ? `Version/Veröffentlichung ${source.versionOrPublicationDate}` : null,
      ].filter(Boolean);
      if (coverage.length) {
        nodes.push(new docx.Paragraph({
          text: `Abdeckung: ${coverage.join(" · ")}`,
          spacing: { after: 40 },
        }));
      }
      if (source.requiredAttribution) {
        nodes.push(new docx.Paragraph({
          text: `Vorgeschriebener Quellenvermerk: ${source.requiredAttribution}`,
          spacing: { after: 40 },
        }));
      }
      if (source.contentHash) {
        nodes.push(new docx.Paragraph({
          text: `Quellbestand-Hash: ${source.contentHash}`,
          spacing: { after: 40 },
        }));
      }
      nodes.push(new docx.Paragraph({
        text: source.changedOrDerived
          ? `Gefiltert/transformiert: ja${source.changeNotice ? ` · ${source.changeNotice}` : ""}`
          : "Gefiltert/transformiert: nein",
        spacing: { after: source.qualityNotes.length ? 40 : 100 },
      }));
      source.qualityNotes.forEach(note => nodes.push(new docx.Paragraph({
        text: `Qualitätshinweis: ${note}`,
        spacing: { after: 40 },
      })));
    });

    nodes.push(new docx.Paragraph({
      children: [docxTextRun(docx, "Transformationen", { bold: true })],
      spacing: { before: 120, after: 40 },
    }));
    if (view.transformations.length) {
      view.transformations.forEach(item => nodes.push(new docx.Paragraph({
        text: `– ${item}`,
        spacing: { after: 40 },
      })));
    } else {
      nodes.push(new docx.Paragraph({
        text: "Keine zusätzlichen Transformationen dokumentiert.",
        spacing: { after: 80 },
      }));
    }
    nodes.push(new docx.Paragraph({
      text: "Der oben angegebene SHA-256-Wert bindet diese Darstellung an das kanonische SourceManifest des Exports.",
      spacing: { before: 80, after: 160 },
    }));
    return nodes;
  }

  function appendDocxProvenance(options, docx, view) {
    const source = options || {};
    const sections = Array.isArray(source.sections) ? source.sections.slice() : [];
    if (!sections.length) {
      throw new Error("invalid_docx_definition: Document requires at least one section");
    }
    const lastIndex = sections.length - 1;
    const last = sections[lastIndex] || {};
    sections[lastIndex] = {
      ...last,
      children: [...(Array.isArray(last.children) ? last.children : []), ...buildDocxNodes(docx, view)],
    };
    return { ...source, sections };
  }

  function pdfLink(label, url) {
    return { text: label, link: url, color: "blue", decoration: "underline" };
  }

  function buildPdfNodes(view) {
    const nodes = [
      {
        text: view.heading,
        fontSize: 16,
        bold: true,
        pageBreak: "before",
        margin: [0, 0, 0, 12],
      },
      { text: [{ text: "Dokument-ID: ", bold: true }, view.artifactId], margin: [0, 0, 0, 4] },
      { text: [{ text: "SourceManifest SHA-256: ", bold: true }, view.sourceManifestSha256], margin: [0, 0, 0, 4] },
      { text: `Erzeugt: ${view.generatedAt} · Anwendung: ${view.applicationVersion}`, margin: [0, 0, 0, 4] },
      { text: `Build-Fingerprint: ${view.buildFingerprint}`, margin: [0, 0, 0, 2] },
      { text: `Daten-Fingerprint: ${view.dataFingerprint}`, margin: [0, 0, 0, 8] },
      { text: "Auswertungsszenario", bold: true, margin: [0, 4, 0, 4] },
      { text: `Stadt: ${view.scenario.city} · Jahrgänge: ${view.scenario.years}`, margin: [0, 0, 0, 2] },
      { text: `Räumlicher Ausschnitt: ${view.scenario.bounds}`, margin: [0, 0, 0, 2] },
      { text: `Aktive Filter: ${view.scenario.filters}`, margin: [0, 0, 0, 10] },
    ];

    view.sources.forEach((source, index) => {
      nodes.push({
        text: `${index + 1}. ${source.datasetTitle}`,
        bold: true,
        margin: [0, index ? 8 : 2, 0, 3],
      });
      nodes.push({
        text: `Herausgeber: ${source.publisher} · Source-ID: ${source.sourceId} · Rolle: ${source.role}`,
        margin: [0, 0, 0, 3],
      });
      const links = [
        pdfLink("Datensatzseite öffnen", source.datasetUrl),
        { text: " · " },
        pdfLink(`Lizenztext öffnen (${source.licenseId})`, source.licenseUrl),
      ];
      if (source.distributionUrl) {
        links.push({ text: " · " }, pdfLink("Verwendete Distribution öffnen", source.distributionUrl));
      }
      nodes.push({ text: links, margin: [0, 0, 0, 3] });
      nodes.push({
        text: `Lizenz: ${source.licenseName} · Abruf: ${source.retrievedAt}`,
        margin: [0, 0, 0, 3],
      });
      const coverage = [
        source.temporalCoverage ? `zeitlich ${source.temporalCoverage}` : null,
        source.spatialCoverage ? `räumlich ${source.spatialCoverage}` : null,
        source.versionOrPublicationDate ? `Version/Veröffentlichung ${source.versionOrPublicationDate}` : null,
      ].filter(Boolean);
      if (coverage.length) nodes.push({ text: `Abdeckung: ${coverage.join(" · ")}`, margin: [0, 0, 0, 3] });
      if (source.requiredAttribution) nodes.push({
        text: `Vorgeschriebener Quellenvermerk: ${source.requiredAttribution}`,
        margin: [0, 0, 0, 3],
      });
      if (source.contentHash) nodes.push({ text: `Quellbestand-Hash: ${source.contentHash}`, margin: [0, 0, 0, 3] });
      nodes.push({
        text: source.changedOrDerived
          ? `Gefiltert/transformiert: ja${source.changeNotice ? ` · ${source.changeNotice}` : ""}`
          : "Gefiltert/transformiert: nein",
        margin: [0, 0, 0, source.qualityNotes.length ? 3 : 6],
      });
      source.qualityNotes.forEach(note => nodes.push({ text: `Qualitätshinweis: ${note}`, margin: [0, 0, 0, 3] }));
    });

    nodes.push({ text: "Transformationen", bold: true, margin: [0, 8, 0, 3] });
    if (view.transformations.length) {
      view.transformations.forEach(item => nodes.push({ text: `– ${item}`, margin: [0, 0, 0, 3] }));
    } else {
      nodes.push({ text: "Keine zusätzlichen Transformationen dokumentiert.", margin: [0, 0, 0, 6] });
    }
    nodes.push({
      text: "Der oben angegebene SHA-256-Wert bindet diese Darstellung an das kanonische SourceManifest des Exports.",
      italics: true,
      margin: [0, 6, 0, 0],
    });
    return nodes;
  }

  function appendPdfProvenance(definition, view) {
    const source = definition || {};
    if (source[PDF_MARKER] === view.sourceManifestSha256) return source;
    const originalContent = Array.isArray(source.content)
      ? source.content.slice()
      : source.content == null
        ? []
        : [source.content];
    const result = { ...source, content: [...originalContent, ...buildPdfNodes(view)] };
    Object.defineProperty(result, PDF_MARKER, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: view.sourceManifestSha256,
    });
    return result;
  }

  function install(UA, root) {
    if (!UA || !root) throw new Error("missing_dependency: UA runtime is unavailable");
    if (UA[INSTALL_MARKER]) return UA.documentExportProvenanceRuntime;

    const createManifest = requiredFunction(
      UA.exportProvenanceRuntime && UA.exportProvenanceRuntime.createManifest,
      "UA.exportProvenanceRuntime.createManifest",
    );
    const normalizeAndHash = requiredFunction(
      UA.artifactProvenance && UA.artifactProvenance.normalizeAndHash,
      "UA.artifactProvenance.normalizeAndHash",
    );
    const originals = UA.__exportProvenanceOriginals || {};
    const originalWord = requiredFunction(originals.exportToWord, "original exportToWord");
    const originalPdf = requiredFunction(originals.exportToPDF, "original exportToPDF");
    const ensureLibraries = requiredFunction(UA.ensureExportLibraries, "UA.ensureExportLibraries");

    const state = {
      active: null,
      queue: Promise.resolve(),
      docxOriginalDocument: null,
      pdfOriginalCreatePdf: null,
      docxLibrary: null,
      pdfLibrary: null,
    };

    function patchDocumentLibraries() {
      const docx = root.docx;
      const pdfMake = root.pdfMake;
      if (!docx || !pdfMake) {
        throw new Error("missing_dependency: PDF/DOCX libraries are unavailable after loading");
      }

      if (state.docxLibrary !== docx) {
        const OriginalDocument = requiredFunction(docx.Document, "docx.Document");
        class ProvenancedDocument extends OriginalDocument {
          constructor(options) {
            const active = state.active;
            super(active && active.format === "docx"
              ? appendDocxProvenance(options, docx, active.view)
              : options);
          }
        }
        Object.setPrototypeOf(ProvenancedDocument, OriginalDocument);
        state.docxOriginalDocument = OriginalDocument;
        state.docxLibrary = docx;
        docx.Document = ProvenancedDocument;
        if (docx.Document !== ProvenancedDocument) {
          throw new Error("patch_failed: docx.Document is not replaceable");
        }
      }

      if (state.pdfLibrary !== pdfMake) {
        const originalCreatePdf = requiredFunction(pdfMake.createPdf, "pdfMake.createPdf").bind(pdfMake);
        state.pdfOriginalCreatePdf = originalCreatePdf;
        state.pdfLibrary = pdfMake;
        pdfMake.createPdf = function createProvenancedPdf(definition, ...rest) {
          const active = state.active;
          return originalCreatePdf(
            active && active.format === "pdf"
              ? appendPdfProvenance(definition, active.view)
              : definition,
            ...rest,
          );
        };
      }
    }

    function serialize(operation) {
      const run = state.queue.then(operation, operation);
      state.queue = run.catch(() => undefined);
      return run;
    }

    async function runWithManifest(format, original, ctx, args) {
      return serialize(async () => {
        const manifest = await createManifest(ctx, { UA, root });
        const normalized = await normalizeAndHash(manifest);
        const view = buildSourceView(normalized);
        await ensureLibraries();
        patchDocumentLibraries();
        state.active = Object.freeze({ format, manifest: normalized.manifest, view });
        try {
          const result = await original.call(UA, ctx, ...args);
          return Object.freeze({
            format,
            manifest: normalized.manifest,
            sourceManifestSha256: normalized.sha256,
            result,
          });
        } finally {
          state.active = null;
        }
      });
    }

    UA.exportToWord = function exportWordWithProvenance(ctx, ...args) {
      return runWithManifest("docx", originalWord, ctx, args);
    };
    UA.exportToPDF = function exportPdfWithProvenance(ctx, ...args) {
      return runWithManifest("pdf", originalPdf, ctx, args);
    };

    UA[INSTALL_MARKER] = true;
    UA.documentExportProvenanceRuntime = Object.freeze({
      buildSourceView,
      appendDocxProvenance,
      appendPdfProvenance,
      patchDocumentLibraries,
    });
    return UA.documentExportProvenanceRuntime;
  }

  return Object.freeze({
    HEADING,
    buildSourceView,
    appendDocxProvenance,
    appendPdfProvenance,
    install,
  });
});
