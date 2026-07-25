# Renderer-wide SourceManifest gate

Status: implemented for the current PDF, DOCX, CSV, GeoJSON and KML renderers.

## Invariant

A single export context must resolve to one immutable `SourceManifest`. Every renderer may present that manifest differently, but it must preserve the same canonical manifest SHA-256.

The integration gate `tests/integration/export.rendererMatrixProvenance.test.js` creates all five final binary/text artifacts from one context and verifies:

- CSV ZIP contains the canonical manifest as `sources.json` and names its SHA-256 in `README.txt`;
- GeoJSON embeds the same manifest and hash and binds every feature to valid Source-IDs;
- KML embeds the same canonical manifest JSON, hash and Source-IDs in `Document/ExtendedData`;
- DOCX contains the manifest hash and document ID and exposes dataset, distribution and license URLs as external hyperlink relationships;
- PDF contains the manifest hash and document ID and exposes the same URLs as PDF link annotations.

The test fails when any renderer uses a separately generated manifest, loses a source, changes a URL, emits an unknown Source-ID or fails to bind the final artifact to the canonical manifest hash.

## Scope

This gate closes the renderer-consistency portion of issue #414. Provider-specific source completeness remains a separate responsibility of the provider registry and its license/provenance validators.
