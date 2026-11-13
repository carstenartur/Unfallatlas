# Third-party browser dependencies

## Council-document workspace design reference

The RIS workspace uses the coordinated map, list and record-detail interaction and
per-record process line in
[Ratsatlas Bonn](https://github.com/daimpad/ratsatlas-bonn/tree/52fe9cad6d66ad9dc5df96deb645b175f5543cac)
by Damian Paderta as its design reference, notably `site/app.js` (panel handling,
`select` and `stepHtml`) and `site/style.css` at
commit `52fe9cad6d66ad9dc5df96deb645b175f5543cac`.
The earlier process-line implementation referenced commit
`bcefc9e9e5931689ba10da55ebe56c92f01761d6`.
The renderer and its catalogue integration are implemented independently here for
bounded cross-city data and linked source levels; no Bonn-specific committees,
procedural phases or legal assumptions are imported.
The upstream project uses the MIT License, copyright © 2026 Damian Paderta;
its [complete license notice](licenses/ratsatlas-bonn-MIT.txt) is retained with
this attribution. This design reference does not add a runtime vendor dependency
or alter the locked browser-library provenance described below.

## Locked browser libraries

The canonical site build obtains browser libraries from the exact top-level
versions in `package-lock.json`. It writes three mutually bound, deterministic
records below `_site/vendor/` and records their SHA-256 digests in
`build-manifest.json`:

- `third-party-notices.json` contains delivered-asset hashes, detected
  component purls, package-lock integrity values, available license evidence
  and decoded font metadata;
- `sbom.cdx.json` is a CycloneDX 1.6 diagnostic inventory whose composition is
  explicitly `incomplete`;
- `provenance-policy.json` is the checked-in, machine-readable decision record
  for every remaining gap and its migration options.

The inventory reports `complete: false`. GitHub Pages checks the delivered
files, known component evidence and declared gaps while serving the browser
features. The optional `--require-complete` check for strictly attested release builds
requires the remaining component and font evidence and two trusted independent
build attestations. [Tracking issue #406](https://github.com/carstenartur/Unfallatlas/issues/406)

The validator does not trust the `complete` boolean by itself. A complete claim
also requires an integrity-pinned reproducible vendor-build lock, an exact
asset-to-component `contains` relation, full hashed license and copyright
evidence, four source-bound font records and one exact `complete` CycloneDX
composition. Unknown detected bundle components or a mismatch between the
notice, policy and SBOM are release-blocking.
Even while the inventory is incomplete, validation re-hashes every delivered
vendor asset and every declared component/font license file inside the site
artifact. Missing files, hash drift, path traversal and symbolic-link escapes
are rejected before the completeness gate is evaluated.
The same diagnostic check compares the complete known SBOM projection—component
refs, asset/font hashes, exact assemblies, dependency edges, gap properties and
unresolved detections—against the notice. In particular,
`pdfmake-fonts.js` contains all four emitted `urn:unfallatlas:font:*` records;
the missing source/OFL attestation remains an explicit gap rather than an
orphaned known component.

| Package | SPDX license | Evidence included in the site artifact |
|---|---|---|
| `leaflet` | BSD-2-Clause | Complete package license text |
| `leaflet.markercluster` | MIT | Complete package license text |
| `leaflet.heat` | BSD-2-Clause | Complete package license text |
| `simpleheat` (bundled by `leaflet.heat`) | BSD-2-Clause | Complete locked package license text |
| `leaflet-draw` | MIT | Complete upstream license text checked into the repository |
| `leaflet-image` | BSD-2-Clause | Complete upstream license text checked into the repository |
| `docx` | MIT | Complete package license text |
| `pdfmake` | MIT | Complete package license text |
| `file-saver` | MIT | Complete package license text |

The build copies the full direct-package license texts to `vendor/licenses/`
and records their paths and SHA-256 digests. For `leaflet-draw` and
`leaflet-image`, the source is the upstream license text retained in
`licenses/vendor/`.

The build verifies three DOCX module paths against the exact, reproduced IIFE
and the supplier lock. It publishes `fflate@0.8.3`, `nanoid@6.0.2` and their
complete MIT notices. The DOCX notice also lists nine generated modules from
the pinned Rolldown and Oxc runtimes, including Oxc’s Babel attribution.
The PDF source map and PDF build lock identify 27
embedded npm packages, including the remapped `xmldoc` module. The PDF asset
also contains the modified SVG-to-PDFKit source file, which has a stable
CycloneDX reference and pinned source and MIT license hashes. `png-js@2.0.0`
has an MIT license file in its npm archive. The distribution pins that file
and records the SPDX expression even though the package metadata omits it.

Six `brotli@1.3.3` decoder files in the PDF bundle carry the 2013 Google Inc.
copyright and Apache-2.0 header. The site build compares their PDF source-map
contents byte-for-byte with the npm sources matching the PDF build lock.
The notice and CycloneDX list each decoder file by source path and SHA-256
and link to one shared copyright notice and complete Apache-2.0 text.
The npm package declares MIT in its metadata and ships without a license
file. The full text for that declaration and the licensing of the other
shipped Brotli files are still open.

For Leaflet.heat, the build checks the Simpleheat source embedded in the global
bundle's supplied source map against the locked Simpleheat source. The notice
and SBOM record the matching component without claiming an independent rebuild.

## Open architecture decisions

| Asset | Missing proof | Supported resolution paths |
|---|---|---|
| `vendor/export/docx.js` | Generated-code attribution and two independently signed builds | Retain bundler evidence for generated code and attest the pinned supplier build |
| `vendor/export/pdfmake.js` | Sources and data inside prebundled modules, full license evidence for the remaining Brotli files, `dfa` and `fontkit`, and two independently signed builds | Resolve each inner bundle and attest the pinned Webpack build |
| `vendor/export/pdfmake-fonts.js` | Source-to-TTF build and independent signed VFS-generator evidence | Reproduce the typeface build from the pinned release sources and attest the result |
| `vendor/leaflet.heat/leaflet-heat.js` | Independent source-build attestation for the global bundle | Rebuild Leaflet.heat and its locked Simpleheat dependency with a pinned toolchain |
| `vendor/leaflet-image/leaflet-image.js` | Source-build attestation | Rebuild with locked `d3-queue@2.0.3`, or replace map capture with a maintained implementation |

The normative version of this table is `vendor/provenance-policy.json`; this
documentation is explanatory and is not a substitute for legal review.
