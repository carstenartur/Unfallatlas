# DOCX rendered-artifact QA with LibreOffice and Poppler

The DOCX quality gate validates the document that an office suite actually lays out, not only the OOXML structure created by the JavaScript `docx` library.

## Pipeline

The CI workflow performs one deterministic end-to-end pass:

1. generate a real DOCX through `UA.exportToWord` and the production report renderer;
2. apply the same runtime source-link integrity adapter used by the browser so the dataset and licence remain clickable in Word and LibreOffice;
3. apply the serialized DOCX pagination adapter so declared subsection headings stay with their following content;
4. embed a 960×640 deterministic cartographic fixture with roads, a selection area, 24 accident points, water, blocks and a legend rather than a 1×1 placeholder;
5. provide a consistent 11-accident detail fixture so image captions and verification sentences cannot silently contradict the displayed evidence;
6. validate the DOCX ZIP signature and minimum size;
7. start LibreOffice Writer headlessly with a fresh isolated user profile;
8. convert the DOCX through the Writer PDF export filter;
9. fail if LibreOffice reports corruption, repair or format errors;
10. validate the converted PDF signature and minimum size;
11. extract final page boxes, text, links, images and headings through the existing Poppler adapter;
12. apply explicit map semantics from the Golden contract to the extracted final-page images;
13. reconstruct declared table rows from final Poppler words and column positions;
14. bind subsection headings to their actual final table starts;
15. apply the renderer-neutral page-boundary, text-size, orphan-heading, map, table-row and artifact contract audit;
16. render every converted PDF page to a reviewable 144-DPI PNG;
17. require Poppler's page count and the rendered PNG count to agree;
18. write SHA-256-linked conversion metadata and upload all evidence.

## Clickable source integrity

The legacy DOCX renderer emitted the correct Unfallatlas and licence wording as plain text. That looked acceptable on the page but produced no hyperlink annotation in Word, LibreOffice or the converted PDF. The fallback runtime adapter `ua.docx_source_links.js` decorates only this canonical source paragraph during standalone Word export and creates two explicit links:

- the Unfallatlas dataset page;
- the applicable Datenlizenz Deutschland page.

When full document provenance is active, that runtime owns the complete source section and the fallback deliberately does not add a second constructor proxy. This prevents proxy-invariant failures while preserving the richer manifest-driven links. The final Poppler audit checks actual link annotations rather than searching visible text for URL-like characters.

## Pagination integrity

Short subsection headings can be moved independently from the following table by office-layout engines. The Bonn Golden artifact previously ended page 1 with `Top-Abweichungen (Ausschnitt vs. Stadt):`, while its six-column table began on page 2. A reader had to infer that the orphaned line belonged to the next page.

`ua.docx_pagination.js` now wraps the already provenance-protected Word exporter through a serialized, temporary DOCX-library boundary. It adds the native DOCX `keepNext` property only to exact declared headings. The adapter:

- does not insert fixture-specific page breaks;
- preserves all existing paragraph options;
- restores `window.docx` after success or failure;
- serializes simultaneous Word exports;
- composes with the configurable provenance/source-link constructors rather than stacking a permanent proxy.

The final-page `tableSectionBindings` contract independently verifies the effect after LibreOffice rendering. For every declared binding it requires:

- exactly one visible subsection heading;
- a reconstructed table with the declared ID;
- heading and initial table header on the same final page;
- heading before the header and within the permitted vertical gap;
- at least one data row on that page.

A structurally correct DOCX therefore cannot pass if LibreOffice still leaves the heading alone at a page boundary.

## Semantic map evidence

Poppler can prove that image objects exist on a final page, but it cannot infer reliably whether an image is a map, chart, logo or photograph. The Golden contract therefore declares the expected page and image index for each map and supplies the semantic evidence that cannot be reconstructed safely from pixels alone:

- map kind;
- accessible alt text;
- visible caption;
- source IDs;
- original width and height.

The current Bonn contract requires exactly four source-bound maps: overview, filtered selection, detail and cluster. The final audit rejects a map that is missing, too small, unlabelled, unprovenanced or distorted. `conversion-metadata.json` records both `expectedMapCount` and the map count actually extracted from the LibreOffice-rendered pages. A single surviving map can therefore no longer satisfy the document contract when the other three disappear.

The source dimensions are the deterministic fixture dimensions, while the final coordinates come independently from Poppler. Their ratio is compared after LibreOffice layout, so a structurally correct DOCX cannot hide a stretched map in the final PDF.

The Golden generator supplies the same 24 normalized accident objects through `allPts`, `filteredAll`, `filteredCapped` and `viewportPts`, including the live `props` field shape used by involvement and non-involvement filters. This closes a previously hidden fixture defect where the narrative and tables contained 24 cases but overview and selection captions rendered `n = 0` because the report received only a partial runtime context.

The final-page inventory rejects every zero-count map contradiction and checks the exact relationship between maps:

- overview map: `n = 24`;
- selection map: `n = 24`;
- detail map: `n = 24`, explicitly a subset of the 24 selection-map cases;
- cluster map: `n = 11`, explicitly a subset of the same 24 selection-map cases.

These assertions are extracted from the LibreOffice-rendered pages, not from the fixture objects or DOCX source model.

## Final-page table reconstruction

Poppler exposes words and coordinates but not semantic table rows. The Golden contract therefore declares only the stable anchors for each audited table:

- page number and table ID;
- visible header labels in column order;
- ordered row IDs;
- regular expressions for the visible cell values;
- an optional maximum number of visual lines per row;
- whether a page header is an actual continuation-page repetition.

The reconstruction groups final PDF words into visual lines, locates the complete header, derives column boundaries from header centres, and assigns every row word to a column by its final horizontal position. Cell strings, row bounds and order therefore come from the LibreOffice-rendered PDF rather than from DOCX tables or expected source objects.

Wrapped rows are reconstructed only when the contract explicitly permits them with `maxLinesPerRow` or a narrower row-level `maxLines`. The implementation combines consecutive rendered lines column by column, expands the final row box across all participating lines and still requires every complete visible cell to match its declared expression. A layout change cannot silently absorb text from an unlimited number of following lines.

Continuation pages use a separate hint for the actual final page. `repeatedHeader: true` marks only the header reconstructed on that page and gives it a page-specific row ID such as `severity.header.page2`; normal data rows remain `repeatedHeader: false`. The marker must be a real JSON boolean: strings and numbers are rejected instead of being coerced by JavaScript truthiness.

After reconstruction, the enriched final-page model is validated across page boundaries. The first header of a table must not be marked as repeated. Every later page containing the same table must start with exactly one repeated header, and its complete visible cells must match the initial header. Semantic row IDs must remain unique across all pages of a table. Missing, displaced or changed continuation headers therefore cannot pass through a correct total row count alone.

The Bonn Golden artifact now enforces three real tables and ten final rows:

1. the injury-severity table with header plus fatal, serious-injury and slight-injury rows;
2. the deviation table with its six-column header and the Rad+PKW data row;
3. the yearly accident table with header plus the rendered 2022, 2023 and 2024 rows.

The deviation row must visibly contain `5`, `11`, `45,8%`, `14,6%`, `3,13×` and `[– – –]`. Its heading, complete table header and first row must stay together on page 2.

The yearly rows are deliberately multi-line in the third column. The final contract reconstructs and verifies the visible combinations:

- 2022: total 7; Radverkehr + PKW = 3, Radverkehr = 2, PKW = 2;
- 2023: total 8; Radverkehr + PKW = 4, Radverkehr = 2, PKW = 2;
- 2024: total 9; Radverkehr + PKW = 4, Radverkehr = 3, PKW = 2.

The three yearly totals sum to the same 24 cases used by the narrative, severity table and map captions. `conversion-metadata.json`, the normalized document model and the final audit must all record three table hints, one subsection binding and `tableRowCount: 10`.

Adding a real large individual-accident table to the versioned Bonn/Hannover artifact matrix remains separate work; the wrapped-row, continuation and subsection-binding mechanisms no longer need to be redesigned for that case.

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
- the selected accident count of 24 in final narrative, tables and relevant map captions;
- exactly four final rendered maps;
- alt text, caption, source IDs and source dimensions for each map;
- no `n = 0` or `Teilmenge der 0 Unfälle` contradiction;
- exactly four final severity-table rows;
- exactly two final deviation-table rows;
- exactly four final yearly-table rows, including three wrapped data rows;
- the Top-Abweichungen heading, table header and first data row on page 2;
- exact visible cells and stable semantic row IDs for all ten table rows.

Generic final-page checks additionally reject empty pages, content outside printable page bounds, unreadably small text, orphaned headings and overlapping table rows.

## Local execution

```bash
npm ci
npm run generate:sample-docx
sudo apt-get install libreoffice-writer poppler-utils
npm run qa:sample-docx-rendered
```

The local command executes the same map, pagination and table contract as CI.

This is the LibreOffice/DOCX slice of issue #415. Microsoft Word compatibility, the large-individual-accident table and the wider Bonn/Hannover/few-row/many-row/missing-context Golden matrix remain separate follow-ups.
