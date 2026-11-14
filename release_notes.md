# Unfallwerkbank 2.1.4 — prepared release notes

**Status: unpublished candidate.** These notes describe changes on
the reviewed integrated stack `d930fbc44f55db7ba2631032958c2b897243ad33`,
its technical Golden evidence follow-up, and the source-bound document-QA
candidate in PR #724, compared with
[`v2.1.3`](https://github.com/carstenartur/Unfallatlas/releases/tag/v2.1.3).
Publication remains blocked by the acceptance items in
[the preparation record](docs/releases/2.1.4-preparation.md).

## User-visible changes

- **More consistent static data loading.** The gzip-only data path, shared
  resource access and producer validation are consolidated. Accident viewport
  loading includes coverage guards so a partial map view is not silently treated
  as complete export data. See [#380](https://github.com/carstenartur/Unfallatlas/pull/380),
  [#383](https://github.com/carstenartur/Unfallatlas/pull/383) and
  [#388](https://github.com/carstenartur/Unfallatlas/pull/388).
- **Reproducible context data.** Context generation uses verified inputs and
  explicit fallback behaviour. Reviewed context-data updates are included through
  [#745](https://github.com/carstenartur/Unfallatlas/pull/745); later open refresh
  requests are outside this candidate unless explicitly identified below. See also
  [#389](https://github.com/carstenartur/Unfallatlas/pull/389),
  [#666](https://github.com/carstenartur/Unfallatlas/pull/666) and
  [#669](https://github.com/carstenartur/Unfallatlas/pull/669).
- **More reliable Word and PDF map output.** Map tiles are fully embedded in the
  document export instead of depending on later external tile loading
  ([#665](https://github.com/carstenartur/Unfallatlas/pull/665)).
- **Clearer behaviour on static hosting.** Political research on GitHub Pages
  reports its server dependency explicitly instead of failing with an opaque
  HTTP 405 response
  ([#664](https://github.com/carstenartur/Unfallatlas/pull/664)).
- **Correct verification of source badges in video exports.** The encoded-media
  check now inspects the final cropped frames directly instead of inferring the
  recording duration from another audit's sampling rate. This keeps provenance
  validation tied to the actual visible source strip
  ([source change](https://github.com/carstenartur/Unfallatlas/commit/35a504836419a9089358d8bfe6dd8ac674286b05)).

- **Broader, explicitly qualified political evidence.** Bonn source caching and
  Hannover historical catalogues preserve original verification clocks, partial
  coverage and failures. Public consultation histories and direct document
  relationships load on request from bounded snapshot pages. Landtag and Region
  public sources retain separate source status and date roles; protected Region
  RIS remains blocked. Snapshot/export provenance binds the actual source and
  distribution fingerprints ([#750](https://github.com/carstenartur/Unfallatlas/pull/750),
  [#753](https://github.com/carstenartur/Unfallatlas/pull/753)).
- **Typed traffic and terrain context.** Reviewed code distinguishes measured
  counts, model values and qualitative proxies, preserves genuine zero, and
  rejects missing values that could otherwise be coerced to zero. Selected road
  profiles retain signed, geometry-relative slope and source pins in popups and
  exports. The real Köln pilot and bounded Hannover DGM references are evidence
  for those paths, not citywide activation or new current measurements; DGM
  quality/manual acceptance remains open
  ([#752](https://github.com/carstenartur/Unfallatlas/pull/752)).
- **Consistent area names and proposal templates.** A shared area name follows
  the original hydrated selection geometry and reaches exports. Versioned
  proposal templates and the Bonn Hbf Golden case bind real populations and
  source fingerprints. Automated replay does not constitute actual AI-provider,
  scientific or proposal-readiness approval.

## Packaging and quality

- **Candidate document acceptance:** source-bound PDF/DOCX/CSV/GeoJSON exports
  preserve all 111 selected accident rows and nine distinct numbered maps.
  Final-page checks reconstruct table cells and captions and verify embedded
  source hashes and image pixels. Readable 9-point landscape tables and concise
  clickable map links replace the broken long URLs and cramped appendix columns.
  Native-PDF detail headings stay on the same page as their map, independently
  checked against final positioned text and image bounds.
  This addition is in preparation PR #724; actual Microsoft Word acceptance remains open.
- Repository storage checks now account for intermediate historical blobs and
  every introduced path association, preserve pinned release archives, and fail
  closed when their comparison baseline is unavailable
  ([#751](https://github.com/carstenartur/Unfallatlas/pull/751)).
- The canonical Pages bundle binds locked browser assets, data fingerprints,
  media evidence, notices and SBOM output to the built site.
- Release acceptance keeps reviewed screenshots intact and checks the actual
  candidate media and browser evidence. The Pages Playwright gate fails closed.
  See [#658](https://github.com/carstenartur/Unfallatlas/pull/658),
  [#677](https://github.com/carstenartur/Unfallatlas/pull/677) and
  [#678](https://github.com/carstenartur/Unfallatlas/pull/678).
- Maven owns the combined browser, Java/Testcontainers, Golden-case and rendered
  document acceptance. The release workflow builds a deterministic website ZIP
  and the Analysis Service JAR from its tested release commit.
- The reviewed npm security group [#722](https://github.com/carstenartur/Unfallatlas/pull/722)
  updates vulnerable dependency versions while retaining strict audit enforcement.
  Word/PDF export uses docx 9.15.4 and pdfmake 0.3.14;
  pdfjs-dist 6.5.438 validates exported PDFs in QA.
  Playwright packages and the Docker browser runtime are aligned at 1.65.0.
  The build uses pinned npm 11.21.2, and complete audit evidence remains available alongside compact CI
  summaries.
- The Analysis Service uses Spring Boot 4.1.2 and Java 27 build/runtime containers.
  Its packaged PostgreSQL driver is 42.7.14 after removal of an obsolete override.
  Jackson is aligned on the patched 3.1.8 BOM in production and 2.22.4 in the
  independent QA module. See the coordinated Java/security update
  [#725](https://github.com/carstenartur/Unfallatlas/pull/725), including
  [#728](https://github.com/carstenartur/Unfallatlas/pull/728).
- The Actions update [#726](https://github.com/carstenartur/Unfallatlas/pull/726)
  retains immutable action pins and screenshot-publication safeguards. The
  associated exact-SHA assertions have been updated and verified.
- The gRPC patch [#727](https://github.com/carstenartur/Unfallatlas/pull/727)
  updates the Testcontainers/Docker test dependency to 1.14.7; the production
  dependency tree is unaffected by that test-only change.
- Subsequent merged maintenance includes ip-address 10.7.6, JSZip 3.10.2,
  the locked Node Testcontainers dependency 12.2.1 and Maven Failsafe 3.6.1.
  The latest merged lockfile also resolves Express 5.3.0 and
  @axe-core/playwright / axe-core 4.14.0
  ([#734](https://github.com/carstenartur/Unfallatlas/pull/734),
  [#733](https://github.com/carstenartur/Unfallatlas/pull/733)).
  See [#707](https://github.com/carstenartur/Unfallatlas/pull/707),
  [#731](https://github.com/carstenartur/Unfallatlas/pull/731) and the
  [combined source change](https://github.com/carstenartur/Unfallatlas/commit/35a504836419a9089358d8bfe6dd8ac674286b05).
- The 2 November source refresh includes pdfjs-dist 6.5.438
  ([#708](https://github.com/carstenartur/Unfallatlas/pull/708)) and Maven Enforcer
  3.7.0 ([#735](https://github.com/carstenartur/Unfallatlas/pull/735)). Final-source checks remain required before release qualification.
- Each dialog accessibility audit now has its own Playwright test and normal
  page fixture. All four axe scans, blocking assertions and the separate
  Escape/focus checks remain in place, with the existing per-test time limit.

## Expected release assets

- `unfallatlas-analysis-service-2.1.4.jar`
- `unfallatlas-website-2.1.4.zip`
- Tag `v2.1.4`; the tag-triggered container publication has its own gates.

These are planned outputs, not already published downloads.

## Operating limits

External base maps, Overpass and optional server APIs still need network access.
The browser-only site does not provide server-only functions. Analysis remains
an aid for investigating accident patterns, not a causal or legal determination.

Component-level vendor provenance remains tracked in
[#406](https://github.com/carstenartur/Unfallatlas/issues/406). Known incomplete
provenance must stay visible in the relevant manifests and notices. This release
does not claim complete transitive provenance or waive any existing publication
or container gate.

---

## Maintainer notes

### One-time enrichment-size baseline reseed (after PR #261)

`out/.enrichment-size-baseline.json` was intentionally cleared as part of the
context-data refactor in PR #261 because the new producer pipeline introduces
a `geometries` block (and, from producer 1.2.0 onwards, a tiled `out/ctxtiles/`
layout) used by the new map overlays. The +10 % CI gate in
`scripts/check-enrichment-size.js` would otherwise trip on the first real-data
enrich run.

After the first successful `enrich.yml` run on `main` with the current
producer has committed the regenerated per-city geojson + `ways_<city>.json`
files (and any `out/ctxtiles/<slug>/`), reseed the baseline once:

```sh
node scripts/check-enrichment-size.js --update
git add out/.enrichment-size-baseline.json
git commit -m "ci: reseed enrichment-size baseline after enrich.yml run"
```

From that point onwards, the +10 % growth budget is enforced again against
the new, post-enrichment sizes. Without this step the gate stays in
"every city is new → seed mode" and never blocks regressions.
