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
- uncaught page errors, console errors and failed same-origin application resources.

The test writes one full-page PNG and one JSON runtime snapshot per README scenario to:

```text
out/qa/documentation-live-links/
```

These files are review evidence. They are uploaded by the existing Visual Check workflow and are not copied automatically into `docs/screenshots/`.

## Contract boundary

`scripts/documentation-deeplink-contract.cjs` owns the expected semantic state. The URL is still taken from the README. This separation detects both failure directions:

1. the Markdown link changes without an intentional contract update;
2. the published application loads the URL but hydrates a different UI/runtime state.

The contract accepts no undeclared query parameters. A link therefore cannot accumulate stale flags while still passing because the important subset happens to match.

## Known mismatch handling

A known documentation defect may be represented only as an exact state discrepancy tied to an open issue. Page errors, HTTP failures, missing data or unrelated state changes remain hard failures.

Issue #509 currently records the generic README target behind `04-cluster-ansicht.png`: the image documents a cluster-only state, while the link opens the default cluster-and-heatmap state with POI and argumentation overlays enabled. The waiver lists those exact four state differences. Any additional deviation fails the QA.

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
