# RIS location clause boundaries implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track each completed step below.

**Goal:** Preserve independently evidenced locations currently lost at coordinated sections or quoted sentence boundaries.

**Architecture:** Repair internal parsing spans in the existing mapper while keeping full source quotations, ambiguity and spatial precision. Reassess retained Hannover evidence through the existing revision mechanism.

**Tech Stack:** Node.js 26, CommonJS, Jest, existing ATKIS gazetteer and Maven CI.

**Spec:** `docs/superpowers/specs/2026-11-10-ris-location-clause-boundaries-design.md`

## Global constraints

- No arbitrary selection between ambiguous streets, inferred point or whole-road substitute for an unspecified local measure.
- Original evidence, negative wording and original source timestamps remain intact.
- Keep Bonn's revision and the original 34-case selection/results unchanged.

## Review focus

- A sibling section must not consume another section's anchors.
- A shared extension or additional boundary must not become falsely precise after splitting.
- Quotation punctuation and abbreviations must retain sentence semantics.
- A previous sentence's Hannover qualifier must not license a regional location in the next sentence.
- Retained evidence must be reparsed without pretending a fresh source fetch occurred.

## Task 1: Repair mapper boundaries

**Files:** `server/political-context/services/risLocation.js`, `tests/unit/risLocation.test.js`.
**Interface:** Existing `enrichRisLocations(records, options)` remains unchanged.

- [x] Add failing tests using the unchanged Soden/Ecker evidence, reversed siblings, quoted Clemens/Feuerwehr evidence, abbreviations and the shared-boundary/regional-scope controls above.
- [x] Run `npm test -- --runInBand tests/unit/risLocation.test.js`; record expected failures before editing production code.
- [x] Limit internal section spans only at a validated independent section start. Keep the complete source quotation, unresolved siblings and constraints.
- [x] Share narrowly scoped sentence separation across ordinary document evidence and regional scope evaluation.
- [x] Run the full mapper suite and replay the two official sources with the real ATKIS data; verify geometry and text-only distinctions.
- [x] Add failing regressions for the second sample's compound `Fuß- und Fahrradweg` with one street and the public `Bemeroder Straße 73 – Abriss …` title. Keep true place lists, ranges, unknown endpoints and surrounding conjunctions protected. Implement only the isolated compound-conjunction exception and the explicit observed title-action separator; preserve the complete source text.
- [x] Address the PR review with observed regressions for parenthetical qualifiers, neutral leading `von`, terminal `ggf.`, semicolon scope and a following independent section clause. Keep qualification bounds separate from endpoint bounds; obtain independent targeted follow-up review.

## Task 2: Publication and diagnostic evidence

**Files:** `scripts/refresh-ris-catalogues.js`, `tests/unit/refreshRisCatalogues.test.js`, the existing wording in `js/ua.ris-record-view.js` and `js/ua.political-context.js`, the existing `tests/unit/risPoliticalReferences.test.js` wording assertions, a separate report under `docs/qa/`.
**Interface:** Existing location revision and retained-evidence reassessment path.

- [x] Add a regression proving revision-7 retained evidence receives the new assessment without advancing source timestamps; then raise Hannover's revision to 8.
- [x] Read and classify the fixed second traffic sample, keeping selection provenance and source hashes. Replay against baseline and repaired mapper.
- [x] Clarify the existing unresolved/unavailable messages so that a missing assignment is not presented as proof of no geographical reference; adapt the existing wording assertion.
- [x] Record mapper and refresh results, preserve the original audit, inspect the complete diff independently and submit one focused follow-up PR.
- [x] Verify the 32 mapped/partial traffic cases from the same fixed pool as a separate positive control on stored inputs, comparing exact location/geometry pairs without new official-source requests.
- [ ] Verify required CI before merging; verify the live original regression and the newly recovered Eckerstraße section after publication.
