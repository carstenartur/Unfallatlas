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

The full document runner also validates the original DOCX packages and repeats
the standard-report and numbered-appendix render audits after LibreOffice saves
and reopens each copy. The [compatibility report](word-compatibility-release-check.md)
binds each artifact by SHA-256. The rendered receipts keep
`microsoftWordEvidenceVerified: false` because the renderer is LibreOffice.

## Current fa545 local revision and visual coverage

The current local render source is `81f265f172f71a75130683fd4ac525cd6b5065a3`
(B2), tree `321f5a84400a6be48bed2fcec9ebb2d07e543f3c`. The equivalent remote
code object `72686d7aa24ad016caded7472fcceaa91dbdc60f` (R2) has exactly that
tree, with the previous S candidate and main `85d32225` as parents. The later
three-file documentation/inventory commit has a separate role and cannot become
the source of bytes that were already rendered. This record does not claim a
branch update, hosted acceptance, main merge, deployment or release.

The current united 18-input Word fingerprint is
`fa545bc954845c2746eeb39b33c8131b3fb8b388c1e368062e85265b2ef97dab`.
Only `js/ua.export_provenance.js` changed among those inputs since ed573:
45,197 bytes, SHA-256
`41a17363da7a717ca512a5e9868e790bcf270d2b605d7bd3ebcfc8d116c8985f`.
The reviewed fix preserves the year adapter's inherited context during export
projection. Main's additional source-acceptance limitations in
`docs/traffic-open-data-snapshots.md` are preserved byte-for-byte. All 18 Word
inputs were unchanged before/after rendering, and all 12 pinned Bonn Hbf runtime
hashes still match; the Golden fixture was not regenerated.

The complete fresh document runner passed **18 suites / 110 tests**, the ordinary
native/DOCX cases, five layouts and the complete 111-row / nine-map appendix.
Both final appendix audits have zero errors and warnings; exact rows, map pixels,
caption bindings and full embedded manifests passed again. The Word contract,
security and release-contract suites passed **3 suites / 26 tests**. All seven
ordinary source pairs passed both audits (**14/14**), with genuine pinned hourly
data and the same explicitly technical fixture boundaries.

| Current fa545 scope | Generated pages | Exact historical ed573 PNG/RGB matches | Newly viewed changed pages |
|---|---:|---:|---:|
| Ordinary DOCX converted / ordinary native PDF |5 /5|10|0|
| Numbered DOCX converted / numbered native PDF |13 /14|25|2|
| **Six candidates / four delivered PDF views** |**37**|**35**|**2**|
| Five additional layout scenarios |28|28|0|
| Seven additional ordinary source pairs |29|15|14|
| Actual production 37/312 method diagnostic, both formats |38|34|4|
| **All current page views** |**132**|**112**|**20**|

All 132 views were freshly generated. Reuse requires the individually mapped
historical ed573 receipt, verification of its actual image hash, equal dimensions,
and exact equality of decoded RGB pixels; these 112 images also match as PNG
bytes. All 20 differing pages were actually viewed individually at readable
resolution. No new clipping, overlap, illegible content or heading defect was
observed. The new receipt records the inherited 957 review chain without claiming
132 new manual inspections. Root independently also viewed the two changed final
appendix source pages. Evidence is under
`out/qa/final-document-fa545bc9-20261108/`, including
`visual-page-comparison.json`, `final-visual-review.json` and each image hash.

The first DOCX and native-PDF method pages display report date / `Exportdatum`
**9.11.2026**, versus 8.11.2026 in ed573. Text extraction confirms those are the
only first-page text changes. This is the actual displayed calendar date;
it does not assert a UTC date change or alter any source acquisition clock.
The other 18 changed pages contain regenerated provenance timestamps/proof codes.
The actual local numbered-source file read was `2026-11-08T22:59:51.370Z`;
upstream retrieval remains unknown. The current canonical SourceManifest is
`fe93cf299844a88d87406013ba33e7fe4f808f1a356bda185ea00c13f31b3f17`.

The actual B2 browser probe again preserves 37 selected / 312 complete-area cases
and the full exploratory/unadjusted method note in structured report, text,
HTML, visible preview, both server prompt modes, DOCX XML and both actual PDF
text streams. The note is on native page 2 / converted page 1; the documents have
20 /18 pages. Local HTTP development links remain unchanged, and both generic
public-HTTPS audits still reject this separate diagnostic with `unsafe_link`.
No model call or scientific/proposal approval follows from this probe.

The reviewed functional patch also has local 379-suite / 4571-test / one-snapshot
evidence, run before final cache strings, followed by 2-suite /38-test cache
checks and an actual Chromium video-fixture/context/PDF probe after those cache
changes. Those observations do not qualify a later exact hosted head. Current
local document tools remain Node 24.22.1 / npm 11.9.0 / LibreOfficeDev 26.8 /
Poppler 26.05; canonical Maven/Node 26 evidence must identify its own exact source.

Both newly bound Word templates remain incomplete: eight false checks, observed
page count 0, and placeholder actual-review date, Word/OS version and reviewer.
The unchanged validator rejects each with `invalid_date`. Real Microsoft Word,
model/scientific acceptance and publication remain absent. Historical a6, 957
and ed573 packages, their original inventories and the actual hosted S document
proof remain separately preserved; none is relabeled as this fa545 local run.

## Historical ed573 local revision and explicit visual coverage

The following observations retain their original ed573 scope and timestamps.
References to the then-current render/inventory do not qualify the fa545 bytes.


The current rerun on 8 November 2026 used actual local code
`5068989371ff95b7372f7faeb80b1e5f0940c654`, tree `c9fcd2c577ebe01c0ded66051c010404c4b3620f`.
Published code alias `c7590f399ae5f4a511f9ac67000a77c51f6aaa60` has that exact tree.
The later inventory/documentation commit is a separate role; it does not
become the source of already rendered bytes. The current united 18-file Word
renderer/decorator fingerprint is `ed5730546aa60f6449efa058f2b0980d6a8b90f98e0a3df69d70e67eb808f868`.
The candidate inventory records every repository-relative input path, size and SHA-256,
the pinned docx package, all six actual candidate hashes and acquisition clocks.
Four input files changed since957: document export provenance, export provenance,
ordinary export and report renderer. No old candidate bytes or page counts were
copied into the new evidence.

The complete repository-owned runner passed 18 suites / 110 tests, the native
ordinary PDF, ordinary DOCX, all five layout scenarios and the full 111-row /
nine-map appendix. Both appendix audits have zero errors and warnings. The
three Word contract/security/release-contract suites passed 26 tests. All seven
ordinary source cases passed both DOCX and native audits (14/14).

Every current PDF view was actually regenerated. Visual review was reused only
after exact decoded RGB pixel equality with the individually mapped historical
957 page image; all changed pages were actually viewed again. Both dimensions
and raw pixel hashes, historical/current PNG hashes, old source commit and page
position are recorded in
`out/qa/final-document-ed573054-20261108/visual-page-comparison.json`.
The final review and each current image hash are recorded in the same revision's
`final-visual-review.json`. Automated link, table and metadata gates were rerun;
pixel equality does not substitute for those semantic checks.

| Actual current scope | Generated pages | Pixel-identical historical reviews | Newly viewed changed pages |
|---|---:|---:|---:|
| Ordinary DOCX converted / ordinary native PDF |5 /5|10|0|
| Numbered DOCX converted / numbered native PDF |13 /14|25|2|
| **Six candidates / four delivered PDF views** |**37**|**35**|**2**|
| Five additional layout scenarios |28|28|0|
| Seven additional ordinary source pairs |29|15|14|
| Actual production37/312 method diagnostic, both formats |38|36|2|
| **All current page views** |**132**|**114**|**18**|

The old 132-page visual record qualifies 957/552 only. Its 114 pixel-identical
page reviews are reused through the explicit comparisons above; the new stand
is not labeled as 132 newly inspected pages. The older 32-page record omitted
ordinary native PDF and remains a limited historical observation. Both previous
957 and a6 packages remain unchanged in separate paths.

The unchanged short source cases cover zero count, original value 18,504,
genuine pinned Düsseldorf hourly bicycle data, model, old measurement, proxy
and DGM fixture. Fixture-only counts/model/DGM values are technical rendering
probes, not new scientific observations, provider activation or a road/OSM match.
The hourly case retains one bicycle/hour, original direction and period,
separate station distribution, separate licenses and unknown matching/accuracy.
Full raw URLs, SHA fingerprints and attribution remain in manifests; visible
projection uses concise clickable labels and short proof codes. The direction
is visibly “A nach B” while raw “A→B” remains unchanged. The prior source-heading,
long-URL/hash spill and unsupported glyph corrections remain visually covered.

The reviewed snapshot corrections freeze the active context before asynchronous
export work, bind source hashes per road-profile identity and retain the first
manifest's facts when a second manifest is created on the same context. Existing
prose-label normalization also applies to document subjects. Regression tests
cover these behaviors; no road association, current source clock or model receipt
is inferred from them.

Current numbered-source acquisition: `2026-11-08T22:08:44.951Z`, a real local file read.
Original upstream retrieval remains unknown. Canonical SourceManifest:
`971085a5d098c9f0e3767f73fa4916bf56dca63c0f379f64ce3568736a7d4f94`.
A fresh local render clock does not establish fresh source data.

## Historical ed573 method qualification

The numbered 111-case appendix makes no pattern comparison. A fresh local browser
probe on this exact current code/fingerprint used `UA.computeExportReport` with
the installed AnalysisScope and political-reference wrappers on the real 37/312
Bonn Hbf selection. It retained the exact exploratory/unadjusted/no-multiplicity-
correction note in `methodikScope.lines`, `limitations`, text, HTML, visible
preview and both actual server prompt modes. It waited for the real visible
note; no method text was inserted and no model was called. Bound built JS files
were compared byte-for-byte with the current source before launching Chromium.

Actual browser DOCX/PDF downloads retain the exact note in DOCX XML and text of
both native and LibreOffice-converted PDFs. The actual counts remain 20 native
and 18 converted pages, with the note on native page 2 / converted page 1.
Of these 38 current views, 36 are pixel-identical to957 and two source-proof pages
were newly inspected. Application-heading and native heatmap pagination remain
covered. Actual local development URLs are preserved: the unchanged generic
public-HTTPS adapters reject both exports with `unsafe_link`. These are method
preservation diagnostics, not generic-audit-passing filing documents or Word,
model or scientific approval.

An independent fresh checkout of reviewed runtime commit
`03e398692dfbfff2b6d025221de10f65bb0b8847` passed 364 suites / 4423 tests /
one snapshot, with five suites / 11 tests normally skipped. The log SHA-256 is
`29db0a5088721e3bddf15003ab71082dc03b124aa379f128a4837a89078e0aaf`.
This is local runtime evidence, not hosted exact-head acceptance for a later
inventory commit. Prior generated-build Unicode failures remain historical;
no source or gate change was needed for the clean isolated run.

Both actual manual Word receipt templates remain unreviewed: all eight checks
are false, observed page count is zero, and Word version, OS, reviewer and actual
review date are placeholders. The unchanged validator rejects them with
`invalid_date`, as intended. Local Node 24.22.1 / npm 11.9.0 / LibreOfficeDev 26.8 /
Poppler 26.05 does not claim canonical Maven/Node 26 acceptance. Hosted final-head
CI, real Word review, model/scientific approval and publication remain separate.
