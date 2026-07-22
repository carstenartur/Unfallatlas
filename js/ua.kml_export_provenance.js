/**
 * Direct KML generator for the live provenance export path.
 *
 * The legacy adapter first materialised a large KML Blob, read that Blob back
 * into a string and then materialised the final provenanced Blob. For a city
 * viewport with tens of thousands of points that doubled memory and delayed
 * the browser download. This module builds a single array of Blob parts and
 * inserts the SourceManifest metadata before the first Blob is created.
 */
(function initLiveKmlExport(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.kmlExportProvenance = api;
    if (UA.exportProvenanceRuntime && UA.artifactProvenance) api.install(UA, root);
  }
})(typeof window !== "undefined" ? window : null, function createLiveKmlExportApi() {
  "use strict";

  const SEVERITY_LABELS = Object.freeze({
    "1": "Getötet",
    "2": "Schwerverletzt",
    "3": "Leichtverletzt",
  });

  function escapeXml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function safeCity(UA, city) {
    const normalized = typeof UA?.normKey === "function"
      ? UA.normKey(city)
      : String(city || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return String(normalized || "export").replace(/^_+|_+$/g, "") || "export";
  }

  function involvementLabels(properties) {
    const props = properties || {};
    const labels = [];
    if (String(props.IstRad ?? props.istrad) === "1") labels.push("Rad");
    if (String(props.IstFuss ?? props.istfuss) === "1") labels.push("Fuß");
    if (String(props.IstPKW ?? props.istpkw) === "1") labels.push("PKW");
    if (String(props.IstKrad ?? props.istkrad) === "1") labels.push("Krad");
    if (String(props.IstGkfz ?? props.istgkfz) === "1") labels.push("Gkfz");
    if (String(props.IstSonstig ?? props.istsonstig) === "1") labels.push("Sonst.");
    return labels;
  }

  function placemark(point) {
    const props = point?.props || {};
    const year = props.year ?? "";
    const category = props.ukategorie ?? "";
    const severity = SEVERITY_LABELS[String(category)] || String(category);
    const involved = involvementLabels(props);
    const name = `${year} ${severity}${involved.length ? ` (${involved.join("+")})` : ""}`;
    return `<Placemark><name>${escapeXml(name)}</name><ExtendedData>` +
      `<Data name="year"><value>${escapeXml(year)}</value></Data>` +
      `<Data name="ukategorie"><value>${escapeXml(category)}</value></Data>` +
      `<Data name="ustunde"><value>${escapeXml(props.ustunde ?? "")}</value></Data>` +
      `<Data name="uwochentag"><value>${escapeXml(props.uwochentag ?? "")}</value></Data>` +
      `<Data name="strzustand"><value>${escapeXml(props.strzustand ?? "")}</value></Data>` +
      `</ExtendedData><Point><coordinates>${escapeXml(point.lon)},${escapeXml(point.lat)},0</coordinates></Point></Placemark>`;
  }

  function buildKmlParts(
    UA,
    ctx,
    generatedDate = new Date().toISOString().slice(0, 10),
    documentExtendedData = "",
  ) {
    if (!UA?.exportProvenance?.exportPoints) {
      throw new Error("missing_dependency: live export point selector is unavailable");
    }
    const city = String(ctx?.CITY_RAW || "");
    const points = UA.exportProvenance.exportPoints(UA, ctx);
    const parts = new Array(points.length + 2);
    parts[0] = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>${escapeXml(`Unfallatlas ${city} ${generatedDate}`)}</name>` +
      `<description>Exportierte Unfalldaten</description>${documentExtendedData}`;
    for (let index = 0; index < points.length; index += 1) {
      parts[index + 1] = placemark(points[index]);
    }
    parts[parts.length - 1] = `</Document></kml>`;
    return Object.freeze({
      parts: Object.freeze(parts),
      filename: `Unfallatlas_${safeCity(UA, city)}_${generatedDate}.kml`,
      pointCount: points.length,
    });
  }

  function buildBaseKml(UA, ctx, generatedDate = new Date().toISOString().slice(0, 10)) {
    const built = buildKmlParts(UA, ctx, generatedDate);
    return Object.freeze({
      kml: built.parts.join(""),
      filename: built.filename,
      pointCount: built.pointCount,
    });
  }

  function directDownload(root, content, filename) {
    if (!root?.URL?.createObjectURL || !root?.document?.createElement) {
      throw new Error("download_unavailable: browser Blob download APIs are unavailable");
    }
    const parts = Array.isArray(content) ? content : [content];
    const blob = new root.Blob(parts, {
      type: "application/vnd.google-earth.kml+xml;charset=utf-8",
    });
    const url = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    root.document.body.appendChild(anchor);
    anchor.click();
    root.setTimeout(() => {
      root.URL.revokeObjectURL(url);
      anchor.remove();
    }, 1000);
    return blob;
  }

  function reportFailure(UA, root, error) {
    root?.console?.error?.("KML-Export mit Quellenprovenienz fehlgeschlagen", error);
    if (typeof UA?.showToast === "function") {
      UA.showToast("KML-Export abgebrochen: vollständige Quellenprovenienz konnte nicht erzeugt werden.");
    }
    if (typeof root?.CustomEvent === "function" && root?.dispatchEvent) {
      root.dispatchEvent(new root.CustomEvent("unfallwerkbank:export-error", {
        detail: { code: error?.code || "kml_export_failed", message: error?.message || String(error) },
      }));
    }
  }

  function install(UA, root) {
    const createManifest = UA?.exportProvenanceRuntime?.createManifest;
    const buildKmlExtendedData = UA?.artifactProvenance?.buildKmlExtendedData;
    if (typeof createManifest !== "function" || typeof buildKmlExtendedData !== "function") {
      throw new Error("missing_dependency: live SourceManifest KML dependencies are unavailable");
    }
    if (UA.__directKmlProvenanceInstalled) return UA.directKmlProvenanceRuntime;

    UA.exportToKML = async function exportKmlDirectlyWithProvenance(ctx) {
      try {
        const manifest = await createManifest(ctx, { UA, root });
        const extended = await buildKmlExtendedData(manifest);
        const built = buildKmlParts(UA, ctx, undefined, extended.xml);
        directDownload(root, built.parts, built.filename);
        return Object.freeze({
          filename: built.filename,
          pointCount: built.pointCount,
          manifest,
          sourceManifestSha256: extended.sourceManifestSha256,
        });
      } catch (error) {
        reportFailure(UA, root, error);
        throw error;
      }
    };

    UA.__directKmlProvenanceInstalled = true;
    UA.directKmlProvenanceRuntime = Object.freeze({ buildBaseKml, buildKmlParts, directDownload });
    return UA.directKmlProvenanceRuntime;
  }

  return Object.freeze({
    escapeXml,
    involvementLabels,
    placemark,
    buildKmlParts,
    buildBaseKml,
    directDownload,
    install,
  });
});
