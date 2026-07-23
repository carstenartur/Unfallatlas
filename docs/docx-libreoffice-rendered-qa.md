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
11. apply explicit map semantics from the Golden contract to the extracted final-page images;
12. reconstruct declared table rows from final Poppler words and column positions;
13. apply the renderer-neutral page-boundary, text-size, orphan-heading, map, table-row and artifact contract audit;
14. render every converted PDF page to a reviewable 144-DPI PNG;
15. require Poppler's page count and the rendered PNG count to agree;
16. write SHA-256-linked conversion metadata and upload all evidence.

## Clickable source integrity

The legacy DOCX renderer emitted the correct Unfallatlas and licence wording as plain text. That looked acceptable on the page but produced no hyperlink annotation in Word, LibreOffice or the converted PDF. The fallback runtime adapter `ua.docx_source_links.js` decorates only this canonical source paragraph during standalone Word export and creates two explicit links:

- the Unfallatlas dataset page;
- the applicable Datenlizenz Deutschland page.

When full document provenance is active, that runtime owns the complete source section and the fallback deliberately does not add a second constructor proxy. This prevents proxy-invariant failures while preserving the richer manifest-driven links. The final Poppler audit checks actual link annotations rather than searching visible text for URL-like characters.

## Semantic map evidence

Poppler can prove that image objects exist on a final page, but it cannot infer reliably whether an image is a map, chart, logo or photograph. The Golden contract therefore declares the expected page and image index for each map and supplies the semantic evidence that cannot be reconstructed safely from pixels alone:

- map kind;
- accessible alt text;
- visible caption;
- source IDs;
- original width and height.

The current Bonn contract requires exactly four source-bound maps: overview, filtered selection, detail and cluster. The final audit rejects a map that is missing, too small, unlabelled, unprovenanced or distorted. `conversion-metadata.json` records both `expectedMapCount` and the map count actually extracted from the LibreOffice-rendered pages. A single surviving map can therefore no longer satisfy the document contract when the other three disappear.

The source dimensions are the deterministic fixture dimensions, while the final coordinates come independently from Poppler. Their ratio is compared after LibreOffice layout, so a structurally correct DOCX cannot hide a stretched map in the final PDF.

## Final-page table reconstruction

Poppler exposes words and coordinates but not semantic table rows. The Golden contract therefore declares only the stable anchors for each audited table:

- page number and table ID;
- visible header labels in column order;
- ordered row IDs;
- regular expressions for the visible cell values.

The reconstruction groups final PDF words into visual lines, locates the complete header, derives column boundaries from header centres, and assigns every row word to a column by its final horizontal position. Cell strings, row bounds and order therefore come from the LibreOffice-rendered PDF rather than from DOCX tables or expected source objects.

The first enforced table is the injury-severity table. It must contain one header plus the fatal, serious-injury and slight-injury rows with the rendered counts and percentages. Missing headers, missing rows, changed cell values, overlapping row boxes or an unexpected total row count fail closed. `conversion-metadata.json`, the normalized document model and the final audit all record `tableRowCount: 4`.

This focused first table establishes the reconstruction mechanism without pretending that wrapped and multi-page tables are already solved. The year and deviation tables, repeated headers and large individual-accident tables remain explicit follow-ups.

## Evidence package

`out/qa/rendered-document/docx/` contains:

- `source.docx` – exact generated document;
- `converted.pdf` – exact LibreOffice rendering used by the audit;
- `conversion-metadata.json` – LibreOffice version, hashes, byte sizes, page inventory, semantic map/table evidence and audit result;
- `poppler/rendered-document.json` – normalized final-page model including classified maps and reconstructed table rows;
- `poppler/rendered-document-audit.json` – fail-closed audit report after map and table enrichment;
- `pages/page-N.png` – one large review image for every final page.

The source DOCX, converted PDF and every page PNG have SHA-256 values. The adapter also verifies that the independent Poppler model and page renderer produce the same page count.

## Artifact contract

The CI contract requires:

- the rendered `SACHVERHALT` section;
- the rendered `BESCHLUSSVORSCHLAG` section;
- a clickable Unfallatlas source link;
- the selected accident count of 24 in the final page text;
- exactly four final rendered maps;
- alt text, caption, source IDs and source dimensions for each map;
- exactly four final severity-table rows, including the repeated-header marker.

Generic final-page checks additionally reject empty pages, content outside printable page bounds, unreadably small text, orphaned headings and overlapping table rows.

## Local execution

```bash
npm ci
npm run generate:sample-docx
sudo apt-get install libreoffice-writer poppler-utils
npm run qa:sample-docx-rendered
```

The local command executes the same map and table contract as CI.

This is the LibreOffice/DOCX slice of issue #415. Microsoft Word compatibility, additional final-page tables and the wider Bonn/Hannover/few-row/many-row/missing-context Golden matrix remain separate follow-ups.
