# Unfallwerkbank 2.1.4 — prepared release notes

**Status: unpublished candidate.** These notes describe changes already on
`main` at `4b0ebfdaeb3b0d6dab572a5641c5a920cf561f54`, compared with
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
  [#703](https://github.com/carstenartur/Unfallatlas/pull/703); later open refresh
  requests are outside this candidate. See also
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

## Packaging and quality

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
  Word/PDF export uses docx 9.15.1 and pdfjs-dist 6.4.299; Playwright packages and
  the Docker browser runtime are aligned at 1.64.1. The build uses pinned npm
  11.21.1, and complete audit evidence remains available alongside compact CI
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
