# Static map export with complete provenance

The workbench can export the currently visible, fully rendered map as a portable ZIP package. The export is deliberately not offered as a standalone PNG because a detached image would otherwise lose its source, licence, filter and data-version context.

## Package contents

A successful export contains exactly three entries:

- `<artifact>.png` – the captured map with a permanently visible source strip;
- `<artifact>.png.sources.json` – the complete, versioned `SourceManifest`, the exact PNG SHA-256 and the manifest SHA-256;
- `README.txt` – a human-readable file inventory, all three relevant hashes and linked source/licence details.

The package itself is generated with the deterministic stored-ZIP writer already used by the CSV export. The ZIP hash is returned by the programmatic API for tests and downstream integrations.

## Visible source strip

The source strip is rendered into the final PNG pixels, below the captured map. It contains:

- a compact source and licence notice derived from the same `SourceManifest` as the sidecar;
- the `SourceManifest` SHA-256, so the visible image can be matched to its complete machine-readable record.

The renderer verifies independent border and background witness pixels before accepting the image. If the strip cannot be rendered or verified, no package is downloaded.

## Consistency and fail-closed behaviour

The live export performs these steps:

1. build and validate the shared live `SourceManifest`;
2. wait for the map, tiles and owned layers through `UA.captureExportMapImage`;
3. capture the final PNG;
4. rebuild the manifest and compare the canonical hashes;
5. abort if filters, bounds, data, city or build state changed during capture;
6. append and verify the visible source strip;
7. hash the final PNG and bind that hash into the sidecar;
8. create the ZIP and trigger the single package download.

A malformed data URL, non-PNG renderer result, unsafe filename, notice mismatch, changed scenario, unavailable provenance runtime or missing map-capture capability fails closed.

## User interface and distribution profiles

The module inserts **Karte + Quellen (ZIP)** in the export dialog only when all required capabilities are available:

- `leaflet-image` is present;
- the readiness-checked workbench map capture is present;
- the common live `SourceManifest` runtime is ready.

The reduced GitHub Pages preview intentionally removes `leaflet-image`; therefore the button is not shown there. The full canonical and Docker distributions expose it without requiring a separate HTML-specific source string or export implementation.

## Programmatic API

The browser runtime exposes:

```js
const result = await window.UA.exportMapPngPackage(
  window.UA.getRuntimeContext(),
  { download: false },
);
```

The result includes the package bytes and filename, the PNG/sidecar/package hashes, the normalized manifest and the exact visible notice. Omitting `download: false` downloads the ZIP.

## QA

Focused unit coverage verifies:

- PNG signature and data-URL validation;
- deterministic ZIP entry names and contents;
- exact PNG-to-sidecar hash binding;
- identical visible notice in pixels and sidecar;
- linked source/licence details in `README.txt`;
- source-strip rendering and pixel witnesses;
- stable pre-/post-capture manifest snapshots;
- fail-closed rejection when map state changes during capture;
- ordered runtime loading after the common document/data provenance modules.

This implementation completes the static PNG/screenshot slice of issue #414. Provider-wide provenance and the renderer-wide golden matrix remain tracked by that epic.
