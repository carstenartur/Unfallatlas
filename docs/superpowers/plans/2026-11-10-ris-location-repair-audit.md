# RIS location repair and diagnostic sample

## Goal and scope

Restore reliably evidenced locations lost by the house-number parser and inspect a reproducible sample of still-unmapped council records against their official sources. The reported regression is Hannover SIM 15-1782/2019 F1: `Gustav-Adolf-Straße 6 -bearbeitet.` incorrectly looks like an unfinished numeric range.

Keep source quotations, address precision, ambiguity checks and original verification times. Never manufacture coordinates or widen a precise measure to an entire street to improve counts. Regional records require evidence within the city covered by the gazetteer.

## Tasks

1. Add failing regression cases in `tests/unit/risLocation.test.js`, then repair trailing prose punctuation in `server/political-context/services/risLocation.js`. Preserve valid compound numbers and reject unfinished ranges. Verify the real official quotation and checked ATKIS address.
2. Review a deterministic diagnostic sample across four city failure reasons and the regional gazetteer limitation (target 36; final 34 because the fixed pool contains only five distinct unverified-name families). Store reproducible selection metadata and a compact audit report. Re-run the sample after the fix; investigate common additional extraction failures, with focused regression tests for any further repairs.
3. Inspect source checkpoints and `scripts/refresh-ris-catalogues.js` so corrected parsing applies to retained source evidence and the next publication. Increase the Hannover location revision when required and cover migration/freshness behavior in `tests/unit/refreshRisCatalogues.test.js`.
4. Run the relevant provider, mapper, refresh and snapshot suites, inspect the complete diff independently, then submit one focused pull request. Verify required CI before integration and check the published data for the reported record after deployment.

## Validation and evidence

- Red/green parser regression tests and existing address-range/ambiguity tests.
- Provider tests if paragraph or line-break extraction changes.
- Refresh tests proving old records are reassessed without inventing fresh source dates.
- Before/after replay using cached official HTML and the repository gazetteer.
- Diagnostic sample results distinguish absent location, missing source text, parser failures, ambiguity and outside-city records; its quotas are not a population estimate.
- Existing repository CI and storage budget remain the integration gate.

## Baseline

Main `3bb3e77e6244e442e6b4ecb6c4f23006c418bca8`; isolated branch `fix/ris-location-prose-audit`. Public data initially contained 109,560 records, 6,771 with geometry (snapshot checked 2026-11-10). Public counts may change during the repair and must be rechecked before reporting deployment.

## Follow-up: preserve import progress across publication runs

PR #773 was merged as `038fa8d730212da7769fe7f2986099b32022e85a`. Publication inspection then found two failed source-cache saves despite successful action steps. The pinned cache action's directory traversal reproduces a stack overflow for a large flat directory, matching the observed warning before archival. Without a durable save, later import runs can repeatedly spend their budget on the same early years.

1. Reproduce the failure in the exact pinned `actions/cache` bundle with synthetic directory entries; distinguish this mechanism from a measured production file count.
2. In the isolated `fix/ris-source-cache-shards` worktree, add failing storage-contract tests, then write new parsed entries into two-character hash-prefix subdirectories. Preserve flat-cache reads, metadata clocks, envelope validation, request deduplication and atomic replacement. Keep checkpoint formats, workflow paths and cache keys unchanged.
3. Verify source-cache, SIM history/search and retained-evidence tests; obtain an independent review. Update the audit's evidence-scope and source-spelling distinctions without changing the fixed sample or its counts.
4. Submit the small cache follow-up, verify required CI, and check the actual cache-save and publication results. Do not describe a green action step alone as a successful save.
