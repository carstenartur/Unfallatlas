# DOCX rendered-artifact QA with LibreOffice and Poppler

The DOCX quality gate validates the document that an office suite actually lays out, not only the OOXML structure created by the JavaScript `docx` library.

## Pipeline

The CI workflow performs one deterministic end-to-end pass:

1. generate a real DOCX through `UA.exportToWord` and the production report renderer;
2. apply the same runtime source-link integrity adapter used by the browser so the dataset and licence remain clickable in Word and LibreOffice;
3. embed a 960×640 deterministic cartographic fixture with roads, a selection area, 24 accident points, water, blocks and a legend rather than a 1×1 placeholder;
4. provide a consistent 11-accident detail fixture so image captions and verification sentences cannot silently contradict the displayed evidence;
5. validate the DOCX ZIP signature and minimum size;
6. start LibreOffice Writer headlessly with a fresh isolated user profile;
7. convert the DOCX through the Writer PDF export filter;
8. fail if LibreOffice reports corruption, repair or format errors;
9. validate the converted PDF signature and minimum size;
10. extract final page boxes, text, links, images and headings through the existing Poppler adapter;
11. apply the same renderer-neutral page-boundary, text-size, orphan-heading and artifact contract audit as native PDFs;
12. render every converted PDF page to a reviewable 144-DPI PNG;
13. require Poppler's page count and the rendered PNG count to agree;
14. write SHA-256-linked conversion metadata and upload all evidence.

## Clickable source integrity

The legacy DOCX renderer emitted the correct Unfallatlas and licence wording as plain text. That looked acceptable on the page but produced no hyperlink annotation in Word, LibreOffice or the converted PDF. The runtime adapter `ua.docx_source_links.js` now decorates only this canonical source paragraph during Word export and creates two explicit links:

- the Unfallatlas dataset page;
- the applicable Datenlizenz Deutschland page.

The original `docx` namespace is restored in a `finally` block after every export, exports are serialized to avoid constructor races, and unrelated paragraphs remain untouched. The final Poppler audit checks the actual link annotation rather than searching the visible text for URL-like characters.

## Evidence package

`out/qa/rendered-document/docx/` contains:

- `source.docx` – exact generated document;
- `converted.pdf` – exact LibreOffice rendering used by the audit;
- `conversion-metadata.json` – LibreOffice version, hashes, byte sizes, page inventory and audit result;
- `poppler/rendered-document.json` – normalized final-page model;
- `poppler/rendered-document-audit.json` – fail-closed audit report;
- `pages/page-N.png` – one large review image for every final page.

The source DOCX, converted PDF and every page PNG have SHA-256 values. The adapter also verifies that the independent Poppler model and page renderer produce the same page count.

## Artifact contract

The initial CI contract requires:

- the rendered `SACHVERHALT` section;
- the rendered `BESCHLUSSVORSCHLAG` section;
- a clickable Unfallatlas source link;
- the selected accident count of 24 in the final page text.

Generic final-page checks additionally reject empty pages, content outside printable page bounds, unreadably small text and orphaned headings.

## Local execution

```bash
npm ci
npm run generate:sample-docx
sudo apt-get install libreoffice-writer poppler-utils
node scripts/libreoffice-rendered-document.js \
  --docx out/ci-render-gate.docx \
  --out-dir out/qa/rendered-document/docx \
  --document-id ci-docx-sample \
  --contract tests/fixtures/rendered-document/ci-docx-contract.json
```

This is the LibreOffice/DOCX slice of issue #415. Microsoft Word compatibility, map-image semantic classification from renderer evidence, table reconstruction and the wider Bonn/Hannover/few-row/many-row Golden matrix remain separate follow-ups.
