# Region Hannover Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track the checkboxes against actual test and import results.

**Goal:** Add public Region Hannover documents to the existing searchable Hannover catalogue, with clear source attribution and evidence-based locations.

**Architecture:** Reuse the ALLRIS transport and the existing catalogue refresh, source cache, spatial assessment and seven-root snapshot. A Region adapter owns its official HTML structure and discovery state. Existing city records and source clocks survive partial work.

**Tech Stack:** Existing CommonJS Node.js producers, Jest, static v2 RIS snapshots, Maven/Pages publication. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-08-region-hannover-index-design.md`

## Global Constraints

- Stable source `region-hannover-ris` and IDs `region-hannover-ris:vo:<VOLFDNR>`.
- Only public listed records; bounded normal access, same-origin sessions.
- Do not commit generated city catalogues or session tokens.
- Preserve the existing city, unlocated-record and seven-root reader contracts.

## Review Focus

- Cross-origin redirects must never receive session cookies.
- Wicket callbacks are session-bound and must not be replayed from old checkpoints.
- A metadata-only record or budget boundary must not imply full-text completeness.
- A city refresh must not renew retained regional evidence.
- Regional street names require local evidence before use of the city gazetteer.

## Tasks

- [x] Reuse the public gate client through `allrisPortalGateClient.js`, retaining
  Bonn compatibility. First reproduce origin and gate failures in
  `allrisPortalGateClient.test.js`, then run that and the Bonn suites.
- [x] Add `regionHannoverCatalogue.js` with a public-list parser, proposal parser,
  bounded collector, cache and resumable work state. Test real HTML structure,
  pagination, duplicate IDs, partial details, dates and rejected/private pages.
- [x] Extend `risSnapshot.js` official sources and `ua.ris-layer.js` existing
  source labels. Verify mixed-city/Region roundtrips and safe visible labels.
- [x] Scope regional evidence before `enrichRisLocations`; test identical street
  names in Hannover and other municipalities, and preservation of official geometry.
- [x] Compose the Region collector in `refresh-ris-catalogues.js` and trigger a
  source upgrade for fresh city-only snapshots. Test preservation, source clocks,
  partial acquisition and composite provenance through real snapshot read/write.
- [x] Run the real collection, build the combined snapshot and validate every
  referenced asset. Record actual imported and located counts and remaining limits.
- [ ] Review the full change independently, run the relevant repository gates,
  integrate without overwriting concurrent work and verify publication status.

## Baseline

Main `8b79a7c8c0129cd83f12d2aeaadd5ca17362e6af` already contains the scalable
Hannover catalogue. Initial snapshot/Bonn-search baseline: 71 tests passed.
The inspected public Region list reports 14,055 proposals with 25 rows per page
and selectable page sizes up to 100; this is a source observation, not yet an
import-completeness claim.

## Verified local result

The final public-list traversal captured 14,055 unique Region IDs, matching the
reported total. 2,000 detail requests succeeded, retaining 4,451 consultation
events and 1,746 original PDF links. The combined shared snapshot contains 68,272
records (54,217 SIM and 14,055 Region), with all 3,038 addressed assets validated.
Only one regional record currently meets the conservative city-location rule.
The remaining 12,055 regional detail pages are queued for subsequent bounded runs.
See `docs/qa/region-hannover-index.md` for acquisition scope and reproducible checks.

Independent review findings on retained clocks, explicit non-public withdrawals,
worker/sibling failures, pagination row counts, queue fairness, initial source
backoff and same-clock source upgrades were reproduced in tests and resolved.
