# Documentation deep-link QA

User-facing screenshots and action links may point to the public Unfallwerkbank only when the documented state is reproducible. The contract covers both `README.md` and `docs/DOKUMENTATION.md`; it does not treat either file as an informal gallery.

## Static documentation contract

`scripts/documentation-deeplink-contract.cjs` reads both user-facing documents and validates every embedded PNG/GIF and every canonical application URL.

For the 14 documented application-screenshot scenarios it requires:

- every displayed medium is clickable;
- every screenshot path has one declared canonical scenario;
- every use of that screenshot carries the exact declared query parameters;
- undeclared query parameters fail closed;
- map centre and selection bounds are spatially consistent;
- screenshots of transient dialogs link to the underlying analysis state rather than pretending that `?export=1` opens the dialog.

The complete contract is exercised by `tests/unit/documentationDeepLinkContract.test.js` and `tests/integration/documentationDeepLinkRepositoryContract.test.js`.

## Representative browser scenarios

Browser QA intentionally deduplicates repeated documentation links. It opens six representative states generated from the contract:

Linked screenshots:

1. Hannover cluster-only state;
2. Bonn with a marked selection;
3. Bonn with visible school/kindergarten POIs.

Explicitly named README actions:

1. the canonical Hannover start state;
2. the Bonn export input state with Rad/Pkw, 6–18 hours and a marked selection;
3. the Bonn-Hbf Rad/Pkw heatmap with a marked selection.

The export input link does **not** auto-open the modal. The documentation tells users to choose **Analyse/Export öffnen** after the reproducible map state has loaded.

For each browser scenario the QA verifies, where declared:

- city and successful non-empty accident-data loading;
- visible viewport count equals the runtime count;
- involvement filters and OR/AND mode;
- hour range;
- cluster/heatmap state and actual Leaflet-layer presence;
- map centre, zoom and selection bounds;
- loaded and visible school/kindergarten POIs;
- uncaught page errors, console errors and unexpected same-origin HTTP/resource failures remain hard failures.

Evidence is written to `out/qa/documentation-live-links/`.

## Candidate and published execution

The PR Visual Check builds the exact candidate and runs the browser scenarios against `http://localhost:8000` by setting `DOCUMENTATION_APP_BASE_URL`. Its artifacts prove the links against the code under review.

The actually published GitHub Pages application is checked separately after deployment and on the scheduled runtime-health path. Set `DOCUMENTATION_AUDIT_PUBLISHED=1` to target the literal public URLs rather than the local candidate.

## Full-build report-button contract

Deep links prove reproducible analysis states; they do not stand in for transient report controls. `tests/e2e/report-download-buttons.spec.js` runs against the normal canonical `_site` build, opens the report modal through `#btnOpenExport`, clicks `#btnExportWord` and `#btnExportPDF`, and validates:

- both controls are visible and enabled;
- Chromium receives completed downloads;
- filenames end in `.docx` and `.pdf`;
- DOCX begins with the ZIP/OOXML signature and exceeds the minimum size;
- PDF begins with `%PDF-` and exceeds the minimum size.

The resulting files and JSON evidence are attached to the ordinary Playwright CI report. This supplements the LibreOffice/Poppler audit: one gate proves the browser buttons and download wiring, the other proves final document layout and semantic content.

## Local execution

```bash
npm ci
npm run build:site
DOCUMENTATION_APP_BASE_URL=http://localhost:8000 npm run qa:live-documentation-links
npm run test:e2e -- --grep "full site report buttons"
```

For a published-site audit:

```bash
DOCUMENTATION_AUDIT_PUBLISHED=1 npm run qa:live-documentation-links
```

## Relationship to screenshot QA

The screenshot pipeline proves that generated documentation images contain ready accident data and successful real basemap responses. The deep-link contract proves that every displayed screenshot points to its exact scenario. The representative browser subset then proves the most important distinct states without rerunning duplicate links from README and the usage guide.
