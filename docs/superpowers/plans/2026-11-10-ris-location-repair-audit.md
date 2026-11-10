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

## Follow-up: include catalogue restoration in the publication time budget

PR #774 was merged as `4fbf9c235405e863105ccfc6ab9f941e1dfab890`; all 14 executed CI checks passed. The first location-repair publication, run `42820266666` on the earlier merge, nevertheless failed when its refresh subprocess reached the unchanged 65-minute Pages limit. The command began at 13:04:26.947 UTC, its first Hannover source progress appeared at 13:15:48.952, and it was terminated at 14:09:27.120 while fetching documents. The provider's 58-minute and worker's 60-minute limits begin only after restoring and validating the previous catalogue, so neither had expired. The same run also failed to save its pre-sharding source cache.

1. Pass an explicit Pages refresh budget of 65 minutes through a validated CLI option. Measure its origin monotonically from refresh entry, independently of the source evidence date.
2. At the actual collection call, deduct elapsed restoration and preparation time. Retain five minutes for finalization and two minutes for worker completion. Combine the remaining source time with the existing per-source limit and an explicitly supplied `maxDurationMs`; do not widen either. Bound the worker by its remaining window as well.
3. If the source window is already exhausted, use the existing controlled fallback path without starting fresh source work. Preserve standalone semantics when the new option is absent, as well as manual checkpoint recovery and source timestamps. Keep request limits, the outer SIGTERM, the 120-minute workflow limit and its existing reserve.
4. Reproduce the failure with a simulated restoration delay, then cover budget exhaustion, explicit source limits and fixed source dates. Run focused regression suites and obtain an independent review before integration.
5. Verify the real publication and the reported location after deployment. The earlier successful 109,560-record run took approximately 78.4 seconds between its last document progress and publication of the completed snapshot; the five-minute finalization reserve exceeds that measured duration without claiming a bound for arbitrary future datasets.
