# Source-bound numbered-appendix release QA

`npm run qa:document-render` retains the existing native-PDF smoke and five
DOCX layout scenarios, then runs the stricter release acceptance case in
`scripts/qa-numbered-appendix-rendered.js`. The five layout scenarios alone do
not prove complete numbered appendix rows or source metadata.

The release case reads every published Bonn accident within the fixed bounds
50.730–50.732 N, 7.091–7.101 E from the checked-in compressed GeoJSON. It does not
truncate the area population. The current source contains 111 cases, of which
15 match the Rad + Pkw discovery filter. The complete population is numbered
through the production cohort adapter and exported through its real PDF,
DOCX, CSV and GeoJSON implementations. The production document provenance
adapter supplies the common source manifest and binary metadata. Each generation
records one real local file-read acquisition timestamp for the input bytes. Its
source quality note distinguishes that local `retrievedAt` from the unknown
original upstream retrieval time; the acquisition record and input hash are
frozen into the common manifest used by both document formats. File mtime is
not used as verification.

All maps say **deterministic test basemap — no live tiles**. Background roads
are illustrative, while accident coordinates and published attributes are real.
Overview and detail maps bind exact A### IDs, bounds, source snapshot hash,
severity colors from the production palette, PNG hash and decoded-pixel hash.
Labels use displaced positions and leader lines; their boxes avoid each other
and the markers. Each detail partition contains at most 18 cases. The existing
five layout scenarios also use distinct overview, selection, detail and cluster
fixture images and write `<document>.maps.json` receipts.

The release audit independently checks the output artifacts:

- extracts and rehashes the embedded full source manifest from native PDF
  metadata and DOCX custom properties, then compares it with the release hash;
- binds the converted PDF to the validated input DOCX through the existing
  LibreOffice conversion receipt;
- extracts each final image through Poppler and compares decoded pixels with
  the expected role/subset receipt;
- reconstructs the positioned caption text directly below each pixel-verified
  map on the same page, checking its figure number and role plus the native
  overview population count or the exact ID list in detail/Word captions;
- locates actual final table headers and reconstructs all eight cells of every
  accident row, including wrapped cells, exact A### IDs and continuation headers;
- compares exact ID sets against the saved CSV, GeoJSON, overview and disjoint
  detail partitions, rejecting missing, duplicate or extra IDs;
- requires real table pagination in both native PDF and DOCX-converted PDF;
- applies the existing page, bounds, text, map, link and table audit to both;
- renders every page to PNG and checks the independent page counts.

The release contract requires an observed source manifest hash; copying the
expected value from the contract into the page model is not evidence. Generic
layout smoke contracts can remain without this requirement. A passing release
receipt is removed before regeneration and written only after all final gates
pass.

`out/qa/release-document/` contains the PDF, DOCX, converted PDF, numbered CSV and
GeoJSON, CSV source ZIP, source manifest, cohort snapshot, role receipts,
reconstructed page models, page PNGs and `release-evidence.json`. The receipt
records hashes, the local acquisition record, actual page/row/header counts,
map pixel bindings and observed caption text/bounds. Caption checks establish
those visible strings and adjacency; they do not establish every aspect of
caption typography or general production caption layout. The
rendered-document CI workflow uploads this directory with its existing evidence.

The strict case can be run alone with:

```bash
node scripts/qa-numbered-appendix-rendered.js
```

Microsoft Word remains an external review gate. The receipt explicitly keeps
`microsoftWordEvidenceVerified: false`; no LibreOffice result or synthetic map
fixture substitutes for a current, fingerprint-matching real Word review.

## Final local candidate and explicit visual scope

The final local rerun on 8 November 2026 used `5520125e59c1d1d2df40df55eea3e6b27a1f42a3`, tree
`6d31c3c75511813be9d760f24c75896d3477b941`. Published code commit `f88cbb45bacc378fa1e53315757e1d115a122351` has exactly the
same tree. These are separate commit roles; the subsequent inventory and
release-documentation commit does not become the source of already rendered
binary bytes. The current united 18-file Word renderer/decorator fingerprint is
`957e0bedb207fa17ee3da26adf636d13252f3e15c793bf968392a4cd4be602d6`. The candidate inventory records every input path, size and SHA-256,
the pinned docx package, all six exact candidate hashes and acquisition clocks.

The complete runner passed 18 suites / 110 tests, the native ordinary PDF,
ordinary DOCX, five layout scenarios and the full 111-row / nine-map appendix.
Both appendix audits have zero errors and warnings. All actual delivered PDF
views were visually inspected, including the ordinary native PDF:

| Scope | Actual pages visually inspected |
|---|---:|
| Ordinary DOCX converted with LibreOffice | 5 |
| Ordinary native PDF | 5 |
| Numbered DOCX converted with LibreOffice | 13 |
| Numbered native PDF | 14 |
| **Six candidate files / four PDF views** | **37** |
| Five additional layout scenarios | 28 |
| Seven additional ordinary source cases, both formats | 29 |
| Actual production 37/312 method diagnostic, both formats | 38 |
| **All distinct page views in this local review** | **132** |

The historical 32-page record covered only ordinary DOCX plus the two appendix
views. It did not include the ordinary native PDF and is not presented as an
all-candidate review. The current review binds every page image to its actual
hash in `out/qa/final-document-20261108/final-visual-review.json`.

The unchanged short source-bound cases cover zero count, original value 18,504,
genuine pinned Düsseldorf hourly bicycle data, model, old measurement, proxy
and DGM fixture. All 14 DOCX/native audits pass. These are technical rendering
probes; fixture-only counts/model/DGM values do not create new scientific
observations, source activation or a road/OSM match. The hourly case keeps the
original one bicycle/hour, direction, period, separate station distribution,
licenses and unknown matching/accuracy facts. Raw full URLs, fingerprints and
attribution remain in the manifests; the visible projection uses labeled links
and short proof codes. Native direction labels read “A nach B” while the raw
original “A→B” remains unchanged. The previously observed source-heading orphan,
raw station URL/hash spill and unsupported decorative arrow are corrected;
no page/link/audit gate was relaxed. Default document subjects are neutral,
and explicitly supplied subjects are retained.

The current local numbered-source acquisition is `2026-11-08T21:31:53.892Z`, a real local file
read. Original upstream retrieval remains unknown. Its canonical SourceManifest
hash is `5d0cc2cfef9e404ad35418c556f1ccfc72e5ebd741a9c902b2b657dace3e5a56`. A fresh render clock does not establish fresh source data.

## Method qualification is a separate production report check

The numbered appendix has no pattern comparison. Its complete rows and map
receipts therefore cannot establish that exploratory statistical qualifications
survive the ordinary report pipeline. On the same final source/fingerprint,
a separate actual browser check used `UA.computeExportReport` with installed
AnalysisScope and political-reference wrappers on the real 37/312 Bonn Hbf
selection. It retained the exact exploratory / unadjusted / no-multiplicity-
correction note in `methodikScope.lines` and `limitations`, text, HTML, visible
preview and both actual server prompt modes. The browser waited for the real
visible note; no method text was manually inserted and no model was called.

Actual browser DOCX/PDF downloads retain the note in DOCX XML, native PDF text
and LibreOffice-converted PDF text. All 20 native and 18 converted pages were
visually inspected; the exact note is readable on native page 2 and converted
DOCX page 1. The DOCX application heading now stays with its body on page 2;
the native heatmap heading, header and first data row stay together on page 19.
These exports use the actual local development URL, so the unchanged public-
HTTPS link adapter rejects both with `unsafe_link`. They are additional method
preservation evidence, not generic-audit-passing filing documents, live-map,
model, scientific or Microsoft Word approval.

The 3 Word evidence/security/release-contract suites pass 26 tests. Their
synthetic passing receipts are not actual Microsoft Word evidence. Both actual
manual receipt templates remain unreviewed: all eight checks are false,
observed page count is zero, and Word version, OS, reviewer and actual review
date remain placeholders. Node 24.22.1 / npm 11.9.0 / LibreOfficeDev 26.8 /
Poppler 26.05 local rendering does not claim canonical Maven / Node 26 acceptance;
that must bind the subsequently published exact head independently.
