/**
 * Direct KML generator for the live provenance export path.
 *
 * The legacy adapter first materialised a large KML Blob, read that Blob back
 * into a string and then materialised the final provenanced Blob. For a city
 * viewport with tens of thousands of points that doubled memory and delayed
 * the browser download. This module keeps the same KML fields but produces the
 * base string once and injects SourceManifest provenance before the first Blob.
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

  function buildBaseKml(UA, ctx, generatedDate = new Date().toISOString().slice(0, 10)) {
    if (!UA?.exportProvenance?.exportPoints) {
      throw new Error("missing_dependency: live export point selector is unavailable");
    }
    const city = String(ctx?.CITY_RAW || "");
    const points = UA.exportProvenance.exportPoints(UA, ctx);
    const chunks = new Array(points.length);
    for (let index = 0; index < points.length; index += 1) {
      chunks[index] = placemark(points[index]);
    }
    return Object.freeze({
      kml: `<?xml version="1.0" encoding="UTF-8"?>` +
        `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
        `<name>${escapeXml(`Unfallatlas ${city} ${generatedDate}`)}</name>` +
        `<description>Exportierte Unfalldaten</description>${chunks.join("")}` +
        `</Document></kml>`,
      filename: `Unfallatlas_${safeCity(UA, city)}_${generatedDate}.kml`,
      pointCount: points.length,
    });
  }

  function directDownload(root, content, filename) {
    if (!root?.URL?.createObjectURL || !root?.document?.createElement) {
      throw new Error("download_unavailable: browser Blob download APIs are unavailable");
    }
    const blob = new root.Blob([content], {
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
    const injectProvenance = UA?.artifactProvenance?.injectKmlProvenance;
    if (typeof createManifest !== "function" || typeof injectProvenance !== "function") {
      throw new Error("missing_dependency: live SourceManifest KML dependencies are unavailable");
    }
    if (UA.__directKmlProvenanceInstalled) return UA.directKmlProvenanceRuntime;

    UA.exportToKML = async function exportKmlDirectlyWithProvenance(ctx) {
      try {
        const manifest = await createManifest(ctx, { UA, root });
        const base = buildBaseKml(UA, ctx);
        const enriched = await injectProvenance(base.kml, manifest);
        directDownload(root, enriched.kml, base.filename);
        return Object.freeze({
          filename: base.filename,
          pointCount: base.pointCount,
          manifest,
          kml: enriched.kml,
          sourceManifestSha256: enriched.sourceManifestSha256,
        });
      } catch (error) {
        reportFailure(UA, root, error);
        throw error;
      }
    };

    UA.__directKmlProvenanceInstalled = true;
    UA.directKmlProvenanceRuntime = Object.freeze({ buildBaseKml, directDownload });
    return UA.directKmlProvenanceRuntime;
  }

  return Object.freeze({
    escapeXml,
    involvementLabels,
    placemark,
    buildBaseKml,
    directDownload,
    install,
  });
});
