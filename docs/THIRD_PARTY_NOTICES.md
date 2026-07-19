# Third-party browser dependencies

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

> **Release blocker:** this inventory is deliberately marked
> `complete: false`. The prebuilt Docx/Pdfmake files contain components whose
> exact build versions cannot be reproduced from this project's lockfile, and
> `pdfmake-fonts.js` embeds four Roboto font binaries. Issue
> [#406](https://github.com/carstenartur/Unfallatlas/issues/406) tracks the
> reproducible vendor build, component-level SBOM and complete license/font
> evidence. Pages and release workflows fail closed while that issue remains
> unresolved; the diagnostic CycloneDX file must not be presented as a
> complete SBOM.

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
| `leaflet-draw` | MIT | License declaration from installed `package.json` |
| `leaflet-image` | BSD-2-Clause | License declaration from installed `package.json` |
| `docx` | MIT | Complete package license text |
| `pdfmake` | MIT | Complete package license text |
| `file-saver` | MIT | Complete package license text |

Where the published npm archive contains a license file, the build copies its
unmodified contents to `vendor/licenses/` and records both path and SHA-256.
The published `leaflet-draw` and `leaflet-image` archives used here do not
contain a top-level license text; their installed package metadata is preserved
as explicit `installed-package-metadata` evidence instead of silently implying
that a text was bundled. That metadata is diagnostic only and not sufficient
redistribution evidence.

The build additionally discovers package paths in the Docx bundle and the
Pdfmake source map, maps resolvable names to exact package-lock purls, and emits
the available package license files. This is deliberately an over-documented
diagnostic inventory, not proof that the supplier bundles were built from this
project's dependency tree. The unresolved names remain attached to the exact
asset assessment.

## Open architecture decisions

| Asset | Missing proof | Supported resolution paths |
|---|---|---|
| `vendor/export/docx.js` | Pinned build-tool lock, reproducible source build, complete contains/licenses | Source-build a browser entry with retained metafile/source map, or preserve the DOCX contract behind a separately maintained export service |
| `vendor/export/pdfmake.js` | Reproducible webpack build including `svg-to-pdfkit`, complete source-map inventory/licenses | Rebuild from a dedicated locked workspace, or replace it with a source-buildable renderer that passes the PDF render gate |
| `vendor/export/pdfmake-fonts.js` | Integrity-pinned font source, OFL/copyright file, deterministic VFS generator | Pin the Roboto source and generate VFS locally, or use another checked-in OFL family |
| `vendor/leaflet.heat/leaflet-heat.js` | Locked `simpleheat@0.2.0` source/build/license | Pin and source-build the pair, or deliver separate locked modules |
| `vendor/leaflet-image/leaflet-image.js` | Source-build attestation plus complete leaflet-image license evidence | Rebuild with locked `d3-queue@2.0.3`, or replace map capture with a maintained implementation |
| Leaflet Draw assets | Exact full upstream MIT/copyright file | Vendor the exact upstream evidence, or upgrade to an archive that ships it |

The normative version of this table is `vendor/provenance-policy.json`; this
documentation is explanatory and is not a substitute for legal review.
