# DOCX compatibility release check

The `document-render` Maven profile runs automated DOCX compatibility QA on the
standard report and the numbered appendix. Both release modes run the same
gate before any remote repository write. Run it locally with LibreOffice Writer,
Poppler and the repository's locked npm dependencies installed.

```bash
npm run qa:document-render
```

The gate performs the following checks for both candidates.

- Reads the original ZIP and validates entry integrity, XML well-formedness,
  OPC content types, relationship targets and references, and the
  WordprocessingML document body.
- Uses LibreOffice Writer to save a separate DOCX copy using the Office Open
  XML Text filter. Reopens the saved copy and renders it to PDF. A reported
  repair or format error fails the check.
- Compares paragraph and table cell text, repeated header and row-splitting
  settings, heading keep-with-next, page sizes, hyperlink targets, and the
  embedded image bytes, display dimensions, and accessibility titles and descriptions.
- Repeats the final-page audits with Poppler. The standard report checks table
  rows and the placement of the `Top-Abweichungen` heading. The numbered
  appendix checks its embedded source manifest, the actual maps and captions,
  all accident table rows, and repeated continuation headers. Both checks
  verify page counts, orientation, and rendered link targets. The table rows
  may move between pages when each rendered table still passes its contract.

`out/qa/docx-compatibility/report.json` records the checkout, renderer input
fingerprint, library and LibreOffice versions, and SHA-256 hashes of both
originals, saved copies, and PDFs. The release and document CI artifacts include
the report, the saved copies, and the reopened render evidence. The evidence
identifies LibreOffice as the renderer and keeps
`microsoftWordEvidenceVerified: false`.

## Optional desktop Microsoft Word evidence

The receipt tools remain available to record an observed result from desktop
Microsoft Word for Windows or macOS when that environment is available. These
receipts describe a separate inspection and are optional for publication.

### What the desktop receipt is bound to

The validator does **not** compare the raw DOCX hash with a newly generated file. DOCX is a ZIP container and may contain runtime metadata that changes without changing the visible document.

Instead, `config/word-compatibility-inputs.json` defines the compatibility input set:

- the production report renderer, export orchestration and generated shared template defaults;
- export and artifact provenance projection/hash dependencies;
- document provenance and prewarm logic;
- source-link and pagination adapters;
- accident-year and SourceManifest boundaries;
- the DOCX Golden generators, the scenario definitions, drawing and palette inputs, and the Bonn accident data used by the numbered appendix;
- the final rendered-document Golden contract;
- the exact integrity-pinned `docx` package version.

`scripts/validate-word-compatibility-evidence.js` hashes those inputs deterministically. Any relevant renderer, contract or library change creates a new fingerprint and invalidates older manual evidence.

The earlier 2.1.4 sample and numbered-appendix candidates, hashes and
LibreOffice reference page counts are recorded in
[the release preparation](releases/2.1.4-preparation.md) and its
[machine-readable candidate inventory](release-evidence/2.1.4-document-candidate.json).
These records are not Microsoft Word receipts.

The receipt still records the SHA-256 of the exact DOCX opened in Word for traceability. That artifact hash is evidence of what was tested; the input fingerprint decides whether the evidence is still applicable.

### Creating a candidate and desktop receipt

Run the **Release Workflow** with `dry_run: true` to generate the candidates. Download `release-acceptance-evidence` and use these files from the archive:

| Document ID | DOCX | LibreOffice page reference | Receipt to commit |
|---|---|---|---|
| `ci-docx-sample` | `out/qa/rendered-document/docx/source.docx` | `out/qa/rendered-document/docx/converted.pdf` | `docs/release-evidence/word-compatibility.json` |
| `release-numbered-docx` | `out/qa/release-document/appendix.docx` | `out/qa/release-document/docx/converted.pdf` | `docs/release-evidence/word-compatibility-appendix.json` |

Prepare two prefilled JSON forms in `out/qa/word-review/` from a local checkout
after rendering the candidates:

```bash
npm run validate:word-compatibility -- --prepare-review "$(git rev-parse HEAD)"
```

Each form carries the renderer fingerprint, exact candidate commit, DOCX size
and SHA-256 for its corresponding file. Keep the downloaded DOCX as the
original and use a copy for the save-and-reopen check.

Open each file in desktop Microsoft Word and complete its own form. Enter the
inspection time, Word version/build, operating system, reviewer, observed
page count and the results below. Copy the completed forms to the receipt paths
in the table. The generated forms have an empty inspection time and every
observation starts as `false`.

Use the commit that actually produced the two DOCX files. For a release
candidate it is `release_commit` in `out/qa/release-acceptance-contract.txt`.

### Desktop receipt checks

The receipt accepts only explicit `true` values for all checks:

1. **`openedWithoutRepairWarning`** – Word opens the document without repair, corruption or unreadable-content warnings.
2. **`savedAndReopenedWithoutRepairWarning`** – save a copy from Word, close it and reopen it without repair warnings.
3. **`pageCountMatchesGolden`** – page count and major section order agree with the current reviewed LibreOffice Golden evidence. Minor line wrapping may differ only when it creates no semantic or layout defect.
4. **`mapsUndistorted`** – maps in the reviewed document preserve their aspect ratio, labels and accident markers.
5. **`tablesReadableAndNotClipped`** – all tables in the reviewed document are complete and their edges, headers and wrapped cells are legible.
6. **`topDeviationsHeadingKeptWithTable`** (standard report) – the `Top-Abweichungen` heading, complete table header and first data row remain together.
7. **`hyperlinksClickable`** – dataset, licence and other required external links are clickable and target the expected HTTPS URLs.
8. **`noMissingGlyphs`** – no placeholder boxes, missing symbols, broken dashes, multiplication signs or font substitutions make content ambiguous.

For the numbered appendix, check these three items in place of `topDeviationsHeadingKeptWithTable`:

- **`numberedMapLabelsReadable`** – the overview shows distinct markers, the correct total and a readable legend. The detail maps show legible accident IDs beside the corresponding markers.
- **`landscapePagesPreserved`** – the landscape pages retain their orientation and content fits within the page.
- **`repeatedTableHeadersAndPageBreaksCorrect`** – continuation pages repeat the table header and preserve readable rows at page breaks.

Also record:

- date and time of the completed inspection, replacing the template timestamp;
- exact Word version/build;
- Windows or macOS version;
- reviewer GitHub login;
- exact source commit;
- exact DOCX SHA-256 and byte size;
- observed page count;
- notes for any benign renderer difference.

### Local validation

After completing the receipt:

```bash
npm run validate:word-compatibility -- \
  --evidence docs/release-evidence/word-compatibility.json \
  --max-age-days 30 \
  --report out/qa/word-compatibility-report.json
npm run validate:word-compatibility -- \
  --document-id release-numbered-docx \
  --evidence docs/release-evidence/word-compatibility-appendix.json \
  --max-age-days 30 \
  --report out/qa/word-compatibility-appendix-report.json
```

The command fails closed when:

- the renderer/input fingerprint changed;
- the receipt is older than the configured limit;
- the timestamp is implausibly in the future;
- a required field or manual check is missing;
- the artifact, commit, reviewer or environment metadata is malformed;
- extra undeclared fields try to bypass the fixed schema.

### GitHub Actions validation

Run **Actions → Microsoft Word Compatibility Evidence** on the exact release-candidate branch or tag.

Use:

- `evidence_path`: the committed receipt, normally `docs/release-evidence/word-compatibility.json`;
- `max_age_days`: normally `30`.

Repeat the validation with `docs/release-evidence/word-compatibility-appendix.json` for the appendix. Each run checks out the selected candidate, recomputes its fingerprint, validates the receipt and uploads `word-compatibility-report.json` for release review.

The example file at `docs/release-evidence/word-compatibility.example.json` is
intentionally incomplete and can never pass validation.

### When desktop evidence must be repeated

Repeat the Word check whenever:

- the input fingerprint changes;
- the prior evidence expires;
- Word or the operating system is upgraded in a way that can affect rendering;
- the automated LibreOffice Golden artifact changes page count or layout materially;
- a release reviewer observes a discrepancy not represented by the existing checks.

Never copy a prior fingerprint into a new receipt without opening and checking the newly generated candidate in Word.
