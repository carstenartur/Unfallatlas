/**
 * Provenance-bound static map export.
 *
 * The browser never downloads a naked PNG. It captures the fully rendered map,
 * appends a visible source strip and packages the final PNG with an artifact-
 * bound SourceManifest sidecar and README in one deterministic ZIP.
 */
(function initStaticMapExportProvenance(root, factory) {
  const artifactProvenance =
    typeof module !== "undefined" && module.exports
      ? require("./ua.artifact_provenance")
      : root?.UA?.artifactProvenance;
  const zip =
    typeof module !== "undefined" && module.exports
      ? require("./ua.zip")
      : root?.UA?.zip;
  const api = factory(artifactProvenance, zip);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.staticMapExportProvenance = api;
    try {
      api.install(UA, root);
    } catch (error) {
      UA.staticMapExportProvenanceError = error;
      root.console?.error?.(
        "PNG-Export-Provenienz konnte nicht initialisiert werden",
        error,
      );
    }
  }
})(
  typeof window !== "undefined" ? window : null,
  function createStaticMapExportProvenanceApi(artifactProvenance, zip) {
    "use strict";

    const PNG_MEDIA_TYPE = "image/png";
    const PACKAGE_MEDIA_TYPE = "application/zip";
    const DEFAULT_NOTICE_CHARACTERS = 320;
    const PNG_SIGNATURE = Object.freeze([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const OSM_SOURCE_ID = "basemap.openstreetmap.standard";

    class StaticMapExportError extends Error {
      constructor(code, message, details) {
        super(`${code}: ${message}`);
        this.name = "StaticMapExportError";
        this.code = code;
        this.details = details || null;
      }
    }

    function fail(code, message, details) {
      throw new StaticMapExportError(code, message, details);
    }

    function requireDependencies() {
      if (
        !artifactProvenance?.normalizeAndHash ||
        !artifactProvenance?.buildMediaProvenance ||
        !artifactProvenance?.visibleSourceLines
      ) {
        fail("missing_dependency", "Artifact provenance API is unavailable");
      }
      if (!zip?.createStoredZip) {
        fail("missing_dependency", "ZIP API is unavailable");
      }
    }

    function byteArray(value, path = "bytes") {
      if (value instanceof Uint8Array) return value;
      if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
        return new Uint8Array(value);
      }
      fail("invalid_bytes", `${path} must be a Uint8Array or Buffer`);
    }

    function validatePngBytes(value, path = "png") {
      const content = byteArray(value, path);
      if (content.byteLength < PNG_SIGNATURE.length) {
        fail("invalid_png", `${path} is shorter than the PNG signature`);
      }
      for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
        if (content[index] !== PNG_SIGNATURE[index]) {
          fail("invalid_png", `${path} does not contain a PNG signature`);
        }
      }
      return content;
    }

    function decodeBase64(value, environment = {}) {
      const rootValue =
        environment.root || (typeof window !== "undefined" ? window : null);
      if (typeof rootValue?.atob === "function") {
        const binary = rootValue.atob(value);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
      }
      if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(value, "base64"));
      }
      fail("base64_unavailable", "No base64 decoder is available");
    }

    function pngBytesFromDataUrl(value, environment = {}) {
      if (typeof value !== "string") {
        fail("invalid_data_url", "PNG capture must be a data URL string");
      }
      const match = value.match(
        /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/,
      );
      if (!match) {
        fail(
          "invalid_data_url",
          "PNG capture must use an image/png base64 data URL",
        );
      }
      return validatePngBytes(
        decodeBase64(match[1], environment),
        "captured PNG",
      );
    }

    function safeArtifactName(value) {
      const raw = String(value || "unfallwerkbank-karte.png").normalize("NFKC");
      const stem = raw
        .replace(/\.png$/i, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 112);
      if (!stem || stem === "." || stem === "..") {
        fail("invalid_filename", "PNG artifact name is unsafe");
      }
      return `${stem}.png`;
    }

    function artifactNameForManifest(manifest) {
      const id = String(manifest?.artifactId || "unfallwerkbank").trim();
      return safeArtifactName(`${id}-karte.png`);
    }

    function activeContextOverlays(ctx) {
      const active = ctx?.contextOverlays?.active || {};
      return Object.keys(active)
        .filter((key) => active[key] === true)
        .sort();
    }

    function activeMapDescriptor(UA, ctx) {
      const overlays = activeContextOverlays(ctx);
      if (overlays.length) {
        fail(
          "unsupported_context_source_provenance",
          "Active context overlays do not yet expose complete renderer provenance",
          { overlays },
        );
      }

      let info = null;
      if (typeof UA?.getActiveMapLayerInfo === "function") {
        try {
          info = UA.getActiveMapLayerInfo(ctx);
        } catch (_) {
          info = null;
        }
      }
      const mode = String(info?.mode || ctx?.mapMode || "standard").toLowerCase();
      const hasOrthophoto = Boolean(info?.orthophoto);
      if (mode !== "standard" || hasOrthophoto) {
        fail(
          "unsupported_map_source_provenance",
          "Static PNG export is currently limited to the fully specified OpenStreetMap standard basemap",
          {
            mode,
            orthophotoId: info?.orthophoto?.id || null,
            requestedMode: info?.requestedMode || ctx?.mapMode || null,
          },
        );
      }
      return Object.freeze({
        mode: "standard",
        layerIds: Object.freeze(["standard-osm"]),
      });
    }

    function osmSource(manifest) {
      return {
        sourceId: OSM_SOURCE_ID,
        role: "basemap",
        publisher: "OpenStreetMap-Mitwirkende",
        datasetTitle: "OpenStreetMap Standard-Grundkarte",
        datasetUrl: "https://www.openstreetmap.org/",
        distributionUrl: "https://tile.openstreetmap.org/",
        licenseId: "ODbL-1.0",
        licenseName: "Open Data Commons Open Database License 1.0",
        licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
        requiredAttribution: "© OpenStreetMap-Mitwirkende",
        spatialCoverage: manifest.scenario?.city,
        retrievedAt: manifest.generatedAt,
        changedOrDerived: true,
        changeNotice:
          "Kartenkacheln wurden für den gewählten Ausschnitt gerendert, mit Analyseebenen kombiniert und in ein PNG überführt.",
        qualityNotes: [
          "Community-basierte Grundkarte; nicht als amtliche Katastergrundlage zu interpretieren.",
        ],
        permissions: {
          permitsRedistribution: true,
          permitsDerivatives: true,
          commercialUseAllowed: true,
        },
      };
    }

    async function buildStaticMapManifest(manifestValue, UA, ctx) {
      requireDependencies();
      const base = await artifactProvenance.normalizeAndHash(manifestValue);
      const descriptor = activeMapDescriptor(UA, ctx);
      const copy = JSON.parse(JSON.stringify(base.manifest));
      if (!copy.sources.some((source) => source.sourceId === OSM_SOURCE_ID)) {
        copy.sources.push(osmSource(copy));
      }
      const transformationId = "render-static-map-png";
      if (
        copy.transformations.some(
          (transformation) => transformation.transformationId === transformationId,
        )
      ) {
        fail(
          "existing_static_map_transformation",
          "Manifest already contains the static map rendering transformation",
        );
      }
      copy.transformations.push({
        transformationId,
        label: "Statisches Kartenbild rendern",
        description:
          "Rendert die aktive Standardgrundkarte und die gefilterten Unfallanalyseebenen in ein PNG mit sichtbarer Quellenleiste.",
        sourceIds: copy.sources.map((source) => source.sourceId),
        outputFields: ["mapPixels", "visibleSourceNotice"],
        softwareVersion: copy.applicationVersion,
        parameters: {
          mapMode: descriptor.mode,
          layerIds: descriptor.layerIds,
          renderer: "leaflet-image",
          visibleSourceStrip: true,
        },
      });
      return artifactProvenance.normalizeAndHash(copy);
    }

    function measure(context, text) {
      const width = context?.measureText?.(text)?.width;
      return Number.isFinite(width) ? width : String(text).length * 7;
    }

    function ellipsize(context, text, maxWidth) {
      const suffix = "…";
      let value = String(text || "").trim();
      while (value && measure(context, `${value}${suffix}`) > maxWidth) {
        value = value.slice(0, -1);
      }
      return value ? `${value}${suffix}` : suffix;
    }

    function fittingPrefixLength(context, value, maxWidth) {
      let low = 1;
      let high = value.length;
      let best = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (measure(context, value.slice(0, middle)) <= maxWidth) {
          best = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return best;
    }

    function wrapText(context, value, maxWidth, maxLines) {
      let remaining = String(value || "").trim();
      const lines = [];
      while (remaining && lines.length < maxLines) {
        if (measure(context, remaining) <= maxWidth) {
          lines.push(remaining);
          remaining = "";
          break;
        }
        const prefixLength = fittingPrefixLength(context, remaining, maxWidth);
        let cut = prefixLength;
        const whitespace = remaining.lastIndexOf(" ", prefixLength);
        if (whitespace >= Math.floor(prefixLength * 0.45)) cut = whitespace;
        let line = remaining.slice(0, cut).trim();
        remaining = remaining.slice(cut).trim();
        if (lines.length === maxLines - 1 && remaining) {
          line = ellipsize(context, `${line} ${remaining}`, maxWidth);
          remaining = "";
        }
        lines.push(line || ellipsize(context, remaining, maxWidth));
      }
      return lines;
    }

    function defaultLoadImage(rootValue, dataUrl) {
      if (typeof rootValue?.Image !== "function") {
        fail("image_decoder_unavailable", "Browser Image decoder is unavailable");
      }
      return new Promise((resolve, reject) => {
        const image = new rootValue.Image();
        image.onload = () => resolve(image);
        image.onerror = () =>
          reject(
            new StaticMapExportError(
              "image_decode_failed",
              "Captured map PNG could not be decoded",
            ),
          );
        image.src = dataUrl;
      });
    }

    function defaultCanvasFactory(rootValue) {
      const canvas = rootValue?.document?.createElement?.("canvas");
      if (!canvas) fail("canvas_unavailable", "Browser canvas is unavailable");
      return canvas;
    }

    function verifySourceStrip(context, sourceHeight, outputHeight, width) {
      if (typeof context?.getImageData !== "function") {
        fail(
          "source_strip_verification_unavailable",
          "Canvas pixel verification is unavailable",
        );
      }
      let border;
      let background;
      try {
        border = context.getImageData(
          Math.min(2, width - 1),
          sourceHeight,
          1,
          1,
        ).data;
        background = context.getImageData(
          Math.max(0, width - 2),
          Math.max(sourceHeight + 3, outputHeight - 2),
          1,
          1,
        ).data;
      } catch (error) {
        fail("source_strip_verification_failed", error.message);
      }
      const darkBorder =
        border[0] < 90 &&
        border[1] < 90 &&
        border[2] < 90 &&
        border[3] > 200;
      const lightBackground =
        background[0] > 220 &&
        background[1] > 220 &&
        background[2] > 220 &&
        background[3] > 200;
      if (!darkBorder || !lightBackground) {
        fail(
          "source_strip_verification_failed",
          "Rendered PNG source strip failed pixel verification",
        );
      }
    }

    async function renderPngWithSourceStrip(options) {
      const opts = options || {};
      const rootValue =
        opts.root || (typeof window !== "undefined" ? window : null);
      pngBytesFromDataUrl(opts.sourceDataUrl, { root: rootValue });
      const image = await (opts.loadImage || defaultLoadImage)(
        rootValue,
        opts.sourceDataUrl,
      );
      const sourceWidth = Number(image?.naturalWidth || image?.width);
      const sourceHeight = Number(image?.naturalHeight || image?.height);
      if (
        !Number.isInteger(sourceWidth) ||
        !Number.isInteger(sourceHeight) ||
        sourceWidth < 240 ||
        sourceHeight < 160
      ) {
        fail("invalid_dimensions", "Captured map PNG has invalid dimensions", {
          width: sourceWidth,
          height: sourceHeight,
        });
      }
      if (
        sourceWidth > 16384 ||
        sourceHeight > 16384 ||
        sourceWidth * sourceHeight > 120000000
      ) {
        fail(
          "unsafe_dimensions",
          "Captured map PNG exceeds the safe rendering budget",
        );
      }

      const canvas = (opts.canvasFactory || defaultCanvasFactory)(rootValue);
      const context = canvas.getContext?.("2d", { alpha: false });
      if (!context) {
        fail("canvas_context_unavailable", "2D canvas context is unavailable");
      }

      const fontSize = Math.max(12, Math.min(16, Math.round(sourceWidth / 70)));
      const lineHeight = fontSize + 5;
      const padding = Math.max(12, Math.round(fontSize * 0.9));
      const maxTextWidth = Math.max(80, sourceWidth - padding * 2);
      context.font = `600 ${fontSize}px system-ui, sans-serif`;
      const noticeLines = wrapText(
        context,
        opts.visibleNotice,
        maxTextWidth,
        3,
      );
      context.font = `400 ${Math.max(
        11,
        fontSize - 1,
      )}px ui-monospace, monospace`;
      const hashLines = wrapText(
        context,
        `SourceManifest SHA-256: ${String(
          opts.sourceManifestSha256 || "",
        )}`,
        maxTextWidth,
        2,
      );
      if (!noticeLines.length || !hashLines.length) {
        fail(
          "missing_source_notice",
          "Visible source notice and manifest hash are required",
        );
      }

      const stripHeight =
        3 + padding * 2 + (noticeLines.length + hashLines.length) * lineHeight;
      const outputHeight = sourceHeight + stripHeight;
      if (outputHeight > 16384) {
        fail(
          "unsafe_dimensions",
          "PNG plus source strip exceeds canvas limits",
        );
      }

      canvas.width = sourceWidth;
      canvas.height = outputHeight;
      context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
      context.fillStyle = "#ffffff";
      context.fillRect(0, sourceHeight, sourceWidth, stripHeight);
      context.fillStyle = "#1f2937";
      context.fillRect(0, sourceHeight, sourceWidth, 3);
      context.textBaseline = "top";

      let y = sourceHeight + padding;
      context.fillStyle = "#111827";
      context.font = `600 ${fontSize}px system-ui, sans-serif`;
      for (const line of noticeLines) {
        context.fillText(line, padding, y, maxTextWidth);
        y += lineHeight;
      }
      context.fillStyle = "#374151";
      context.font = `400 ${Math.max(
        11,
        fontSize - 1,
      )}px ui-monospace, monospace`;
      for (const line of hashLines) {
        context.fillText(line, padding, y, maxTextWidth);
        y += lineHeight;
      }

      verifySourceStrip(context, sourceHeight, outputHeight, sourceWidth);
      const dataUrl = canvas.toDataURL?.(PNG_MEDIA_TYPE);
      const outputBytes = pngBytesFromDataUrl(dataUrl, { root: rootValue });
      return Object.freeze({
        bytes: outputBytes,
        dataUrl,
        width: sourceWidth,
        height: outputHeight,
        sourceHeight,
        stripHeight,
        visibleNotice: opts.visibleNotice,
        sourceManifestSha256: opts.sourceManifestSha256,
      });
    }

    function buildReadme(options) {
      const opts = options || {};
      return (
        `Unfallwerkbank – Kartenexport mit Quellenprovenienz\n` +
        `===================================================\n\n` +
        `Dateien\n-------\n` +
        `- ${opts.artifactName}: Kartenbild mit dauerhaft sichtbarer Quellenleiste.\n` +
        `- ${opts.sidecarFileName}: vollständiges SourceManifest und Bindung an den PNG-Hash.\n` +
        `- README.txt: diese Erläuterung.\n\n` +
        `PNG SHA-256: ${opts.artifactSha256}\n` +
        `SourceManifest SHA-256: ${opts.sourceManifestSha256}\n` +
        `Sidecar SHA-256: ${opts.sidecarSha256}\n\n` +
        `${artifactProvenance.visibleSourceLines(opts.manifest).join("\n")}\n`
      );
    }

    async function buildPngPackage(options) {
      requireDependencies();
      const opts = options || {};
      const normalized = await artifactProvenance.normalizeAndHash(opts.manifest);
      const noticeOptions = {
        maxCharacters:
          Number(opts.noticeOptions?.maxCharacters) ||
          DEFAULT_NOTICE_CHARACTERS,
        ...(opts.noticeOptions?.prefix
          ? { prefix: opts.noticeOptions.prefix }
          : {}),
      };
      const visibleNotice = artifactProvenance.compactSourceNotice(
        normalized.manifest,
        noticeOptions,
      );
      const artifactName = safeArtifactName(
        opts.artifactName || artifactNameForManifest(normalized.manifest),
      );
      const renderer = opts.renderPng || renderPngWithSourceStrip;
      const rendered = await renderer({
        sourceDataUrl: opts.sourceDataUrl,
        visibleNotice,
        sourceManifestSha256: normalized.sha256,
        root: opts.root,
        loadImage: opts.loadImage,
        canvasFactory: opts.canvasFactory,
      });
      const pngBytes = validatePngBytes(
        rendered?.bytes || rendered,
        "rendered PNG",
      );
      if (!rendered || rendered.visibleNotice !== visibleNotice) {
        fail(
          "notice_mismatch",
          "Rendered source notice differs from the sidecar notice",
        );
      }
      if (rendered.sourceManifestSha256 !== normalized.sha256) {
        fail(
          "manifest_hash_mismatch",
          "Rendered PNG does not identify the packaged SourceManifest",
        );
      }

      const media = await artifactProvenance.buildMediaProvenance({
        artifactName,
        artifactMediaType: PNG_MEDIA_TYPE,
        artifactBytes: pngBytes,
        manifest: normalized.manifest,
        noticeOptions,
      });
      if (media.visibleNotice !== visibleNotice) {
        fail(
          "notice_mismatch",
          "Artifact sidecar notice differs from the rendered source notice",
        );
      }
      const sidecar = JSON.parse(media.sidecarJson);
      if (sidecar.sourceManifestSha256 !== normalized.sha256) {
        fail(
          "manifest_hash_mismatch",
          "Sidecar does not bind the rendered manifest",
        );
      }

      const readme = buildReadme({
        artifactName,
        sidecarFileName: media.sidecarFileName,
        artifactSha256: sidecar.artifact.sha256,
        sourceManifestSha256: normalized.sha256,
        sidecarSha256: media.sidecarSha256,
        manifest: normalized.manifest,
      });
      const entries = Object.freeze([
        Object.freeze({
          name: artifactName,
          mediaType: PNG_MEDIA_TYPE,
          content: pngBytes,
        }),
        Object.freeze({
          name: media.sidecarFileName,
          mediaType: "application/json;charset=utf-8",
          content: media.sidecarJson,
        }),
        Object.freeze({
          name: "README.txt",
          mediaType: "text/plain;charset=utf-8",
          content: readme,
        }),
      ]);
      const archive = zip.createStoredZip(entries);
      return Object.freeze({
        packageFileName: artifactName.replace(/\.png$/i, ".zip"),
        packageMediaType: PACKAGE_MEDIA_TYPE,
        archive,
        archiveSha256: await artifactProvenance.sha256(archive),
        entries,
        artifactName,
        artifactSha256: sidecar.artifact.sha256,
        sidecarFileName: media.sidecarFileName,
        sidecarSha256: media.sidecarSha256,
        sourceManifestSha256: normalized.sha256,
        visibleNotice,
        manifest: normalized.manifest,
        rendered,
      });
    }

    function heatmapExportOpacity(rootValue) {
      const element = rootValue?.document?.getElementById?.(
        "heatExportOpacity",
      );
      const value = Number(element?.value);
      return Number.isFinite(value)
        ? Math.max(0, Math.min(100, value)) / 100
        : 0.4;
    }

    function download(rootValue, content, filename) {
      const blob = new rootValue.Blob([content], {
        type: PACKAGE_MEDIA_TYPE,
      });
      if (typeof rootValue.saveAs === "function") {
        rootValue.saveAs(blob, filename);
        return;
      }
      if (!rootValue.URL?.createObjectURL || !rootValue.document?.createElement) {
        fail("download_unavailable", "Browser download API is unavailable");
      }
      const url = rootValue.URL.createObjectURL(blob);
      const anchor = rootValue.document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.hidden = true;
      rootValue.document.body.appendChild(anchor);
      anchor.click();
      rootValue.setTimeout(() => {
        rootValue.URL.revokeObjectURL(url);
        anchor.remove();
      }, 1000);
    }

    async function exportCurrentMap(UA, rootValue, ctxValue, options = {}) {
      requireDependencies();
      if (!UA || !rootValue) {
        fail("invalid_environment", "Browser UA and window are required");
      }
      const ctx = ctxValue || UA.getRuntimeContext?.();
      if (!ctx || typeof ctx !== "object") {
        fail("missing_context", "Runtime map context is unavailable");
      }
      if (typeof UA.captureExportMapImage !== "function") {
        fail(
          "missing_capture",
          "Readiness-checked map capture is unavailable",
        );
      }
      const createManifest = UA.exportProvenanceRuntime?.createManifest;
      if (typeof createManifest !== "function") {
        fail(
          "missing_manifest_runtime",
          "Live SourceManifest runtime is unavailable",
        );
      }

      const baseBefore = await createManifest(ctx, { UA, root: rootValue });
      const before = await buildStaticMapManifest(baseBefore, UA, ctx);
      const sourceDataUrl = await UA.captureExportMapImage(ctx, {
        heatmapExportOpacity:
          options.heatmapExportOpacity ?? heatmapExportOpacity(rootValue),
      });
      const baseAfter = await createManifest(ctx, { UA, root: rootValue });
      const after = await buildStaticMapManifest(baseAfter, UA, ctx);
      if (before.sha256 !== after.sha256) {
        fail(
          "state_changed_during_capture",
          "Map state changed while the PNG was being captured; export was aborted",
          { before: before.sha256, after: after.sha256 },
        );
      }

      const result = await buildPngPackage({
        manifest: before.manifest,
        sourceDataUrl,
        artifactName:
          options.artifactName || artifactNameForManifest(before.manifest),
        noticeOptions: options.noticeOptions,
        root: rootValue,
        renderPng: options.renderPng,
        loadImage: options.loadImage,
        canvasFactory: options.canvasFactory,
      });
      if (options.download !== false) {
        download(rootValue, result.archive, result.packageFileName);
      }
      return result;
    }

    function createElement(documentValue, tag, properties = {}) {
      const element = documentValue.createElement(tag);
      for (const [key, value] of Object.entries(properties)) {
        if (key === "textContent") element.textContent = value;
        else if (key === "style") element.style.cssText = value;
        else element.setAttribute(key, value);
      }
      return element;
    }

    function ensureUi(rootValue) {
      const documentValue = rootValue.document;
      let container = documentValue.getElementById(
        "staticMapExportContainer",
      );
      if (container) {
        return {
          container,
          button: documentValue.getElementById("btnExportPNG"),
          progress: documentValue.getElementById(
            "staticMapExportProgress",
          ),
        };
      }

      container = createElement(documentValue, "fieldset", {
        id: "staticMapExportContainer",
        "data-export-group": "visualization",
        style:
          "margin-top:10px;padding:8px 12px;border:1px solid rgba(0,0,0,.12);border-radius:12px;",
      });
      const legend = createElement(documentValue, "legend", {
        textContent: "🖼️ Kartenbild",
        style: "font-weight:700;padding:0 6px;color:#555;",
      });
      const button = createElement(documentValue, "button", {
        id: "btnExportPNG",
        type: "button",
        "aria-label":
          "Kartenbild mit vollständiger Quellenprovenienz exportieren",
        textContent: "🗺️ Karte + Quellen (ZIP)",
        style:
          "width:100%;padding:10px 16px;background:#365f91;color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:13px;",
      });
      const explanation = createElement(documentValue, "div", {
        textContent:
          "PNG, sichtbare Quellenleiste und hashgebundenes Sidecar. Noch nicht vollständig beschriebene Karten- oder Kontextquellen blockieren den Export.",
        style:
          "margin-top:6px;font-size:11px;color:#666;line-height:1.4;",
      });
      const progress = createElement(documentValue, "div", {
        id: "staticMapExportProgress",
        role: "status",
        "aria-live": "polite",
        style:
          "display:none;margin-top:8px;font-size:12px;color:#555;",
      });
      container.append(legend, button, explanation, progress);

      const videoContainer = documentValue.getElementById(
        "videoExportContainer",
      );
      const dataContainer = documentValue.getElementById("exportGroupData");
      if (videoContainer?.parentNode) {
        videoContainer.parentNode.insertBefore(container, videoContainer);
      } else if (dataContainer?.parentNode) {
        dataContainer.parentNode.insertBefore(
          container,
          dataContainer.nextSibling,
        );
      } else {
        documentValue.body.appendChild(container);
      }
      return { container, button, progress };
    }

    function reportFailure(UA, rootValue, progress, error) {
      rootValue.console?.error?.(
        "PNG-Kartenexport mit Quellenprovenienz fehlgeschlagen",
        error,
      );
      if (progress) {
        progress.textContent = `❌ Export abgebrochen: ${
          error?.message || String(error)
        }`;
        progress.style.display = "";
      }
      if (typeof UA.showToast === "function") {
        UA.showToast(
          "PNG-Export abgebrochen: Karte und Quellen konnten nicht konsistent erzeugt werden.",
        );
      }
      if (
        typeof rootValue.CustomEvent === "function" &&
        rootValue.dispatchEvent
      ) {
        rootValue.dispatchEvent(
          new rootValue.CustomEvent("unfallwerkbank:export-error", {
            detail: {
              code: error?.code || "png_export_failed",
              message: error?.message || String(error),
            },
          }),
        );
      }
    }

    function install(UA, rootValue) {
      requireDependencies();
      if (!UA || !rootValue?.document) {
        return Object.freeze({ available: false });
      }
      if (UA.__staticMapExportProvenanceInstalled) {
        return UA.staticMapExportProvenanceRuntime;
      }
      if (
        typeof rootValue.leafletImage !== "function" ||
        typeof UA.captureExportMapImage !== "function"
      ) {
        return Object.freeze({
          available: false,
          reason: "map_capture_unavailable",
        });
      }
      if (typeof UA.exportProvenanceRuntime?.createManifest !== "function") {
        fail(
          "missing_manifest_runtime",
          "Export provenance must load before static map export",
        );
      }

      const ui = ensureUi(rootValue);
      if (!ui.button) {
        fail(
          "missing_button",
          "Static map export button could not be created",
        );
      }
      ui.button.addEventListener("click", async () => {
        ui.button.disabled = true;
        ui.button.style.opacity = "0.65";
        if (ui.progress) {
          ui.progress.textContent =
            "🖼️ Karte, Quellenleiste und Sidecar werden erzeugt…";
          ui.progress.style.display = "";
        }
        try {
          const result = await exportCurrentMap(UA, rootValue);
          if (ui.progress) {
            ui.progress.textContent = `✅ ${result.packageFileName} wurde vollständig erzeugt.`;
          }
          if (
            typeof rootValue.CustomEvent === "function" &&
            rootValue.dispatchEvent
          ) {
            rootValue.dispatchEvent(
              new rootValue.CustomEvent(
                "unfallwerkbank:static-map-exported",
                {
                  detail: {
                    packageFileName: result.packageFileName,
                    artifactSha256: result.artifactSha256,
                    sourceManifestSha256: result.sourceManifestSha256,
                  },
                },
              ),
            );
          }
        } catch (error) {
          reportFailure(UA, rootValue, ui.progress, error);
        } finally {
          ui.button.disabled = false;
          ui.button.style.opacity = "1";
        }
      });

      UA.exportMapPngPackage = (ctx, options) =>
        exportCurrentMap(UA, rootValue, ctx, options);
      UA.__staticMapExportProvenanceInstalled = true;
      UA.staticMapExportProvenanceRuntime = Object.freeze({
        available: true,
        button: ui.button,
        exportCurrentMap: (ctx, options) =>
          exportCurrentMap(UA, rootValue, ctx, options),
      });
      return UA.staticMapExportProvenanceRuntime;
    }

    return Object.freeze({
      PNG_MEDIA_TYPE,
      PACKAGE_MEDIA_TYPE,
      OSM_SOURCE_ID,
      StaticMapExportError,
      validatePngBytes,
      pngBytesFromDataUrl,
      safeArtifactName,
      artifactNameForManifest,
      activeContextOverlays,
      activeMapDescriptor,
      buildStaticMapManifest,
      wrapText,
      renderPngWithSourceStrip,
      buildPngPackage,
      exportCurrentMap,
      install,
    });
  },
);
