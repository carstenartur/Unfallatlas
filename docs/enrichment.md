# Enrichment Pipeline (Tier-B in CI)

> **TL;DR** Elevation, OSM road context and traffic-volume data are baked
> into the per-city files by GitHub Actions. The web application loads
> them as plain GeoJSON properties — no runtime fetches, no server, no
> per-request computation.

## Why CI, not the browser

The repository already runs a preprocessing tier in GitHub Actions
(`generate-and-commit.yml` builds `out/output_all_years_<city>.geojson`
via `convertAmt2gmaps.sh`, `fetchpoi.yml` writes
`out/poi_<city>.geojson`). Attaching elevation / OSM / traffic context
to the same files keeps the web app a pure static asset, removes the
need for an always-on enrichment service, and makes every enrichment
diffable and revertable through the normal commit/PR flow.

## Where it runs

* `scripts/enrich_geojson.js` — core enrichment script. Idempotent;
  pre-existing enrichment fields are stripped at the start of each
  run, so re-running on already-enriched files produces a stable
  result.
* `scripts/check-enrichment-size.js` — CI gate. Compares the gzipped
  size of every per-city `out/output_all_years_<city>.geojson`
  against `out/.enrichment-size-baseline.json` and fails the workflow
  when growth exceeds the documented threshold (default **10 %**).
* `.github/workflows/generate-and-commit.yml` — runs enrichment +
  size-check after the converter and before `check-city-rollout.js`.
* `.github/workflows/enrich.yml` — standalone wrapper
  (`workflow_dispatch` + monthly `schedule`) for refreshing only the
  enrichment when DEM tiles or traffic datasets change.

## What ends up in the files

Per-feature properties (all optional, all dropped when undefined):

| Field | Type | Source | Notes |
| --- | --- | --- | --- |
| `matched_way_id` | string | OSM | Stable OSM way id of the road segment that the accident snapped to. Foreign key into `ways_<city>.json`. |
| `road_context_source` | string | OSM | Provenance tag, currently always `"osm"`. |
| `elevation_m` | number | DEM | Metres above sea level, 1 decimal. |
| `slope_percent` | number | DEM | Signed local slope at the accident point, 1 decimal. |
| `slope_abs_percent` | number | DEM | `Math.abs(slope_percent)`, 1 decimal. |
| `slope_class` | string | derived | `flat \| gentle \| moderate \| steep \| very_steep`. |
| `slope_source` | string | DEM | e.g. `"SRTM30"`, `"DGM1"`. |
| `slope_confidence` | string | DEM | Provider-specific confidence label. |
| `traffic_proxy_class` | string | traffic | `low \| medium \| high \| very_high`. |

Per-way attributes live in the **companion file** `ways_<city>.json`
keyed by `matched_way_id`. The accident features only carry
`matched_way_id`, so the *initial* per-city GeoJSON payload is
essentially the same size it was before enrichment.

| Way field | Type | Source |
| --- | --- | --- |
| `highway` | string \| int code | OSM |
| `maxspeed` | number | OSM |
| `lanes` | number | OSM |
| `surface` | string \| int code | OSM |
| `cycleway` | string \| int code | OSM |
| `osm_incline` | string | OSM |
| `road_slope_percent` | number | DEM |
| `traffic_volume_value` | number | traffic |
| `traffic_volume_unit` | string | traffic |
| `traffic_volume_year` | number | traffic |
| `traffic_volume_source` | string | traffic |
| `traffic_volume_confidence` | string | traffic |

High-cardinality categorical fields (`highway`, `surface`, `cycleway`)
are written as **short integer codes**. The lookup tables live at the
FeatureCollection's top level under `properties.enrichmentDicts`, e.g.

```json
{
  "type": "FeatureCollection",
  "properties": {
    "enrichmentDicts": {
      "highway": ["residential", "secondary", "primary"]
    }
  },
  "features": [ ... ]
}
```

`UA.contextLayers.resolveWay(state, wayId)` resolves them back to
strings on read. This dictionary encoding cuts the per-feature byte
cost of categorical road tags by ~70 % vs. inline strings.

### Sidecar `*.enrichment.meta.json`

Per-file dataset-wide attribution:

```json
{
  "schemaVersion": 1,
  "enrichmentScriptVersion": "1.0.0",
  "citySlug": "bonn",
  "generatedAt": "2026-01-15T03:14:15.000Z",
  "sources": {
    "osm":     { "source": "OpenStreetMap (Overpass)", "extractDate": "2026-01-10" },
    "dem":     { "source": "SRTM30", "resolutionM": 30 },
    "traffic": { "source": "BASt SDV", "datasetVersion": "2024" }
  },
  "counts": { "features": 1234, "matchedToWay": 1100, "withElevation": 1234, "withTrafficProxy": 410, "ways": 320 },
  "dictFields": ["highway", "surface"]
}
```

The web app loads it lazily, **only when the Context-Layers panel is
opened**, behind a `requestIdleCallback` guard.

## Slope classification

| `slope_class` | Range (`abs(slope_percent)`) |
| --- | --- |
| `flat`        | ≤ 2 % |
| `gentle`      | ≤ 4 % |
| `moderate`    | ≤ 6 % |
| `steep`       | ≤ 10 % |
| `very_steep`  | > 10 % |

## Traffic proxy classification

`traffic_proxy_class` is derived from the DTV (Durchschnittliche
tägliche Verkehrsstärke, vehicles/day) of the matched way:

| `traffic_proxy_class` | Range (DTV vehicles/day) |
| --- | --- |
| `low`         | ≤ 1 000 |
| `medium`      | ≤ 5 000 |
| `high`        | ≤ 15 000 |
| `very_high`   | > 15 000 |

## Allowed `*_source` values

* `road_context_source`: `osm`
* `slope_source`: `SRTM30`, `DGM1`, plus any other identifier
  the DEM provider configures.
* `traffic_volume_source`: `BASt SDV`, plus city-specific Zählstellen
  identifiers where the data is licensable for redistribution.

## Performance budget

Enforced **mechanically** by `scripts/check-enrichment-size.js`:

* GitHub Pages serves `*.geojson` gzipped.
* Baseline gzipped sizes are committed in
  `out/.enrichment-size-baseline.json`.
* Default growth budget per city: **+10 %**. Fails the CI workflow
  when exceeded; rerun with `node scripts/check-enrichment-size.js
  --update` if the bloat is intentional and approved.

The split of per-way attributes into `ways_<city>.json` (loaded only
when the user toggles a context layer) is what makes the budget easy
to keep — most accidents share the same way, so duplicating road
attributes per accident would have been wasteful.

## Web-app integration

* `js/ua.context_layers.js` — the **only** module that knows about the
  enrichment files at the loader level.
  - `UA.contextLayers.detect(geojson)` probes a sample of features and
    returns the list of optional fields the city actually has.
  - `UA.contextLayers.loadAtIdle(ctx, cityRaw)` schedules the lazy
    fetch of `ways_<city>.json` + `*.enrichment.meta.json` at idle.
  - `UA.contextLayers.resolveWay(state, wayId)` maps int-coded
    categoricals back to strings via the dictionaries.
* The hot-path loader `js/ua.data_v2.js` is **unchanged**. Reading
  per-feature enrichment fields where they exist (e.g.
  `feature.properties.elevation_m`) is a free `?.` for any UI module
  that wants them.
* Existing pre-flight invariants, exports and rendering paths take no
  dependency on enrichment fields.

## "Kontext nicht Ursache"

The same disclaimer that already governs the Dunkelziffer note
(`UA.DARK_FIGURE_NOTE` in `js/ua.export_v2.js`) applies to every
enriched field: **a steep slope, a busy road, or a particular road
class is *context*, not a cause**. The enrichment exposes the local
environment of an accident; causal attribution remains a manual
analytical step in the Maßnahmen-Workflow.

## Pluggable providers

`scripts/enrich_geojson.js` reads its source data from offline files
located via env vars:

* `ENRICH_OSM_DATA_DIR`     → `osm_<city>.json`
* `ENRICH_DEM_DATA_DIR`     → `dem_<city>.json`
* `ENRICH_TRAFFIC_DATA_DIR` → `traffic_<city>.json`

When a directory is missing, that stage is silently skipped — every
field is optional. This keeps the workflow working when a single
source is temporarily unavailable, and makes the script trivial to
run locally with hand-crafted fixtures (see
`tests/unit/enrichGeojson.test.js`).

## Source data licensing

The schema's `*_source` fields are designed for **selective omission**.
A city without licensable counts simply ships only
`traffic_proxy_class` (or omits the traffic stage entirely). Always
verify each source's redistribution clause before committing a new
dataset to the public repo.
