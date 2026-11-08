# Historical council index and shared location assessment

## Goal

Import Hannover's public council documents for 2021 through the current year
(2026 at implementation), and attempt location assessment for every indexed
record in every supported city. Preserve the common Bonn/Hannover publication
format, importer entry point and map renderer.

## Approach

The existing Hannover source adapter gains a discovery mode that submits the
official public SIM search form for each document year, with all document
types, all committees, no search term and the full result list. It verifies
the reported row count before collecting the linked public documents. Existing
agenda/RSS discovery remains available. No guessed document identifiers are
requested. Full identifiers, including revision/answer suffixes, remain stable.

The alternative of enumerating streets cannot establish general document
coverage. Enlarging the existing agenda limits would still depend on a subset
of committees. Annual public lists therefore provide the primary discovery
source. Public detail pages provide bounded operative text for location
assessment; a failed detail request retains the verified list entry and marks
the missing evidence explicitly.

## Shared contracts

- Continue using `refresh-ris-catalogues.js` and `risSnapshot.js` for all cities.
- Continue publishing one manifest and content-addressed records/map assets per
  city under `data/ris`; do not commit generated publication assets to git.
- Keep existing points, street lines, junctions and bounded sections, with
  evidence and attribution. Never invent a city-centre or street-centre point.
- Every assessed record receives `locationAssessment` with status, consulted
  sources, reasons and truncation. The manifest summarizes those assessments.
- Preserve valid official geometry. Recompute derived locations instead of
  leaving outdated matches after an unsuccessful reassessment.
- Optional `coverage.scope` distinguishes citywide discovery from selected
  committees. Legacy snapshots remain readable.
- Use a provider-independent, atomic source cache for resumable detail reads.
  Source revisions and expiry invalidate old entries; failed reads are not
  cached as successes.
- If the official source is temporarily unavailable, assess the records and
  verified official geometry in the retained snapshot through the same service.
  Preserve its original source timestamp, coverage, failure marker and expiry;
  a new spatial assessment must not make an old source snapshot appear fresh.

## Acceptance

All six requested Hannover year lists must be processed without an undisclosed
row/document limit. Every resulting record and every Bonner index entry must
have an assessment. Missing detail text, unresolved places and bounded output
remain explicit. Verify real record counts, distinct mapped-record counts,
feature counts, payload sizes and snapshot/browser compatibility before
publication. Keep existing fallback, integrity and publication quality gates.

Existing mobile PR #749 is outside this change. Retain the project's canonical
Maven/Pages workflow; extend its existing cache and time budgets where needed.
