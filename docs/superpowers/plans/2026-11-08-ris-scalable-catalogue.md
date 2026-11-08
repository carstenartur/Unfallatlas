# Scalable council catalogue and map controls implementation plan

> For agentic workers: execute the independent owned tasks in this session,
> with focused regression tests, integration review and final branch review.

**Goal:** Publish large historical RIS catalogues with bounded lazy access and a
single understandable map control, then merge the verified change into main.

**Architecture:** A partitioned version of the shared snapshot separates full
records, search, relations and map geometry. Existing entry points dispatch by
version. Shared spatial/loading primitives are reused across datasets.

**Tech Stack:** Existing CommonJS/UMD JavaScript, Node, gzip/JSON, Leaflet, Jest,
Playwright and canonical Maven/GitHub Actions; no new service dependency.

**Spec:** `docs/superpowers/specs/2026-11-08-ris-scalable-catalogue-design.md`

## Global constraints

- Work on the existing feature branch; no generated catalogue assets in Git.
- Keep all prior Hannover data, Bonn fallback provenance and mobile behaviour.
- v1 remains readable; production refresh emits the partitioned shared format.
- Source failures do not invent freshness, completeness or geometry.
- No Berlin importer, no PDF archive mirror, no new CI workflow.
- User explicitly authorizes implementation and merge; routine choices are made
  here without another approval round.

## Review focus

- Official Bonn features without derived locations must remain mapped.
- Unmapped children must be discoverable from a mapped parent through reverse
  relations, including cross-year edges and cycles.
- A large single record, popular term/place, or directory needs bounded pages.
- Missing spatial/index parts must not become complete empty results.
- Unified menu state must survive asynchronous loading and responsive changes.

## Task 1: Shared partition contract, producer and reader

Owned modules: new `server/political-context/services/risPartitionedSnapshot.js`,
new `js/ua.ris-partitions.js`, existing `risSnapshot.js`, `risSnapshotSearch.js`,
`js/ua.ris-catalogue.js`, associated focused unit tests.

Public facade remains `createCatalogue`, `search`, `resolveReferences`,
`loadManifest`, `loadMap`. Add lazy `loadFeatureRecords(city, geometryId, page)`,
`loadRelatedRecords(city, recordId, page)` and record/location page lookup.
`loadMap(city, {bounds, zoom})` returns a bounded FeatureCollection, a manifest,
`partitioned: true`, and explicit coverage/overview state for v2. Its features
carry stable geometry IDs, display accuracy and record counts. No full record
array is required to render. Discuss exact result fields with the integrator
before completing the implementation. Legacy v1 keeps its existing behaviour.

- [x] Add failing tests for >50k records, mapped/unmapped separation, cross-year
  reverse relations, >8 places, bounded directories and corrupt/missing parts.
- [x] Implement bounded immutable assets, validated lazy lookup/search/spatial
  access, byte-aware cache and concurrent request limits.
- [x] Verify v1 regression tests and the new contract; document chosen format.

## Task 2: Common source checkpoints and historical range

Owned modules: `scripts/refresh-ris-catalogues.js`, Hannover/Bonn source adapters,
source cache/checkpoint modules, refresh/provider tests and existing workflow
cache paths if necessary. Use Task 1's v2 writer/read facade after agreement.

- [x] Reproduce loss of progress at a work budget and fixed archive boundaries.
- [x] Add persisted scope-bound source work and configurable historical start;
  preserve completed years and source change/retry detection.
- [x] Make publication/install/prune/validation traverse all manifest-referenced
  v2 assets, including fallback migration; keep integrity/expiry gates.
- [x] Verify interrupted/resumed history, source revision and failed detail cases.

## Task 3: Unified floating map control

Owned modules: `js/ua.map_v2.js`, `js/ua.ui.js`, `css/ua.css`, `werkbank_v2.html`,
map control/panel tests and relevant existing Playwright scenarios.

- [x] Add failing behavioural tests for one Karten entry and retained independent
  cluster/heatmap state, capability-dependent items and keyboard state.
- [x] Group and move existing controls into one labelled floating surface;
  preserve background, source and export state; remove redundant controls.
- [x] Verify touch sizes, phone/landscape/tablet occlusion, focus and state across
  lazy loads and resize. Leave RIS renderer ownership to Task 4.

## Task 4: Lazy RIS layer, shared spatial primitives and integration

Owned by root: `js/ua.ris-layer.js`, `js/ua.political-context.js`, spatial utility
extraction and its consumers, location enrichment, integration tests and version
references coordinated with the other owners.

- [x] Add failing tests for a bounded viewport request, lazy popup/related pages,
  stale responses and overview semantics without invented exact markers.
- [x] Integrate v2 facade in the existing renderer; retain v1 path and accessible
  geometries. Share grid/lifecycle primitives with existing providers.
- [x] Remove the source-independent eight-location truncation for v2 publication,
  retain explicit evidence bounds and paginated display.
- [x] Verify search/reference/export generation consistency and byte budgets.

## Task 5: Real data, scale and UI acceptance

- [x] Migrate both actual city snapshots and compare canonical counts/evidence.
- [x] Execute resumed Hannover history to 2014 and retain honest coverage.
- [x] Run the scale scenarios, representative geographic cases, actual reader
  checks and actual mobile/browser scenarios; build and validate the site.
- [x] Update operational documentation and measurements using actual output.

## Task 6: Review, CI and authorized integration

- [x] Fresh independent whole-branch review; fix confirmed findings.
- [ ] Run canonical available verification and existing remote CI on final head.
- [ ] Update the existing PR with results, merge exact verified head into main,
  then verify main/publication and provide the resulting code/data status.
