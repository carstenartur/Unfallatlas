# Published documentation deep-link QA

README screenshots may link to GitHub Pages only when the public distribution can reproduce the depicted state. Full-build-only screenshots remain visible as documentation images but are not presented as identical public-app links.

## Public application contract

The live QA reads two linked screenshot states and three explicitly named action links directly from `README.md`, then opens their literal GitHub Pages URLs in Chromium. It verifies visible controls and `UA.getRuntimeContext()` together:

- city and successful accident-data loading;
- the visible viewport count equals the runtime count;
- involvement filters and OR/AND mode;
- hour range;
- cluster/heatmap state and actual Leaflet layer presence;
- map centre, zoom and selection bounds;
- loaded and visible school/kindergarten POIs;
- automatic `?export=1` modal opening and completed preview rendering;
- the visible `public-preview-core-v1` explanation;
- Word/PDF are disabled and the full-build report group is hidden;
- CSV, GeoJSON and KML buttons produce completed, non-empty, structurally valid downloads;
- uncaught page errors, console errors and failed same-origin resources remain hard failures.

Evidence is written to `out/qa/documentation-live-links/` and uploaded by the Visual Check workflow. The public export scenario includes the actual `.csv`, `.geojson` and `.kml` downloads.

## Full-build report-button contract

`tests/e2e/report-download-buttons.spec.js` runs against the normal canonical `_site` build, not the reduced Pages profile. It opens the report modal through `#btnOpenExport`, clicks the actual `#btnExportWord` and `#btnExportPDF` controls and validates:

- both controls are visible and enabled;
- Chromium receives completed downloads;
- filenames end in `.docx` and `.pdf`;
- DOCX begins with the ZIP/OOXML signature and exceeds the minimum size;
- PDF begins with `%PDF-` and exceeds the minimum size.

The resulting files and JSON evidence are attached to the ordinary Playwright CI report. This supplements the existing final-page LibreOffice/Poppler audit: one gate proves the browser buttons and download wiring, the other proves the final document layout and semantic content.

## Documentation rules enforced

- The cluster screenshot links to the exact cluster-only state.
- The POI screenshot, text and URL consistently use 0–23 hours.
- Start and Bonn-Hbf heatmap images are explicitly marked as full-build screenshots and are not linked as identical Pages views.
- The public start, export and Bonn-Hbf cluster states use separately named action links.
- No known-mismatch waiver remains.
- Undeclared query parameters fail closed.

## Local execution

```bash
npm ci
npx playwright install chromium
npm run qa:live-documentation-links
npm run test:e2e -- --grep "full site report buttons"
```

The first command targets the published GitHub Pages application and never starts a local server. The second uses the full local site build.

## Relationship to screenshot QA

The screenshot pipeline proves that generated documentation images contain ready accident data and successful real basemap responses. The public deep-link QA proves only publicly reproducible screenshot states plus the named public actions. Full-build report controls are covered separately rather than weakening the distribution/provenance boundary.
