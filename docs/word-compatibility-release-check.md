# Microsoft Word compatibility release check

LibreOffice and Poppler provide the automated final-page gate for every change. They do not replace a release-candidate check in Microsoft Word, because Word may paginate, repair, render fonts or interpret DOCX relationships differently.

A publication run requires recent Microsoft Word receipts for the standard report and the numbered appendix. The release workflow validates both receipts against the candidate's renderer fingerprint before it pushes the release commit or creates the tag.

## What the receipt is bound to

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

## Creating a candidate and receipt

Run the **Release Workflow** with `dry_run: true` to generate the candidates. Download `release-acceptance-evidence` and use these files from the archive:

| Document ID | DOCX | LibreOffice page reference | Receipt to commit |
|---|---|---|---|
| `ci-docx-sample` | `out/qa/rendered-document/docx/source.docx` | `out/qa/rendered-document/docx/converted.pdf` | `docs/release-evidence/word-compatibility.json` |
| `release-numbered-docx` | `out/qa/release-document/appendix.docx` | `out/qa/release-document/docx/converted.pdf` | `docs/release-evidence/word-compatibility-appendix.json` |

Record `release_commit` from `out/qa/release-acceptance-contract.txt` as the source commit in both receipts. Check out the recorded `release_base_commit` from `main` to generate both templates:

```bash
npm run validate:word-compatibility -- --print-fingerprint
npm run validate:word-compatibility -- \
  --write-template docs/release-evidence/word-compatibility.json
npm run validate:word-compatibility -- \
  --document-id release-numbered-docx \
  --write-template docs/release-evidence/word-compatibility-appendix.json
```

Record the exact artifact hash and byte size:

```bash
sha256sum out/qa/rendered-document/docx/source.docx out/qa/release-document/appendix.docx
wc -c out/qa/rendered-document/docx/source.docx out/qa/release-document/appendix.docx
```

On PowerShell, the equivalent hash command is:

```powershell
Get-FileHash out/qa/rendered-document/docx/source.docx, out/qa/release-document/appendix.docx -Algorithm SHA256
Get-Item out/qa/rendered-document/docx/source.docx, out/qa/release-document/appendix.docx | Select-Object Name, Length
```

Open both exact files in a supported desktop Microsoft Word version and record the results independently. Mark a check as passed only after observing it in Word.

## Mandatory manual checks

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

## Local validation

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

## GitHub Actions validation

Run **Actions → Microsoft Word Compatibility Evidence** on the exact release-candidate branch or tag.

Use:

- `evidence_path`: the committed receipt, normally `docs/release-evidence/word-compatibility.json`;
- `max_age_days`: normally `30`.

Repeat the validation with `docs/release-evidence/word-compatibility-appendix.json` for the appendix. Each run checks out the selected candidate, recomputes its fingerprint, validates the receipt and uploads `word-compatibility-report.json` for release review.

The real release requires both completed receipts to be committed to `main` and revalidates them with a 30-day age limit. A dry run remains available to generate new candidates for the next review. The example file at `docs/release-evidence/word-compatibility.example.json` is intentionally incomplete and can never pass validation.

## When evidence must be repeated

Repeat the Word check whenever:

- the input fingerprint changes;
- the prior evidence expires;
- Word or the operating system is upgraded in a way that can affect rendering;
- the automated LibreOffice Golden artifact changes page count or layout materially;
- a release reviewer observes a discrepancy not represented by the existing checks.

Never copy a prior fingerprint into a new receipt without opening and checking the newly generated candidate in Word.
