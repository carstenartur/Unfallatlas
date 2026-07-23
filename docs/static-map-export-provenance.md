# Static map export with complete provenance

The workbench can export the currently visible, fully rendered map as a portable ZIP package. The export is deliberately not offered as a standalone PNG because a detached image would otherwise lose its source, licence, filter and data-version context.

## Package contents

A successful export contains exactly three entries:

- `<artifact>.png` – the captured map with a permanently visible source strip;
- `<artifact>.png.sources.json` – the complete, versioned `SourceManifest`, the exact PNG SHA-256 and the manifest SHA-256;
- `README.txt` – a human-readable file inventory, all three relevant hashes and linked source/licence details.

The package itself is generated with the deterministic stored-ZIP writer already used by the CSV export. The ZIP hash is returned by the programmatic API for tests and downstream integrations.

## Renderer sources are part of the manifest

A static map uses more sources than a tabular accident export. The live accident-data manifest is therefore augmented with the source that actually supplied the rendered basemap and with a dedicated `render-static-map-png` transformation.

The first supported renderer source is the default **OpenStreetMap Standard** layer. Its ODbL licence, attribution, distribution URL, retrieval timestamp and rasterisation change notice are included in the same manifest as the accident source.

Orthophoto, hybrid and enriched context overlays are deliberately rejected until their provider definitions expose complete canonical licence/provenance records. The export must not create an apparently complete sidecar while silently omitting a visible map source. This limitation is visible in the export dialog and remains part of the provider-wide work tracked by issue #414.

## Visible source strip

The source strip is rendered into the final PNG pixels, below the captured map. It contains:

- a compact source and licence notice derived from the same `SourceManifest` as the sidecar;
- the full `SourceManifest` SHA-256, so the visible image can be matched to its complete machine-readable record.

The renderer verifies independent border and background witness pixels before accepting the image. If the strip cannot be rendered or verified, no package is downloaded. The renderer must also return the exact notice and manifest hash it rendered; either mismatch aborts packaging.

## Consistency and fail-closed behaviour

The live export performs these steps:

1. build and validate the shared live accident-data `SourceManifest`;
2. identify the active basemap and reject unmodelled renderer/context sources;
3. add the rendered basemap source and rasterisation transformation;
4. wait for the map, tiles and owned layers through `UA.captureExportMapImage`;
5. capture the final PNG;
6. rebuild the complete map manifest and compare the canonical hashes;
7. abort if filters, bounds, data, city, map sources or build state changed during capture;
8. append and verify the visible source strip;
9. hash the final PNG and bind that hash into the sidecar;
10. create the ZIP and trigger the single package download.

A malformed data URL, non-PNG renderer result, unsafe filename, visible-notice mismatch, manifest-hash mismatch, changed scenario, unsupported map/context source, unavailable provenance runtime or missing map-capture capability fails closed.

## User interface and distribution profiles

The module inserts **Karte + Quellen (ZIP)** in the export dialog only when all required capture capabilities are available:

- `leaflet-image` is present;
- the readiness-checked workbench map capture is present;
- the common live `SourceManifest` runtime is ready.

The reduced GitHub Pages preview intentionally removes `leaflet-image`; therefore the button is not shown there. The full canonical and Docker distributions expose it. The current implementation successfully exports the standard OpenStreetMap mode and explains why modes with not-yet-modelled providers are blocked rather than silently degraded.

## Programmatic API

The browser runtime exposes:

```js
const result = await window.UA.exportMapPngPackage(
  window.UA.getRuntimeContext(),
  { download: false },
);
```

The result includes the package bytes and filename, the PNG/sidecar/package hashes, the normalized map-complete manifest and the exact visible notice. Omitting `download: false` downloads the ZIP.

## QA

Focused unit coverage verifies:

- PNG signature and data-URL validation;
- deterministic ZIP entry names and contents;
- exact PNG-to-sidecar hash binding;
- identical visible notice and manifest hash in renderer output and sidecar;
- inclusion of OpenStreetMap as a rendered basemap source;
- fail-closed rejection of unmodelled orthophoto, hybrid and context sources;
- linked source/licence details in `README.txt`;
- source-strip rendering and pixel witnesses;
- stable pre-/post-capture complete manifest snapshots;
- fail-closed rejection when map state changes during capture;
- ordered runtime loading after the common document/data provenance modules.

This implementation completes the safe OpenStreetMap static PNG/screenshot slice of issue #414. Provider-wide provenance for the other map modes and the renderer-wide golden matrix remain tracked by that epic.
