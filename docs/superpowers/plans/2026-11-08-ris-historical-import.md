# Historical council index implementation plan

> **For agentic workers:** Use the existing execution workflow; keep source,
> location-contract and cache changes in the assigned non-overlapping files.

**Goal:** Import Hannover 2021–2026 and assess locations for every index record.

**Architecture:** City adapters read their native sources. A shared cache,
assessment service, snapshot contract and Pages pipeline handle the results.

**Tech Stack:** Existing Node.js/CommonJS, Jest, GeoJSON, gzip/JSON, Maven Pages.

**Spec:** `docs/superpowers/specs/2026-11-08-ris-historical-import-design.md`

## Global constraints

- Shared Bonn/Hannover data storage and procedures; no separate city index.
- Preserve full source IDs, official geometry, conservative location evidence,
  exact-address protections, hash validation and atomic publication.
- No fabricated locations or completeness claims; retain explicit limitations.
- Keep PR #749 unchanged and use the existing deployment workflows.

## Review focus

- A form/session mismatch must not silently produce a partial year list.
- Duplicated list rows must not collapse distinct suffix-bearing documents.
- A failed public detail request must retain its verified list entry and expose
  the unavailable document evidence.
- Reassessment must clear obsolete derived geometry and retain official data.
- Source upgrades must refresh recent snapshots while genuine coverage
  regressions still retain the previous publication.

## Tasks

### 1. Annual source discovery and detail collection

Files: `server/political-context/providers/hannoverSimCatalogue.js`,
`tests/unit/hannoverSimSearchCatalogue.test.js`.

- [x] Add failing tests for real-form field selection, year enumeration,
  response row counts, stable IDs, detailed text, and detail failures.
- [x] Implement `collectHannoverCatalogue({ discovery: 'search', from, to,
  sourceCache, report, ...existingOptions })` without changing archive callers.
- [x] Validate the new mode against official year lists and bounded samples.

### 2. Common location assessment and publication contract

Files assigned to location worker: `risLocation.js`, `risSnapshot.js`,
`ua.ris-catalogue.js`, `ua.political-context.js`, and their focused unit tests.

- [x] RED→GREEN tests for all records, multiple title locations, stale derived
  results, official geometry, truncation and visible unresolved results.
- [x] Preserve and validate assessments and aggregate counts across writer,
  reader and browser, including optional `coverage.scope`.

### 3. Shared resumption and existing deployment integration

Files assigned to cache worker: `risSourceCache.js`, its tests, `.gitignore`,
existing Pages workflows and `run-pages-quality-gate.cjs`.

- [x] RED→GREEN cache tests for revisions, expiry, corruption, failed loads,
  concurrent deduplication and safe paths.
- [x] Persist successful source progress across workflow attempts and allow
  the existing pipeline enough time for the initial historical import.

### 4. Execute and verify the common import

Files: `scripts/refresh-ris-catalogues.js`, its unit tests and operational docs.

- [x] Use citywide historical discovery, the shared cache and source progress.
- [x] Trigger immediate coverage/assessment upgrades for both cities and test
  that genuine downgrades still retain the prior verified snapshot.
- [x] Reassess verified fallback records when source reads are rate-limited,
  preserving source timestamps, official geometry, coverage and expiry.
- [ ] Run the real import, review assessment totals and representative places,
  and verify publication/browser limits.
- [ ] Run relevant suites and the available canonical build, independently
  review the branch, submit it and verify the resulting CI/publication state.
