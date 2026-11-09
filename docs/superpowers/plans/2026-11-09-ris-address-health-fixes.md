# RIS address preservation and live publication checks

> **For agentic workers:** Use `superpowers:subagent-driven-development` for the independent corrections and review before integration.

**Goal:** Preserve house-number evidence in council documents and make the existing live-publication check execute and fail when its evidence is missing.

**Architecture:** Keep the existing shared RIS location parser, snapshot format and renderer. Extend address parsing conservatively; retain unsupported address geometry as textual evidence. Keep Maven as the single owner of the existing live-documentation workflow.

**Tech Stack:** Existing CommonJS JavaScript, Jest, Maven and GitHub Actions.

**Spec:** User instruction of 9 November 2026; existing `docs/ris-catalogue.md`, `docs/release-checklist.md` and `docs/word-compatibility-release-check.md`.

## Global constraints

- Preserve exact street keys, house-number suffixes, evidence and existing map-precision safeguards.
- Do not infer a range midpoint, invent address coordinates or substitute an entire street for an unknown address.
- Regional locations still require a direct, same-sentence Hannover qualification; exclude contact and meeting addresses.
- Use the existing Maven profiles and pinned runtime/dependencies; no parallel CI build implementation.
- Only merge after review and successful checks on the actual final PR commit.
- Never represent a skipped diagnostic, generated Word receipt or historical deployment as current successful acceptance.

## Review focus

- Address ranges, slash expressions, suffixes, abbreviation punctuation and adjacent prose must retain their complete meaning.
- A numeric prefix must never be geocoded when the rest of the house number was not parsed.
- Regional addresses outside Hannover must not match same-named city streets.
- Missing, stale, malformed or unhealthy diagnostic evidence must fail the live check.
- External source outages must not replace a complete published catalogue with an incomplete or empty one.

### Task 1: Preserve address evidence

**Files:** `server/political-context/services/risLocation.js`, `scripts/refresh-ris-catalogues.js`, `tests/unit/risLocation.test.js`, `tests/unit/risSnapshot.test.js`, `tests/unit/refreshRisCatalogues.test.js`; update the existing catalogue documentation only if needed.

**Interfaces:** Keep the existing location API and snapshot format. Output address labels and source evidence unchanged in meaning, with geometry only when supported by verified address data.

- [x] Add failing regressions for `12-14`, `12 bis 14`, `12/14`, `Nr.12`, `Hausnr. 12`, regional direct-city qualifiers and snapshot retention.
- [x] Run the existing parser tests and the added cases; confirm the new cases fail because locations are missing.
- [x] Extend the shared address-tail parsing and the direct-city qualifier consistently; retain conservative geometry behavior.
- [x] Advance the location assessment revision and prove existing revision-3 snapshots are reassessed without changing their source timestamps or claiming unavailable detail text was recovered.
- [x] Run parser/snapshot regressions and the full frontend suite; report any environment limitation separately.
- [ ] Review the focused diff and integrate after the actual CI checks pass.

### Task 2: Make live diagnostics execute and require fresh evidence

**Files:** `pom.xml`, `.github/workflows/live-pages-runtime-health.yml`, `scripts/run-live-documentation-qa.js`, focused tests in `tests/unit/`.

**Interfaces:** Preserve existing environment flags and the diagnostic's `diagnostic.json` (`healthy`) and live-link `command-result.json` (`status`) outputs.

- [x] Reproduce the Maven skip binding and missing-evidence success using the existing execution configuration and controlled child processes.
- [x] Explicitly enable the required Maven execution despite ordinary test skipping.
- [x] Remove stale evidence and require fresh successful reports when the corresponding checks were requested; make absent uploaded evidence fatal.
- [ ] Verify meaningful missing/stale/malformed/unhealthy/success cases, then inspect the real workflow result after integration.

### Task 3: Recover transient published-snapshot responses

**Files:** `scripts/refresh-ris-catalogues.js`, `tests/unit/refreshRisCatalogues.test.js`.

**Evidence:** The scheduled build failed restoring a verified published links asset with HTTP 503; a direct retry of that same URL returned HTTP 200. The source's inconsistent Bonn pagination must still reject incomplete replacement data.

**Interfaces:** Keep `fetchPublishedFile` private and preserve `refreshRisCatalogues` and the snapshot schema. Change only handling of HTTP 502, 503 and 504 before reading successful response bytes.

- [x] Reproduce a single transient 503 for a required v2 links asset with a real fixture snapshot and injected HTTP response boundary; verify the baseline cannot restore it.
- [x] Allow at most three requests per file, delaying 500 ms then 1,000 ms. Cancel each failed response body and use a fresh 20-second request timeout.
- [x] Preserve URL, redirect, credential and cache restrictions. Do not retry other HTTP statuses, rejected requests, invalid JSON/gzip, oversized bodies or wrong hashes.
- [x] Verify recovered snapshots retain their exact source clocks/coverage, persistent 503 still fails after three requests, ordinary 404 is not retried, and integrity failures remain fatal.
- [x] Run the refresh suite and review the focused diff before integration.

### Task 4: Publication and release follow-through

- [x] Inspect the failed current-data build and preserve its exact source-failure evidence.
- [ ] Use the existing verified build/deployment path after integration; verify the actual public manifest and relevant address/search behavior.
- [ ] Review the current release dry-run prerequisites and run the existing nonpublishing workflow when a supported authorized entry point is available.
- [x] Keep real Microsoft Word and domain-review requirements explicitly open until their actual evidence is available.

## Decisions

The user already authorized continuing the repairs and previous integration work. These changes repair existing contracts; no new interaction design or data-source policy is introduced. Address ranges remain textual unless verified geometry exists. Root coordinates shared dependency installation and commits; workers edit only their assigned files.

## Implementation verification (9 November 2026)

All three implementation tasks passed independent review. The complete local `mvn -B -ntp verify` passed using the repository-pinned Java 25, Node 26.13.0 and npm 11.21.2. Java: 42 tests passed. Frontend unit: 4,632 passed, 11 skipped. Frontend integration: 135 passed. Performance: 7 passed. Browser and public-site acceptance remain hosted gates: the official browser download returned a 195-byte HTML unavailable response in this local environment.

The original regional-qualifier and malformed-marker review findings were corrected and re-reviewed before integration. Public deployment, live report receipts and the release acceptance requirements above must still be verified separately.

## Published-record sample follow-up

A SHA-verified sample of 256 published Hannover records exposed additional title boundaries before merging: Jordanstraße 28A before a procedural subtitle, Eintrachtweg 1-15 before a procedural subtitle, and Brockfeld 65 before the postal suffix 30539 Hannover. Regressions now use these actual titles and the actual Gazetteer; Hildesheimer Straße 9-15 also demonstrates the previous truncation to 9.

The parser preserves original spaced en/em dashes only for measure parsing and accepts the observed procedural subtitle cues Einleitungsbeschluss/Aufstellungsbeschluss after a complete address. Ambiguous or unknown range endpoints remain unresolved. A five-digit postal code is accepted as a suffix only when followed by exactly the active city. This does not extend regional city qualification. The focused parser suite passed 153 tests; the combined build and final scoped review must confirm this final fix before integration.
