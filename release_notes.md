Initial release

## Maintainer notes

### One-time enrichment-size baseline reseed (after PR #261)

`out/.enrichment-size-baseline.json` was intentionally cleared as part of the
context-data refactor in PR #261 because the new producer pipeline introduces
a `geometries` block (and, from producer 1.2.0 onwards, a tiled `out/ctxtiles/`
layout) used by the new map overlays. The +10 % CI gate in
`scripts/check-enrichment-size.js` would otherwise trip on the first real-data
enrich run.

After the first successful `enrich.yml` run on `main` with the current
producer has committed the regenerated per-city geojson + `ways_<city>.json`
files (and any `out/ctxtiles/<slug>/`), reseed the baseline once:

```sh
node scripts/check-enrichment-size.js --update
git add out/.enrichment-size-baseline.json
git commit -m "ci: reseed enrichment-size baseline after enrich.yml run"
```

From that point onwards, the +10 % growth budget is enforced again against
the new, post-enrichment sizes. Without this step the gate stays in
"every city is new → seed mode" and never blocks regressions.
