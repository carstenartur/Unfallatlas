# Hannover Additional Political Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add verified public Region Hannover agenda notices and Landtag catalogue/RSS records without claiming a complete archive or bypassing Region RIS protection.

**Architecture:** Keep city SIM intact and compose independently cached sources. New parsers consume the audited official HTML/XML shapes; collectors retain bounded continuation state and per-source coverage. The backend searches collected local records and the scheduled build merges them into the Hannover snapshot. Optional sourceContext and originalPdfUrl retain publisher/issuer/date roles; unknowns are null.

**Tech Stack:** CommonJS Node.js, built-in HTTPS/filesystem, existing RIS cache/checkpoint and Jest.

**Spec:** `task-sources-report.md` records decisions and verification; authoritative source audit is the coordination `political-sources-audit.md` and parent task.

## Global Constraints

- No remote writes, access-protection solving, default full archive crawl or generic NILAS fulltext claim.
- Preserve city SIM; isolate source errors, original document URLs, provenance and coverage.
- Parent owns shared snapshot/browser/schema extensions and timeline fields; coordinate exact contracts before merging.
- State/region records require substantive local traffic evidence. Letterheads, datelines, institution names and meeting venue cannot establish geography.

## Review Focus

- Unknown HTML/protection pages must fail visibly rather than mean no records.
- Pagination links and PDF URLs must stay on declared official hosts, without credentials, alternate ports or numeric URL guessing.
- Bounded backfill must resume without dropping earlier pages and never claim archive completeness.
- RSS publication dates must not become document dates, and answer/proposal/agenda statuses must remain distinct.
- Optional source failure must not discard successful SIM records or previous source checkpoints.

### Task 1: Official formats and relevance

Files: new `providers/hannoverAdditionalFormats.js`, official minimized fixtures in `tests/fixtures/political-sources/`, `tests/unit/hannoverAdditionalSources.test.js`.

Interfaces: `parseLandtagFeed(xml, feedUrl)`, `parseLandtagCatalogue(html, pageUrl)`, `parseRegionIndex(html)`, `parseRegionNotice(html, url)`, `hasLocalTrafficEvidence(record)`.

- [x] Write fixture tests for real 19/8980, RSS date roles, catalogue continuation/disabled links, agenda date roles and statewide/venue-only negative cases.
- [x] Run Jest and observe missing parser failures.
- [x] Implement bounded official URL validation and exact observed formats; unexpected response shapes throw.
- [x] Run focused tests and commit the parser deliverable.

### Task 2: Cached and resumable collectors

Files: new `providers/hannoverAdditionalSources.js`, new collector tests.

Interfaces: `collectHannoverAdditionalSources({ now, sourceCache, checkpoint, request, maxPages=2, maxNotices=4, filters, includeCatalogue=true })` returns `{ records, sources, sourceStatuses, coverage }`. Collector functions expose independently testable bounded catalogue/RSS/notice paths.

- [x] Write failing tests for resume, budget termination, hostile continuation, cache reuse, isolated source failure and blocked RIS with no request.
- [x] Implement bounded fetch, rolling RSS updates, explicit catalogue filters and checkpoint continuation. Failed refreshes retain last verified source records and mark stale.
- [x] Run collector/parser tests and commit.

### Task 3: Backend composition

Files: new `providers/hannoverCompositeProvider.js`; narrow registry, normalization and search-meta changes; integration tests.

Interfaces: composite implements existing `{ results, meta }` envelope with `sourceStatuses`; additional records carry their own source key and sourceContext.

- [x] Write failing test that real composition keeps city records when an additional source fails, preserves source keys/date roles and only returns substantively local additional matches.
- [x] Implement composition with cached collectors, per-source status, and existing request-level limits.
- [x] Verify affected political-context tests and commit.

### Task 4: Build integration and report

Files: narrow `scripts/refresh-ris-catalogues.js` integration; new `providers/hannoverCatalogueComposition.js`; documentation and report.

Interfaces: combine existing SIM catalogue with bounded additional-source records while preserving SIM history and independent source coverage; parent shared format accepts sourceStatuses/sourceContext/originalPdfUrl.

- [x] Write failing build-composition fixture test; integrate with refresh collector without changing SIM collector.
- [x] Verify backend and build composition with fixture tests and real public HTTP route; run affected tests and project suite. Shared writer/browser integration is explicitly delegated to parent/dependency_fixes.
- [x] Record exact passed/failed checks, limitations and commits in `task-sources-report.md`; commit and return to parent.
