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
