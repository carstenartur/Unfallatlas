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
- [x] Review the focused diff and integrate after the actual CI checks pass.

### Task 2: Make live diagnostics execute and require fresh evidence

**Files:** `pom.xml`, `.github/workflows/live-pages-runtime-health.yml`, `scripts/run-live-documentation-qa.js`, focused tests in `tests/unit/`.

**Interfaces:** Preserve existing environment flags and the diagnostic's `diagnostic.json` (`healthy`) and live-link `command-result.json` (`status`) outputs.

- [x] Reproduce the Maven skip binding and missing-evidence success using the existing execution configuration and controlled child processes.
- [x] Explicitly enable the required Maven execution despite ordinary test skipping.
- [x] Remove stale evidence and require fresh successful reports when the corresponding checks were requested; make absent uploaded evidence fatal.
- [x] Verify meaningful missing/stale/malformed/unhealthy/success cases, then inspect the real workflow result after integration.

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

### Task 5: Migrate retained detail after a successful catalogue refresh

**Evidence:** PR #759 was reviewed, verified and merged as `36f8f45`. Pages run `42569998173` successfully deployed its immutable artifact. The public manifest and artifact bytes matched at location revision 4, but `hannover-sim:0001-2018` still stored `Hildesheimer Straße 9` beside the complete source title `9 - 15`. This was reproduced in the public UI and in the artifact, excluding browser cache as the cause.

**Cause:** A successful catalogue/history refresh with an individual unavailable detail places the prior record in `retainedDetails`. That path preserves its old location assessment, excludes it from the corrected parser, and still assigns the current global revision. The original migration test covered whole-source failure/backoff, not this per-record path.

**Files:** `scripts/refresh-ris-catalogues.js`, `tests/unit/refreshRisCatalogues.test.js`, `server/political-context/services/risLocation.js`, `tests/unit/risLocation.test.js`, and `docs/ris-catalogue.md`.

- [x] Reproduce the deployed case through the successful-collection/per-record-unavailable-detail path, from both revision 3 and the already published revision 4.
- [x] Reassess retained titles and selected document quotations consistently with the existing local migration; preserve verified official geometry, history, source clocks, coverage and unavailable/truncated evidence flags.
- [x] Advance to revision 5 so already published revision-4 records cannot bypass this correction.
- [x] Prove the complete `9-15` label replaces the old `9`, without claiming missing full text was recovered or inventing geometry.
- [x] Reassess every distinct saved title quotation and the available prior title, including records whose old parser recognized no title location; keep original evidence and regional scope separate.
- [x] Replay the complete verified 68,272-record Hannover artifact and cover the observed subtitle, postal-district and letter-compound boundaries with actual-title regressions.
- [x] Preserve a clearly identified petitioner's postal address as text without assigning or restoring a traffic-measure point at that contact address.
- [ ] Run focused regression tests, independent review, canonical verification and final-head CI before merging the narrow follow-up.
- [ ] Verify the actual new immutable artifact and public UI contain the corrected label; verify the final deployment health and nonpublishing release rehearsal separately.

### Task 6: Keep release screenshot evidence bound to its own site

**Evidence:** Nonpublishing release run `42570111196` checked out main `36f8f45`, created a local release-version commit, and completed its browser, document and Pages checks. The combined-profile lifecycle then correctly rejected all 21 screenshot sidecars because the Pages quality gate had replaced the same `_site` directory used earlier by E2E. The sidecars' manifest SHA was `ddc5ee3e83e0426f71ba87b82f3286463529e1a526d677d2c0cad8d3edf92e0a`; the replacement manifest SHA was `a26760e9d4a0e555d1dff94bc236f311b4edd785ef20ff9a9847d110c1b457d4`. Their data fingerprints matched, while the application fingerprints differed. The final release-site execution and release assets were not reached; no remote release or tag was created.

**Contract:** Keep the existing canonical acceptance command and strict sidecar/fingerprint validation. Isolate the public Pages profile's output when combined with the release profile so it cannot overwrite the canonical E2E/release tree. Do not regenerate or relabel receipts to conceal a changed artifact.

- [x] Reproduce the output-directory collision with the existing lifecycle-test harness and real filesystem evidence sentinels.
- [x] Configure separate Pages output for the combined release profiles using the existing output-directory property; preserve ordinary Pages publishing and the final canonical release output.
- [x] Verify the Pages gate does not mutate the E2E tree or its receipts, while real fingerprint mismatches still fail.
- [ ] Independently review the narrow fix and validate the combined final tree before integration.
- [ ] Run the existing nonpublishing release workflow on the final merged main and inspect its actual contract, artifacts and publishing-step dispositions.

## Decisions

The user already authorized continuing the repairs and previous integration work. These changes repair existing contracts; no new interaction design or data-source policy is introduced. Address ranges remain textual unless verified geometry exists. Root coordinates shared dependency installation and commits; workers edit only their assigned files.

## Implementation verification (9 November 2026)

All three implementation tasks passed independent review. The complete local `mvn -B -ntp verify` passed using the repository-pinned Java 25, Node 26.13.0 and npm 11.21.2. Java: 42 tests passed. Frontend unit: 4,632 passed, 11 skipped. Frontend integration: 135 passed. Performance: 7 passed. Browser and public-site acceptance remain hosted gates: the official browser download returned a 195-byte HTML unavailable response in this local environment.

The original regional-qualifier and malformed-marker review findings were corrected and re-reviewed before integration. Public deployment, live report receipts and the release acceptance requirements above must still be verified separately.

## Published-record sample follow-up

A SHA-verified sample of 256 published Hannover records exposed additional title boundaries before merging: Jordanstraße 28A before a procedural subtitle, Eintrachtweg 1-15 before a procedural subtitle, and Brockfeld 65 before the postal suffix 30539 Hannover. Regressions now use these actual titles and the actual Gazetteer; Hildesheimer Straße 9-15 also demonstrates the previous truncation to 9.

The parser preserves original spaced en/em dashes only for measure parsing and accepts the observed procedural subtitle cues Einleitungsbeschluss/Aufstellungsbeschluss after a complete address. Ambiguous or unknown range endpoints remain unresolved. A five-digit postal code is accepted as a suffix only when followed by exactly the active city. This does not extend regional city qualification. The focused parser suite passed 153 tests; the combined build and final scoped review must confirm this final fix before integration.

## First deployment evidence and retained-detail follow-up

The final PR #759 tree passed canonical Maven verification (42 Java, 4,652 frontend unit, 135 integration and 7 performance tests) and independent review. All 18 applicable hosted checks passed; two PR-only skips were expected. The merged main commit `36f8f45` deployed successfully in Pages run `42569998173`. The actual public build manifest, both RIS manifests, HTML and all 95 script sources referenced by the browser matched the immutable artifact byte-for-byte.

The resulting live-health run `42571590592` actually executed the required npm diagnostic despite `-DskipTests=true`, produced a fresh literal `healthy: true` receipt and numeric link-check `status: 0`, and passed 21 screenshot plus 6 published-link checks. Its deployment fingerprint matches that Pages artifact. This confirms Task 2, not address migration or a complete political-search network audit.

Direct public UI and artifact inspection then exposed the retained-detail migration defect addressed by Task 5. Actual document quotations also confirm that exact numbers such as Lange Laube 20 (`0557-2024`) and Ohestraße 6 (`region-hannover-ris:vo:1007559`) already worked, while Schulenburger Landstraße 167-225 (`0142-2022F1`) is newly retained by the corrected parser. These are verified stored quotations, not evidence that missing full documents were re-fetched.

## Complete retained-catalogue replay and release-output isolation

An offline replay of all 68,272 records from the verified Pages artifact exercised a successful catalogue collection with unavailable individual details. It retained the original source clocks, source statuses, official geometry and record count. The first complete replay identified 57 address-record changes: 18 newly retained complete expressions, four corrected numeric prefixes, 26 addresses lost at title-dash boundaries, eight lost before postal-district/prose suffixes, and one missing full letter range. The observed boundary cases now have literal original-title regressions; `20 A-F` and `3A+B` require their complete authoritative address key for geometry. The final review additionally identified a petitioner's postal address as contact evidence, requiring text retention without a measure point, including during migration.

The release-output fix uses `.build/release-pages-qa` only when the release profile is active; standalone Pages still uses `_site`. The actual combined Maven effective POM and a real strict build sequence confirmed that Pages QA leaves the canonical site and screenshot receipts unchanged, and that the final canonical rebuild is byte-identical. Focused regression tests still reject an intentionally changed canonical manifest. Independent review approved the three-file release patch; the combined final Maven run, final-head CI and hosted nonpublishing rehearsal remain separate gates.

The existing release contract permits a website bundle without generated RIS snapshots. The release workflow does not automatically import the newly published catalogue. Public revision-5 data acceptance must therefore be verified against the actual Pages artifact and public UI, separately from release-code and bundle qualification.
