/**
 * Binds the existing PDF and DOCX renderers to the shared SourceManifest.
 *
 * The report renderer keeps ownership of layout and document construction.
 * This module scopes small proxies around the final document-library boundary,
 * replaces the legacy generic source paragraph and injects a validated,
 * renderer-neutral source view with real external hyperlinks.
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

  const LEGACY_SOURCE_HEADING = "DATENQUELLE";
  const SOURCE_HEADING = "DATENQUELLEN, METHODIK UND NACHVOLLZIEHBARKEIT";
  const LEGACY_SOURCE_TEXT =
    "Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).";
  const SOURCE_INTRO =
    "Die folgenden Angaben stammen aus dem für diesen Export eingefrorenen Quellenmanifest. Datensatz, Lizenz, Zeitstand und Verarbeitung sind dadurch gemeinsam mit den exportierten Fallzahlen nachvollziehbar.";

  class DocumentExportProvenanceError extends Error {
    constructor(code, message, details) {
      super(`${code}: ${message}`);
      this.name = "DocumentExportProvenanceError";
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new DocumentExportProvenanceError(code, message, details);
  }

  function requiredFunction(value, name) {
    if (typeof value !== "function") fail("missing_dependency", `${name} is unavailable`);
    return value;
  }

  function requireRuntime(UA) {
    requiredFunction(
      UA?.exportProvenanceRuntime?.createManifest,
      "UA.exportProvenanceRuntime.createManifest",
    );
    requiredFunction(
      UA?.artifactProvenance?.normalizeAndHash,
      "UA.artifactProvenance.normalizeAndHash",
    );
  }

  function nonEmpty(value, fallback = "—") {
    const normalized = String(value == null ? "" : value).trim();
    return normalized || fallback;
  }

  function safeLink(value, path) {
    if (typeof value !== "string" || !value.trim()) {
      fail("missing_link", `${path} must be a non-empty URL`);
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_) {
      fail("invalid_link", `${path} is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      fail("invalid_link_scheme", `${path} must use http or https`);
    }
    return parsed.toString();
  }

  function compactObject(value, emptyLabel) {
    if (!value || typeof value !== "object" || !Object.keys(value).length) return emptyLabel;
    return Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        if (Array.isArray(item)) return `${key}=${item.join(",")}`;
        if (item && typeof item === "object") return `${key}=${JSON.stringify(item)}`;
        return `${key}=${String(item)}`;
      })
      .join(" · ");
  }

  function sourceView(source, index) {
    const value = source || {};
    return Object.freeze({
      sourceId: nonEmpty(value.sourceId),
      role: nonEmpty(value.role),
      publisher: nonEmpty(value.publisher),
      datasetTitle: nonEmpty(value.datasetTitle),
      datasetUrl: safeLink(value.datasetUrl, `sources[${index}].datasetUrl`),
      distributionUrl: value.distributionUrl
        ? safeLink(value.distributionUrl, `sources[${index}].distributionUrl`)
        : null,
      licenseId: nonEmpty(value.licenseId),
      licenseName: nonEmpty(value.licenseName),
      licenseUrl: safeLink(value.licenseUrl, `sources[${index}].licenseUrl`),
      requiredAttribution: value.requiredAttribution ? nonEmpty(value.requiredAttribution) : null,
      temporalCoverage: value.temporalCoverage ? nonEmpty(value.temporalCoverage) : null,
      spatialCoverage: value.spatialCoverage ? nonEmpty(value.spatialCoverage) : null,
      versionOrPublicationDate: value.versionOrPublicationDate
        ? nonEmpty(value.versionOrPublicationDate)
        : null,
      retrievedAt: nonEmpty(value.retrievedAt),
      contentHash: value.contentHash ? nonEmpty(value.contentHash) : null,
      changedOrDerived: value.changedOrDerived === true,
      changeNotice: value.changeNotice ? nonEmpty(value.changeNotice) : null,
      qualityNotes: Object.freeze(
        Array.isArray(value.qualityNotes)
          ? value.qualityNotes.map((note) => nonEmpty(note)).filter((note) => note !== "—")
          : [],
      ),
    });
  }

  function transformationView(transformation) {
    const value = transformation || {};
    return Object.freeze({
      transformationId: nonEmpty(value.transformationId),
      label: nonEmpty(value.label),
      description: nonEmpty(value.description),
      sourceIds: Array.isArray(value.sourceIds) && value.sourceIds.length
        ? value.sourceIds.join(", ")
        : "keine",
      outputFields: Array.isArray(value.outputFields) && value.outputFields.length
        ? value.outputFields.join(", ")
        : "nicht angegeben",
      softwareVersion: value.softwareVersion ? nonEmpty(value.softwareVersion) : null,
      parameters: compactObject(value.parameters, "keine dokumentierten Parameter"),
    });
  }

  function buildSourceView(normalized) {
    const manifest = normalized?.manifest;
    if (!manifest || !Array.isArray(manifest.sources) || !manifest.sources.length) {
      fail("missing_sources", "document provenance requires at least one source");
    }
    return Object.freeze({
      heading: SOURCE_HEADING,
      artifactId: nonEmpty(manifest.artifactId),
      generatedAt: nonEmpty(manifest.generatedAt),
      applicationVersion: nonEmpty(manifest.applicationVersion),
      buildFingerprint: nonEmpty(manifest.buildFingerprint),
      dataFingerprint: nonEmpty(manifest.dataFingerprint),
      sourceManifestSha256: nonEmpty(normalized.sha256),
      scenario: Object.freeze({
        city: nonEmpty(manifest.scenario?.city),
        years: Array.isArray(manifest.scenario?.years) && manifest.scenario.years.length
          ? manifest.scenario.years.join(", ")
          : "nicht angegeben",
        bounds: compactObject(manifest.scenario?.bounds, "nicht angegeben"),
        filters: compactObject(manifest.scenario?.filters, "keine dokumentierten Filter"),
      }),
      sources: Object.freeze(manifest.sources.map(sourceView)),
      transformations: Object.freeze((manifest.transformations || []).map(transformationView)),
    });
  }

  function pdfLink(label, url) {
    return { text: label, link: url, color: "blue", decoration: "underline" };
  }

  function buildPdfBodyNodes(view) {
    const nodes = [
      { text: SOURCE_INTRO, margin: [0, 0, 0, 6] },
      {
        text: [
          { text: "Dokument-ID: ", bold: true },
          view.artifactId,
          { text: " · SourceManifest SHA-256: ", bold: true },
          view.sourceManifestSha256,
        ],
        margin: [0, 0, 0, 6],
      },
      {
        text: `Erzeugt: ${view.generatedAt} · Anwendung: ${view.applicationVersion}`,
        margin: [0, 0, 0, 3],
      },
      { text: `Build-Fingerprint: ${view.buildFingerprint}`, margin: [0, 0, 0, 2] },
      { text: `Daten-Fingerprint: ${view.dataFingerprint}`, margin: [0, 0, 0, 8] },
      { text: "Auswertungsszenario", bold: true, margin: [0, 4, 0, 3] },
      {
        text: `Stadt: ${view.scenario.city} · Jahrgänge: ${view.scenario.years}`,
        margin: [0, 0, 0, 2],
      },
      { text: `Räumlicher Ausschnitt: ${view.scenario.bounds}`, margin: [0, 0, 0, 2] },
      { text: `Aktive Filter: ${view.scenario.filters}`, margin: [0, 0, 0, 8] },
    ];

    view.sources.forEach((source, index) => {
      nodes.push({
        text: [
          { text: `${index + 1}. ${source.datasetTitle}`, bold: true },
          ` — ${source.publisher} [${source.sourceId}]`,
        ],
        margin: [0, index ? 6 : 2, 0, 2],
      });
      const links = [pdfLink("Datensatzseite öffnen", source.datasetUrl)];
      if (source.distributionUrl && source.distributionUrl !== source.datasetUrl) {
        links.push(" · ", pdfLink("Datenzugang öffnen", source.distributionUrl));
      }
      links.push(
        " · ",
        pdfLink(`Lizenz: ${source.licenseName} (${source.licenseId})`, source.licenseUrl),
      );
      nodes.push({ text: links, margin: [0, 0, 0, 2] });
      nodes.push({
        text: `Rolle: ${source.role} · Abruf/Erzeugung: ${source.retrievedAt}`,
        margin: [0, 0, 0, 2],
      });
      const coverage = [
        source.temporalCoverage ? `zeitlich ${source.temporalCoverage}` : null,
        source.spatialCoverage ? `räumlich ${source.spatialCoverage}` : null,
        source.versionOrPublicationDate
          ? `Version/Veröffentlichung ${source.versionOrPublicationDate}`
          : null,
      ].filter(Boolean);
      if (coverage.length) nodes.push({
        text: `Abdeckung: ${coverage.join(" · ")}`,
        margin: [0, 0, 0, 2],
      });
      if (source.requiredAttribution) nodes.push({
        text: `Vorgeschriebener Quellenvermerk: ${source.requiredAttribution}`,
        margin: [0, 0, 0, 2],
      });
      if (source.contentHash) nodes.push({
        text: `Quellbestand-Hash: ${source.contentHash}`,
        margin: [0, 0, 0, 2],
      });
      nodes.push({
        text: source.changedOrDerived
          ? `Gefiltert/transformiert: ja${source.changeNotice ? ` · ${source.changeNotice}` : ""}`
          : "Gefiltert/transformiert: nein",
        margin: [0, 0, 0, source.qualityNotes.length ? 2 : 5],
      });
      source.qualityNotes.forEach((note) => nodes.push({
        text: `Qualität/Grenzen: ${note}`,
        margin: [0, 0, 0, 2],
      }));
    });

    nodes.push({ text: "Transformationen", bold: true, margin: [0, 6, 0, 3] });
    if (view.transformations.length) {
      view.transformations.forEach((item) => nodes.push({
        text:
          `• ${item.label} [${item.transformationId}]: ${item.description} ` +
          `Quellen: ${item.sourceIds}. Ausgabefelder: ${item.outputFields}. ` +
          `${item.softwareVersion ? `Software: ${item.softwareVersion}. ` : ""}` +
          `Parameter: ${item.parameters}.`,
        margin: [0, 0, 0, 2],
      }));
    } else {
      nodes.push({
        text: "Keine zusätzlichen Transformationen dokumentiert.",
        margin: [0, 0, 0, 4],
      });
    }
    return nodes;
  }

  function validateSourceView(UA, view) {
    if (typeof UA?.runExportQAGate !== "function") return;
    const gate = UA.runExportQAGate([{ text: view.heading }, ...buildPdfBodyNodes(view)]);
    if (gate?.ok === false) {
      fail(
        "document_content_qa_failed",
        "manifest-driven document provenance contains non-publication-ready content",
        { violations: gate.violations || [] },
      );
    }
  }

  async function createSnapshot(ctx, UA, root) {
    requireRuntime(UA);
    const manifest = await UA.exportProvenanceRuntime.createManifest(ctx, { UA, root });
    const normalized = await UA.artifactProvenance.normalizeAndHash(manifest);
    const view = buildSourceView(normalized);
    validateSourceView(UA, view);
    return Object.freeze({
      manifest: normalized.manifest,
      sourceManifestSha256: normalized.sha256,
      view,
    });
  }

  function docxTextRun(docx, value, options = {}) {
    return new docx.TextRun({ text: String(value), ...options });
  }

  function docxLink(docx, label, url) {
    return new docx.ExternalHyperlink({
      link: url,
      children: [docxTextRun(docx, label, { style: "Hyperlink" })],
    });
  }

  function buildDocxBodyNodes(docx, view) {
    requiredFunction(docx.Paragraph, "docx.Paragraph");
    requiredFunction(docx.TextRun, "docx.TextRun");
    requiredFunction(docx.ExternalHyperlink, "docx.ExternalHyperlink");

    const nodes = [
      new docx.Paragraph({ text: SOURCE_INTRO, spacing: { after: 120 } }),
      new docx.Paragraph({
        children: [
          docxTextRun(docx, "Dokument-ID: ", { bold: true }),
          docxTextRun(docx, view.artifactId),
          docxTextRun(docx, " · SourceManifest SHA-256: ", { bold: true }),
          docxTextRun(docx, view.sourceManifestSha256),
        ],
        spacing: { after: 80 },
      }),
      new docx.Paragraph({
        text: `Erzeugt: ${view.generatedAt} · Anwendung: ${view.applicationVersion}`,
        spacing: { after: 40 },
      }),
      new docx.Paragraph({ text: `Build-Fingerprint: ${view.buildFingerprint}`, spacing: { after: 40 } }),
      new docx.Paragraph({ text: `Daten-Fingerprint: ${view.dataFingerprint}`, spacing: { after: 100 } }),
      new docx.Paragraph({
        children: [docxTextRun(docx, "Auswertungsszenario", { bold: true })],
        spacing: { before: 80, after: 40 },
      }),
      new docx.Paragraph({
        text: `Stadt: ${view.scenario.city} · Jahrgänge: ${view.scenario.years}`,
        spacing: { after: 40 },
      }),
      new docx.Paragraph({ text: `Räumlicher Ausschnitt: ${view.scenario.bounds}`, spacing: { after: 40 } }),
      new docx.Paragraph({ text: `Aktive Filter: ${view.scenario.filters}`, spacing: { after: 120 } }),
    ];

    view.sources.forEach((source, index) => {
      nodes.push(new docx.Paragraph({
        children: [
          docxTextRun(docx, `${index + 1}. ${source.datasetTitle}`, { bold: true }),
          docxTextRun(docx, ` — ${source.publisher} [${source.sourceId}]`),
        ],
        spacing: { before: index ? 100 : 40, after: 40 },
      }));
      const links = [docxLink(docx, "Datensatzseite öffnen", source.datasetUrl)];
      if (source.distributionUrl && source.distributionUrl !== source.datasetUrl) {
        links.push(docxTextRun(docx, " · "));
        links.push(docxLink(docx, "Datenzugang öffnen", source.distributionUrl));
      }
      links.push(docxTextRun(docx, " · "));
      links.push(docxLink(
        docx,
        `Lizenz: ${source.licenseName} (${source.licenseId})`,
        source.licenseUrl,
      ));
      nodes.push(new docx.Paragraph({ children: links, spacing: { after: 40 } }));
      nodes.push(new docx.Paragraph({
        text: `Rolle: ${source.role} · Abruf/Erzeugung: ${source.retrievedAt}`,
        spacing: { after: 40 },
      }));
      const coverage = [
        source.temporalCoverage ? `zeitlich ${source.temporalCoverage}` : null,
        source.spatialCoverage ? `räumlich ${source.spatialCoverage}` : null,
        source.versionOrPublicationDate
          ? `Version/Veröffentlichung ${source.versionOrPublicationDate}`
          : null,
      ].filter(Boolean);
      if (coverage.length) nodes.push(new docx.Paragraph({
        text: `Abdeckung: ${coverage.join(" · ")}`,
        spacing: { after: 40 },
      }));
      if (source.requiredAttribution) nodes.push(new docx.Paragraph({
        text: `Vorgeschriebener Quellenvermerk: ${source.requiredAttribution}`,
        spacing: { after: 40 },
      }));
      if (source.contentHash) nodes.push(new docx.Paragraph({
        text: `Quellbestand-Hash: ${source.contentHash}`,
        spacing: { after: 40 },
      }));
      nodes.push(new docx.Paragraph({
        text: source.changedOrDerived
          ? `Gefiltert/transformiert: ja${source.changeNotice ? ` · ${source.changeNotice}` : ""}`
          : "Gefiltert/transformiert: nein",
        spacing: { after: source.qualityNotes.length ? 40 : 100 },
      }));
      source.qualityNotes.forEach((note) => nodes.push(new docx.Paragraph({
        text: `Qualität/Grenzen: ${note}`,
        spacing: { after: 40 },
      })));
    });

    nodes.push(new docx.Paragraph({
      children: [docxTextRun(docx, "Transformationen", { bold: true })],
      spacing: { before: 100, after: 40 },
    }));
    if (view.transformations.length) {
      view.transformations.forEach((item) => nodes.push(new docx.Paragraph({
        text:
          `• ${item.label} [${item.transformationId}]: ${item.description} ` +
          `Quellen: ${item.sourceIds}. Ausgabefelder: ${item.outputFields}. ` +
          `${item.softwareVersion ? `Software: ${item.softwareVersion}. ` : ""}` +
          `Parameter: ${item.parameters}.`,
        spacing: { after: 40 },
      })));
    } else {
      nodes.push(new docx.Paragraph({
        text: "Keine zusätzlichen Transformationen dokumentiert.",
        spacing: { after: 80 },
      }));
    }
    return nodes;
  }

  function textOfPdfNode(node) {
    if (typeof node === "string") return node;
    if (!node || typeof node !== "object") return "";
    if (typeof node.text === "string") return node.text;
    if (Array.isArray(node.text)) {
      return node.text
        .map((part) => typeof part === "string" ? part : String(part?.text || ""))
        .join("");
    }
    return "";
  }

  function injectPdfDefinition(definition, view) {
    if (!definition || !Array.isArray(definition.content)) {
      fail("invalid_pdf_definition", "pdfMake document definition requires a content array");
    }
    const content = [...definition.content];
    const headingIndex = content.findIndex(
      (node) => textOfPdfNode(node).trim() === LEGACY_SOURCE_HEADING,
    );
    const legacyIndex = content.findIndex(
      (node) => textOfPdfNode(node).trim() === LEGACY_SOURCE_TEXT,
    );
    const body = buildPdfBodyNodes(view);
    if (headingIndex >= 0) content[headingIndex] = { ...content[headingIndex], text: SOURCE_HEADING };
    if (legacyIndex >= 0) content.splice(legacyIndex, 1, ...body);
    else if (headingIndex >= 0) content.splice(headingIndex + 1, 0, ...body);
    else content.push({ text: SOURCE_HEADING, style: "subheader", pageBreak: "before" }, ...body);
    return { ...definition, content };
  }

  function createDocxProxy(docx, view) {
    const OriginalDocument = requiredFunction(docx.Document, "docx.Document");
    const OriginalParagraph = requiredFunction(docx.Paragraph, "docx.Paragraph");
    requiredFunction(docx.TextRun, "docx.TextRun");
    requiredFunction(docx.ExternalHyperlink, "docx.ExternalHyperlink");
    const markers = new WeakMap();

    function WrappedParagraph(options) {
      let next = options;
      let marker = null;
      if (options?.text === LEGACY_SOURCE_HEADING) {
        next = { ...options, text: SOURCE_HEADING };
        marker = "heading";
      } else if (options?.text === LEGACY_SOURCE_TEXT) {
        next = { ...options, text: SOURCE_INTRO };
        marker = "intro";
      }
      const paragraph = new OriginalParagraph(next);
      if (marker) markers.set(paragraph, marker);
      return paragraph;
    }
    WrappedParagraph.prototype = OriginalParagraph.prototype;

    function WrappedDocument(options) {
      const sections = (options?.sections || []).map((section) => {
        const children = [...(section.children || [])];
        const headingIndex = children.findIndex((item) => markers.get(item) === "heading");
        const introIndex = children.findIndex((item) => markers.get(item) === "intro");
        const body = buildDocxBodyNodes({
          Paragraph: OriginalParagraph,
          TextRun: docx.TextRun,
          ExternalHyperlink: docx.ExternalHyperlink,
        }, view);
        if (introIndex >= 0) children.splice(introIndex, 1, ...body);
        else if (headingIndex >= 0) children.splice(headingIndex + 1, 0, ...body);
        else {
          children.push(
            new OriginalParagraph({
              text: SOURCE_HEADING,
              heading: docx.HeadingLevel?.HEADING_2,
              pageBreakBefore: true,
              spacing: { before: 400, after: 200 },
            }),
            ...body,
          );
        }
        return { ...section, children };
      });
      return new OriginalDocument({ ...options, sections });
    }
    WrappedDocument.prototype = OriginalDocument.prototype;

    return new Proxy(docx, {
      get(target, property, receiver) {
        if (property === "Paragraph") return WrappedParagraph;
        if (property === "Document") return WrappedDocument;
        return Reflect.get(target, property, receiver);
      },
    });
  }

  function withDocxBoundary(root, view, task) {
    const originalDocx = root?.docx;
    if (!originalDocx) fail("missing_docx_api", "DOCX renderer is unavailable");
    const proxiedDocx = createDocxProxy(originalDocx, view);
    try {
      root.docx = proxiedDocx;
    } catch (error) {
      fail("docx_boundary_unavailable", "window.docx cannot be scoped for provenance", error);
    }
    if (root.docx !== proxiedDocx) {
      fail("docx_boundary_unavailable", "window.docx cannot be scoped for provenance");
    }
    return Promise.resolve().then(task).finally(() => { root.docx = originalDocx; });
  }

  function withPdfBoundary(root, view, task) {
    const originalPdfMake = root?.pdfMake;
    if (!originalPdfMake) fail("missing_pdf_api", "pdfMake renderer is unavailable");
    const originalCreatePdf = requiredFunction(originalPdfMake.createPdf, "pdfMake.createPdf");
    const proxiedPdfMake = new Proxy(originalPdfMake, {
      get(target, property, receiver) {
        if (property === "createPdf") {
          return function createPdfWithSourceManifest(definition, ...args) {
            return originalCreatePdf.call(target, injectPdfDefinition(definition, view), ...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      root.pdfMake = proxiedPdfMake;
    } catch (error) {
      fail("pdf_boundary_unavailable", "window.pdfMake cannot be scoped for provenance", error);
    }
    if (root.pdfMake !== proxiedPdfMake) {
      fail("pdf_boundary_unavailable", "window.pdfMake cannot be scoped for provenance");
    }
    return Promise.resolve().then(task).finally(() => { root.pdfMake = originalPdfMake; });
  }

  function install(UA, root) {
    if (!UA || !root) fail("invalid_environment", "Browser UA and window are required");
    if (UA.__documentExportProvenanceInstalled) return UA.documentExportProvenanceRuntime;
    requireRuntime(UA);
    const ensureLibraries = requiredFunction(UA.ensureExportLibraries, "UA.ensureExportLibraries");
    const staged = UA.__documentProvenanceOriginals || {};
    const originals = {
      word: requiredFunction(staged.exportToWord, "original exportToWord"),
      pdf: requiredFunction(staged.exportToPDF, "original exportToPDF"),
    };

    let queue = Promise.resolve();
    const serialize = (task) => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    };

    const run = (format, ctx, original, args) => serialize(async () => {
      const snapshot = await createSnapshot(ctx, UA, root);
      await ensureLibraries();
      const result = format === "docx"
        ? await withDocxBoundary(root, snapshot.view, () => original.call(UA, ctx, ...args))
        : await withPdfBoundary(root, snapshot.view, () => original.call(UA, ctx, ...args));
      return Object.freeze({
        format,
        manifest: snapshot.manifest,
        sourceManifestSha256: snapshot.sourceManifestSha256,
        result,
      });
    });

    UA.exportToWord = function exportWordWithSourceManifest(ctx, ...args) {
      return run("docx", ctx, originals.word, args);
    };
    UA.exportToPDF = function exportPdfWithSourceManifest(ctx, ...args) {
      return run("pdf", ctx, originals.pdf, args);
    };

    delete UA.__documentProvenanceOriginals;
    UA.__documentExportProvenanceInstalled = true;
    UA.documentExportProvenanceRuntime = Object.freeze({
      originals,
      createSnapshot: (ctx) => createSnapshot(ctx, UA, root),
      buildSourceView,
      buildDocxBodyNodes,
      buildPdfBodyNodes,
      injectPdfDefinition,
      validateSourceView: (view) => validateSourceView(UA, view),
    });
    return UA.documentExportProvenanceRuntime;
  }

  return Object.freeze({
    LEGACY_SOURCE_HEADING,
    SOURCE_HEADING,
    LEGACY_SOURCE_TEXT,
    SOURCE_INTRO,
    DocumentExportProvenanceError,
    buildSourceView,
    buildDocxBodyNodes,
    buildPdfBodyNodes,
    injectPdfDefinition,
    validateSourceView,
    createSnapshot,
    install,
  });
});
