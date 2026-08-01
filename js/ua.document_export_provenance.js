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
    "Dieser Abschnitt nennt Datenquellen, Zeitstände, Lizenzen und wesentliche Verarbeitungsschritte in verständlicher Form. Der vollständige maschinenlesbare Nachweis ist in den Dokumentmetadaten eingebettet.";

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

  function shortHash(value) {
    const normalized = nonEmpty(value, "");
    return normalized ? `${normalized.slice(0, 12)}…` : "—";
  }

  function readableTimestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return nonEmpty(value);
    return new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Berlin",
    }).format(date);
  }

  const FILTER_LABELS = Object.freeze({
    severity: "Unfallschwere",
    dayType: "Wochentage",
    roadCondition: "Fahrbahnzustand",
    hourFrom: "Uhrzeit von",
    hourTo: "Uhrzeit bis",
    involvementMode: "Beteiligungsmodus",
    includeCyclist: "Radverkehr",
    includePedestrian: "Fußverkehr",
    includeCar: "Pkw",
    includeMotorcycle: "Motorrad",
    includeGkfz: "Lkw",
    includeSonstig: "Sonstige",
  });

  function readableFilterValue(key, value) {
    if (typeof value === "boolean") return value ? "einbezogen" : "nicht einbezogen";
    const text = String(value == null ? "" : value);
    const mappings = {
      all: "alle",
      and: "UND – alle gewählten Beteiligungen",
      or: "ODER – mindestens eine gewählte Beteiligung",
      solo: "Alleinunfall",
      weekday: "Montag bis Freitag",
      weekend: "Samstag und Sonntag",
    };
    if (Object.prototype.hasOwnProperty.call(mappings, text)) return mappings[text];
    if (key === "hourFrom" || key === "hourTo") return `${text}:00 Uhr`;
    return text || "nicht gesetzt";
  }

  function readableFilters(value) {
    if (!value || typeof value !== "object") return "keine zusätzlichen Filter";
    const hidden = new Set(["dataExportInvolvementPolicy"]);
    const entries = Object.entries(value)
      .filter(([key]) => !hidden.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${FILTER_LABELS[key] || key}: ${readableFilterValue(key, item)}`);
    return entries.length ? entries.join(" · ") : "keine zusätzlichen Filter";
  }

  function readableBounds(value) {
    if (!value || typeof value !== "object") return "nicht angegeben";
    const south = Number(value.south);
    const west = Number(value.west);
    const north = Number(value.north);
    const east = Number(value.east);
    if (![south, west, north, east].every(Number.isFinite)) return "nicht angegeben";
    return `${south.toFixed(5)}–${north.toFixed(5)}° N, ${west.toFixed(5)}–${east.toFixed(5)}° E`;
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
      sourceManifestJson: JSON.stringify(manifest),
      proofCode: shortHash(normalized.sha256),
      scenario: Object.freeze({
        city: nonEmpty(manifest.scenario?.city),
        years: Array.isArray(manifest.scenario?.years) && manifest.scenario.years.length
          ? manifest.scenario.years.join(", ")
          : "nicht angegeben",
        bounds: readableBounds(manifest.scenario?.bounds),
        filters: readableFilters(manifest.scenario?.filters),
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
          { text: " · Nachweis: ", bold: true },
          view.proofCode,
        ],
        margin: [0, 0, 0, 4],
      },
      {
        text: `Erstellt: ${readableTimestamp(view.generatedAt)} · Anwendung: ${view.applicationVersion}`,
        margin: [0, 0, 0, 7],
      },
      { text: "Auswertung", bold: true, margin: [0, 4, 0, 3] },
      {
        text: `Stadt: ${view.scenario.city} · Jahrgänge: ${view.scenario.years}`,
        margin: [0, 0, 0, 2],
      },
      { text: `Untersuchungsbereich: ${view.scenario.bounds}`, margin: [0, 0, 0, 2] },
      { text: `Filter: ${view.scenario.filters}`, margin: [0, 0, 0, 8] },
    ];

    view.sources.forEach((source, index) => {
      nodes.push({
        text: [
          { text: `${index + 1}. ${source.datasetTitle}`, bold: true },
          ` — ${source.publisher}`,
        ],
        margin: [0, index ? 6 : 2, 0, 2],
      });
      const links = [pdfLink("Datensatz", source.datasetUrl)];
      if (source.distributionUrl && source.distributionUrl !== source.datasetUrl) {
        links.push(" · ", pdfLink("Datenzugang", source.distributionUrl));
      }
      links.push(" · ", pdfLink(`Lizenz ${source.licenseId}`, source.licenseUrl));
      nodes.push({ text: links, margin: [0, 0, 0, 2] });
      const coverage = [
        source.temporalCoverage ? `Zeitraum ${source.temporalCoverage}` : null,
        source.spatialCoverage ? `Gebiet ${source.spatialCoverage}` : null,
        source.versionOrPublicationDate ? `Stand ${source.versionOrPublicationDate}` : null,
      ].filter(Boolean);
      if (coverage.length) nodes.push({ text: coverage.join(" · "), margin: [0, 0, 0, 2] });
      if (source.requiredAttribution) nodes.push({
        text: `Quellenvermerk: ${source.requiredAttribution}`,
        margin: [0, 0, 0, 2],
      });
      if (source.changedOrDerived && source.changeNotice) nodes.push({
        text: `Verarbeitung: ${source.changeNotice}`,
        margin: [0, 0, 0, source.qualityNotes.length ? 2 : 5],
      });
      source.qualityNotes.forEach((note) => nodes.push({
        text: `Grenzen: ${note}`,
        margin: [0, 0, 0, 2],
      }));
    });

    if (view.transformations.length) {
      nodes.push({ text: "Verarbeitungsschritte", bold: true, margin: [0, 6, 0, 3] });
      view.transformations.forEach((item) => nodes.push({
        text: `• ${item.label}: ${item.description}`,
        margin: [0, 0, 0, 2],
      }));
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
          docxTextRun(docx, " · Nachweis: ", { bold: true }),
          docxTextRun(docx, view.proofCode),
        ],
        spacing: { after: 80 },
      }),
      new docx.Paragraph({
        text: `Erstellt: ${readableTimestamp(view.generatedAt)} · Anwendung: ${view.applicationVersion}`,
        spacing: { after: 100 },
      }),
      new docx.Paragraph({
        children: [docxTextRun(docx, "Auswertung", { bold: true })],
        spacing: { before: 80, after: 40 },
      }),
      new docx.Paragraph({
        text: `Stadt: ${view.scenario.city} · Jahrgänge: ${view.scenario.years}`,
        spacing: { after: 40 },
      }),
      new docx.Paragraph({ text: `Untersuchungsbereich: ${view.scenario.bounds}`, spacing: { after: 40 } }),
      new docx.Paragraph({ text: `Filter: ${view.scenario.filters}`, spacing: { after: 120 } }),
    ];

    view.sources.forEach((source, index) => {
      nodes.push(new docx.Paragraph({
        children: [
          docxTextRun(docx, `${index + 1}. ${source.datasetTitle}`, { bold: true }),
          docxTextRun(docx, ` — ${source.publisher}`),
        ],
        spacing: { before: index ? 100 : 40, after: 40 },
      }));
      const links = [docxLink(docx, "Datensatz", source.datasetUrl)];
      if (source.distributionUrl && source.distributionUrl !== source.datasetUrl) {
        links.push(docxTextRun(docx, " · "));
        links.push(docxLink(docx, "Datenzugang", source.distributionUrl));
      }
      links.push(docxTextRun(docx, " · "));
      links.push(docxLink(docx, `Lizenz ${source.licenseId}`, source.licenseUrl));
      nodes.push(new docx.Paragraph({ children: links, spacing: { after: 40 } }));
      const coverage = [
        source.temporalCoverage ? `Zeitraum ${source.temporalCoverage}` : null,
        source.spatialCoverage ? `Gebiet ${source.spatialCoverage}` : null,
        source.versionOrPublicationDate ? `Stand ${source.versionOrPublicationDate}` : null,
      ].filter(Boolean);
      if (coverage.length) nodes.push(new docx.Paragraph({
        text: coverage.join(" · "),
        spacing: { after: 40 },
      }));
      if (source.requiredAttribution) nodes.push(new docx.Paragraph({
        text: `Quellenvermerk: ${source.requiredAttribution}`,
        spacing: { after: 40 },
      }));
      if (source.changedOrDerived && source.changeNotice) nodes.push(new docx.Paragraph({
        text: `Verarbeitung: ${source.changeNotice}`,
        spacing: { after: source.qualityNotes.length ? 40 : 100 },
      }));
      source.qualityNotes.forEach((note) => nodes.push(new docx.Paragraph({
        text: `Grenzen: ${note}`,
        spacing: { after: 40 },
      })));
    });

    if (view.transformations.length) {
      nodes.push(new docx.Paragraph({
        children: [docxTextRun(docx, "Verarbeitungsschritte", { bold: true })],
        spacing: { before: 100, after: 40 },
      }));
      view.transformations.forEach((item) => nodes.push(new docx.Paragraph({
        text: `• ${item.label}: ${item.description}`,
        spacing: { after: 40 },
      })));
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
    const info = {
      ...(definition.info || {}),
      title: definition.info?.title || `Unfallwerkbank – ${view.scenario.city}`,
      subject: definition.info?.subject || "Verkehrssicherheitsanalyse",
      creator: "Unfallwerkbank",
      keywords: "Verkehrssicherheit, Unfallatlas, kommunale Planung",
      UnfallwerkbankSourceManifestSha256: view.sourceManifestSha256,
      UnfallwerkbankSourceManifest: view.sourceManifestJson,
    };
    return {
      ...definition,
      content,
      info,
      tagged: true,
      displayTitle: true,
      language: "de-DE",
      version: definition.version || "1.7",
    };
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
      const customProperties = [
        ...(Array.isArray(options?.customProperties) ? options.customProperties : []),
        { name: "UnfallwerkbankSourceManifestSha256", value: view.sourceManifestSha256 },
        { name: "UnfallwerkbankSourceManifest", value: view.sourceManifestJson },
      ];
      return new OriginalDocument({
        ...options,
        title: options?.title || `Unfallwerkbank – ${view.scenario.city}`,
        subject: options?.subject || "Verkehrssicherheitsanalyse",
        creator: options?.creator || "Unfallwerkbank",
        description: options?.description || SOURCE_INTRO,
        customProperties,
        sections,
      });
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
