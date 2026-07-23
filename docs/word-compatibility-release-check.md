# Microsoft Word compatibility release check

LibreOffice and Poppler provide the automated final-page gate for every change. They do not replace a release-candidate check in Microsoft Word, because Word may paginate, repair, render fonts or interpret DOCX relationships differently.

A release is therefore not considered publication-ready until a recent, hash-bound Microsoft Word evidence receipt has passed the dedicated validation workflow.

## What the receipt is bound to

The validator does **not** compare the raw DOCX hash with a newly generated file. DOCX is a ZIP container and may contain runtime metadata that changes without changing the visible document.

Instead, `config/word-compatibility-inputs.json` defines the compatibility input set:

- the production report renderer;
- document provenance and prewarm logic;
- source-link and pagination adapters;
- accident-year and SourceManifest boundaries;
- the deterministic DOCX Golden generator;
- the final rendered-document Golden contract;
- the exact integrity-pinned `docx` package version.

`scripts/validate-word-compatibility-evidence.js` hashes those inputs deterministically. Any relevant renderer, contract or library change creates a new fingerprint and invalidates older manual evidence.

The receipt still records the SHA-256 of the exact DOCX opened in Word for traceability. That artifact hash is evidence of what was tested; the input fingerprint decides whether the evidence is still applicable.

## Creating a candidate and receipt

Start from the exact commit intended for release:

```bash
npm ci
npm run generate:sample-docx
npm run validate:word-compatibility -- --print-fingerprint
npm run validate:word-compatibility -- \
  --write-template docs/release-evidence/word-compatibility.json
```

Record the exact artifact hash and byte size:

```bash
sha256sum out/ci-render-gate.docx
wc -c out/ci-render-gate.docx
```

On PowerShell, the equivalent hash command is:

```powershell
Get-FileHash out/ci-render-gate.docx -Algorithm SHA256
```

Open that exact file in a supported desktop Microsoft Word version and complete every check below. Do not mark a check as passed based only on LibreOffice, the browser preview or OOXML inspection.

## Mandatory manual checks

The receipt accepts only explicit `true` values for all checks:

1. **`openedWithoutRepairWarning`** – Word opens the document without repair, corruption or unreadable-content warnings.
2. **`savedAndReopenedWithoutRepairWarning`** – save a copy from Word, close it and reopen it without repair warnings.
3. **`pageCountMatchesGolden`** – page count and major section order agree with the current reviewed LibreOffice Golden evidence. Minor line wrapping may differ only when it creates no semantic or layout defect.
4. **`mapsUndistorted`** – overview, selection, detail and cluster maps preserve their aspect ratio, labels and accident markers.
5. **`tablesReadableAndNotClipped`** – severity, deviation and yearly tables are complete; no right edge, header or wrapped cell is clipped.
6. **`topDeviationsHeadingKeptWithTable`** – the `Top-Abweichungen` heading, complete table header and first data row remain together.
7. **`hyperlinksClickable`** – dataset, licence and other required external links are clickable and target the expected HTTPS URLs.
8. **`noMissingGlyphs`** – no placeholder boxes, missing symbols, broken dashes, multiplication signs or font substitutions make content ambiguous.

Also record:

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

The workflow checks out the exact candidate, recomputes its fingerprint, validates the receipt and uploads `word-compatibility-report.json` for release review.

A green run is a release prerequisite. The example file at `docs/release-evidence/word-compatibility.example.json` is intentionally incomplete and can never pass validation.

## When evidence must be repeated

Repeat the Word check whenever:

- the input fingerprint changes;
- the prior evidence expires;
- Word or the operating system is upgraded in a way that can affect rendering;
- the automated LibreOffice Golden artifact changes page count or layout materially;
- a release reviewer observes a discrepancy not represented by the existing checks.

Never copy a prior fingerprint into a new receipt without opening and checking the newly generated candidate in Word.
