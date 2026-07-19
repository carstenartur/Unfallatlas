# Third-party browser dependencies

The canonical site build obtains browser libraries from the exact top-level
versions in `package-lock.json`. It writes a machine-readable top-level inventory to
`vendor/third-party-notices.json` inside `_site/` and records that inventory's
SHA-256 digest in `build-manifest.json`.

> **Release blocker:** this inventory is deliberately marked
> `complete: false`. The prebuilt Docx/Pdfmake files contain components whose
> exact build versions cannot be reproduced from this project's lockfile, and
> `pdfmake-fonts.js` embeds four Roboto font binaries. Issue
> [#406](https://github.com/carstenartur/Unfallatlas/issues/406) tracks the
> reproducible vendor build, component-level SBOM and complete license/font
> evidence. Pages and release workflows fail closed while that issue remains
> unresolved; this file must not be presented as a complete SBOM.

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
redistribution evidence. The inventory covers only the direct npm packages,
not components embedded in their prebuilt bundles, and is not a substitute for
legal review of a release.
