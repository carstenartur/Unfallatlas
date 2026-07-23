(function initMediaProvenanceBadge(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.mediaProvenanceBadge = api;
  }
})(typeof window !== "undefined" ? window : null, function createMediaProvenanceBadgeApi() {
  "use strict";

  const DEFAULT_ID = "ua-media-source-provenance";
  const BORDER_COLOR = Object.freeze([255, 193, 7]);
  const BACKGROUND_COLOR = Object.freeze([0, 77, 64]);
  const MIN_TARGET_WIDTH = 180;
  const MIN_TARGET_HEIGHT = 40;

  class MediaProvenanceBadgeError extends Error {
    constructor(code, message, details) {
      super(`${code}: ${message}`);
      this.name = "MediaProvenanceBadgeError";
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new MediaProvenanceBadgeError(code, message, details);
  }

  function validHash(value) {
    return /^[a-f0-9]{64}$/i.test(String(value || ""));
  }

  function sourceRecord(manifest) {
    const sources = Array.isArray(manifest && manifest.sources) ? manifest.sources : [];
    const source = sources.find(item => item && item.role === "accidents") || sources[0];
    if (!source) fail("missing_media_source", "Media provenance requires at least one source");
    const publisher = String(source.publisher || "").trim();
    const datasetTitle = String(source.datasetTitle || "").trim();
    const license = String(source.licenseId || source.licenseName || "").trim();
    if (!publisher || !datasetTitle || !license) {
      fail(
        "incomplete_media_source",
        "Publisher, dataset and licence are required for the visible media badge",
        { sourceId: source.sourceId || null },
      );
    }
    return Object.freeze({ source, publisher, datasetTitle, license });
  }

  function sourceLabel(manifest, sourceManifestSha256) {
    if (!manifest || typeof manifest !== "object") {
      fail("invalid_media_manifest", "A SourceManifest object is required");
    }
    if (!validHash(sourceManifestSha256)) {
      fail("invalid_media_manifest_hash", "A canonical SourceManifest SHA-256 is required");
    }
    const source = sourceRecord(manifest);
    return [
      `Quelle: ${source.publisher} – ${source.datasetTitle}`,
      `Lizenz: ${source.license}`,
      `Manifest: ${String(sourceManifestSha256).slice(0, 12)}`,
    ].join(" · ");
  }

  function snapshotParts(snapshot) {
    const manifest = snapshot && snapshot.manifest;
    const sourceManifestSha256 = snapshot && snapshot.sourceManifestSha256;
    const label = sourceLabel(manifest, sourceManifestSha256);
    return { manifest, sourceManifestSha256, label };
  }

  function rgb(value) {
    return `rgb(${value.join(", ")})`;
  }

  function roundedRect(rect) {
    return Object.freeze({
      x: Math.round(Number(rect.x)),
      y: Math.round(Number(rect.y)),
      width: Math.round(Number(rect.width)),
      height: Math.round(Number(rect.height)),
    });
  }

  function pageDimensions(doc) {
    const body = doc.body;
    const root = doc.documentElement;
    return {
      width: Math.max(
        root ? root.scrollWidth : 0,
        root ? root.clientWidth : 0,
        body ? body.scrollWidth : 0,
        body ? body.clientWidth : 0,
      ),
      height: Math.max(
        root ? root.scrollHeight : 0,
        root ? root.clientHeight : 0,
        body ? body.scrollHeight : 0,
        body ? body.clientHeight : 0,
      ),
    };
  }

  function createBadgeElement(doc, id, label, sourceManifestSha256) {
    doc.getElementById(id)?.remove();
    const badge = doc.createElement("div");
    badge.id = id;
    badge.dataset.mediaProvenanceBadge = "true";
    badge.dataset.sourceManifestSha256 = sourceManifestSha256;
    badge.textContent = label;
    Object.assign(badge.style, {
      zIndex: "2147483647",
      boxSizing: "border-box",
      padding: "7px 10px",
      border: `3px solid ${rgb(BORDER_COLOR)}`,
      borderRadius: "5px",
      background: rgb(BACKGROUND_COLOR),
      color: "white",
      font: "700 13px/1.25 system-ui, sans-serif",
      letterSpacing: "0.01em",
      pointerEvents: "none",
      whiteSpace: "normal",
      overflowWrap: "anywhere",
      textAlign: "left",
      visibility: "hidden",
    });
    doc.body.appendChild(badge);
    return badge;
  }

  function install(snapshot, options = {}) {
    if (typeof document === "undefined" || !document.body) {
      fail("document_unavailable", "A browser document is required to install a media provenance badge");
    }
    const { manifest, sourceManifestSha256, label } = snapshotParts(snapshot);
    const id = String(options.id || DEFAULT_ID);
    const mode = String(options.mode || "viewport");
    const inset = Math.max(0, Math.round(Number(options.inset) || 8));
    const badge = createBadgeElement(document, id, label, sourceManifestSha256);
    const viewport = { width: Number(window.innerWidth), height: Number(window.innerHeight) };
    let targetRect = null;

    if (mode === "target") {
      const selector = String(options.targetSelector || "");
      const target = selector ? document.querySelector(selector) : null;
      if (!target) {
        badge.remove();
        fail("media_badge_target_missing", `Media provenance target is unavailable: ${selector || "(empty)"}`);
      }
      targetRect = target.getBoundingClientRect();
      if (targetRect.width < MIN_TARGET_WIDTH || targetRect.height < MIN_TARGET_HEIGHT) {
        badge.remove();
        fail("media_badge_target_too_small", "Media provenance target is too small for a readable source badge", {
          selector,
          width: targetRect.width,
          height: targetRect.height,
        });
      }
      Object.assign(badge.style, {
        position: "fixed",
        left: `${Math.round(targetRect.left + inset)}px`,
        width: `${Math.max(MIN_TARGET_WIDTH, Math.round(targetRect.width - inset * 2))}px`,
        maxHeight: `${Math.max(32, Math.round(targetRect.height - inset * 2))}px`,
      });
      const measured = badge.getBoundingClientRect();
      badge.style.top = `${Math.round(targetRect.bottom - measured.height - inset)}px`;
    } else if (mode === "document") {
      const dimensions = pageDimensions(document);
      Object.assign(badge.style, {
        position: "absolute",
        left: `${inset}px`,
        width: `${Math.max(MIN_TARGET_WIDTH, dimensions.width - inset * 2)}px`,
      });
      const measured = badge.getBoundingClientRect();
      badge.style.top = `${Math.max(inset, dimensions.height - measured.height - inset)}px`;
    } else if (mode === "viewport") {
      Object.assign(badge.style, {
        position: "fixed",
        left: `${inset}px`,
        width: `${Math.max(MIN_TARGET_WIDTH, viewport.width - inset * 2)}px`,
        bottom: `${inset}px`,
      });
    } else {
      badge.remove();
      fail("unsupported_media_badge_mode", `Unsupported media provenance badge mode: ${mode}`);
    }

    badge.style.visibility = "visible";
    const badgeRect = badge.getBoundingClientRect();
    let image;
    if (mode === "target") {
      image = {
        width: Math.round(targetRect.width),
        height: Math.round(targetRect.height),
        rect: roundedRect({
          x: badgeRect.left - targetRect.left,
          y: badgeRect.top - targetRect.top,
          width: badgeRect.width,
          height: badgeRect.height,
        }),
      };
    } else if (mode === "document") {
      const dimensions = pageDimensions(document);
      image = {
        width: dimensions.width,
        height: dimensions.height,
        rect: roundedRect({
          x: badgeRect.left + window.scrollX,
          y: badgeRect.top + window.scrollY,
          width: badgeRect.width,
          height: badgeRect.height,
        }),
      };
    } else {
      image = {
        width: viewport.width,
        height: viewport.height,
        rect: roundedRect(badgeRect),
      };
    }

    const rect = image.rect;
    if (rect.x < 0 || rect.y < 0 || rect.width < MIN_TARGET_WIDTH || rect.height < 20 ||
        rect.x + rect.width > image.width + 1 || rect.y + rect.height > image.height + 1) {
      badge.remove();
      fail("media_badge_outside_capture", "Visible source badge is outside the captured image", {
        mode,
        image,
      });
    }

    return Object.freeze({
      id,
      mode,
      text: label,
      sourceManifestSha256,
      sourceId: sourceRecord(manifest).source.sourceId || null,
      borderColor: BORDER_COLOR,
      backgroundColor: BACKGROUND_COLOR,
      sourceWidth: viewport.width,
      sourceHeight: viewport.height,
      viewportRect: roundedRect(badgeRect),
      image,
    });
  }

  function remove(id = DEFAULT_ID) {
    if (typeof document === "undefined") return false;
    const badge = document.getElementById(String(id));
    if (!badge) return false;
    badge.remove();
    return true;
  }

  return Object.freeze({
    DEFAULT_ID,
    BORDER_COLOR,
    BACKGROUND_COLOR,
    MediaProvenanceBadgeError,
    sourceRecord,
    sourceLabel,
    install,
    remove,
  });
});
