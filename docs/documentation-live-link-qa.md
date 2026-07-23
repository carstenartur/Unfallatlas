# Published documentation deep-link QA

The README screenshots are navigation controls, not decorative images. Clicking a screenshot is intended to open the published Unfallwerkbank in the same analysis state that the screenshot documents.

## What is tested

The live QA reads the canonical screenshot links directly from `README.md` and opens their absolute GitHub Pages URLs in Chromium. It does not reconstruct URLs from a second test-only source.

For each scenario it verifies both the visible controls and `UA.getRuntimeContext()`:

- city and successful accident-data loading;
- positive local accident count;
- involvement filters and OR/AND mode;
- hour range;
- cluster and heatmap state plus actual Leaflet layer presence;
- map centre and zoom with a documented tolerance;
- selection bounds, visible selection rectangle and accidents inside the selection;
- loaded and visible school/kindergarten POIs;
- automatic `?export=1` modal opening and completed report rendering;
- successful Word, PDF, CSV, GeoJSON and KML downloads from the visible buttons;
- plausible filenames, minimum byte sizes and format signatures/content for every download;
- uncaught page errors, console errors and failed same-origin application resources.

The test writes one full-page PNG and one JSON runtime snapshot per README scenario to:

```text
out/qa/documentation-live-links/
```

For the export scenario it additionally stores the downloaded `.docx`, `.pdf`, `.csv`, `.geojson` and `.kml` files. These files are review evidence. They are uploaded by the existing Visual Check workflow and are not copied automatically into `docs/screenshots/`.

## Contract boundary

`scripts/documentation-deeplink-contract.cjs` owns the expected semantic state. The URL is still taken from the README. This separation detects both failure directions:

1. the Markdown link changes without an intentional contract update;
2. the published application loads the URL but hydrates a different UI/runtime state.

The contract accepts no undeclared query parameters. A link therefore cannot accumulate stale flags while still passing because the important subset happens to match.

## Resolved documentation mismatches

The cluster screenshot now links to the exact cluster-only state with heatmap, school, kindergarten and argumentation overlays disabled. No known-mismatch waiver remains.

The POI screenshot, its link and its README description now consistently use the existing ganztägig scenario from 0–23 hours. A later 6–18-hour school-route screenshot must be introduced as its own deliberately generated and reviewed scenario rather than reusing a different image.

## Export trust boundary

The public-app QA clicks the actual controls `#btnExportWord`, `#btnExportPDF`, `#btnExportCSV`, `#btnExportGeoJSON` and `#btnExportKML`. A button is accepted only when Chromium receives a completed download and the resulting bytes match the expected format. Merely exposing an enabled button or invoking an internal renderer function is not sufficient.

The optional live Overpass/OSM-context checkbox is disabled before the five download checks. This keeps the document-generation gate focused on the workbench and its packaged export libraries rather than making all five file formats depend on an unrelated external API. Maps, POIs, statistics, measures and the other report sections remain enabled.

## Local execution

```bash
npm ci
npx playwright install chromium
npm run qa:live-documentation-links
```

The runner is cross-platform and sets the published GitHub Pages base URL explicitly, so Playwright does not start the local development server for this check.

## Relationship to screenshot QA

The existing documentation screenshot pipeline proves that generated screenshots contain ready accident data and successful real basemap responses. The deep-link QA proves the reverse path: the link attached to the accepted screenshot still reconstructs the documented analysis in the application that readers actually open.

Both gates run in `.github/workflows/visual-check.yml`. A screenshot artifact is accepted only when screenshot evidence, cartography evidence, media validation and live deep-link validation all succeed.
