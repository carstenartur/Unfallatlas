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
  (`workflow_dispatch` + weekly `schedule`) for refreshing only the
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

### `ways_<city>.json` schema (v2)

The companion file uses a small wrapper object so a new
**`geometries`** block can ship side-by-side with the per-way attribute
table. The loader (`js/ua.context_layers.js`) accepts both this v2
shape and the legacy flat `{ "<wayId>": { …attrs } }` shape, so older
caches stay readable while a new producer rolls out.

```json
{
  "schemaVersion": 2,
  "ways": {
    "12345": { "highway": 0, "maxspeed": 30, "road_slope_percent": 4.2 }
  },
  "geometries": {
    "12345": [50.12345, 7.98765, 50.12350, 7.98770, 50.12360, 7.98780]
  }
}
```

`geometries[wayId]` is a **flat `[lat, lon, lat, lon, …]` array** of
5-decimal floats (≈ 1.1 m precision), pre-generalised once at
enrichment time with Douglas–Peucker (default tolerance ≈ 3 m, raise
via `opts.geomToleranceM` in `enrichCity`). The flat encoding gzips
roughly 2× smaller than the equivalent `[{lat,lon}, …]` array. The
block is **optional** — when the OSM producer cannot supply a
polyline, the key is omitted entirely; the front-end's
"Straßensteigung" / "Verkehrsbelastung" map overlays then stay empty
and the chip filters keep working unchanged.

> **Scope of the road-context layers.**
>
> *Up to PRODUCER_VERSION 1.1.x* the OSM producer + enrichment step
> only emitted ways an accident snapped to. The road-overlay legend
> therefore only coloured ~1 % of the city's streets — confusing for
> users who saw "Straßensteigung" but only ~12 short segments lit up.
>
> *PRODUCER_VERSION 1.2.0 ("full road network", schemaVersion 3)*
> ships **every** OSM way inside the city bbox. To keep the gzipped
> CI-size budget intact, the per-way table is split into per-Z/X/Y
> slippy-map tiles under `out/ctxtiles/<slug>/` (Z=13 ≈ 5 km × 3 km
> in DE; ≤ ~150 tiles per city, even Berlin). The browser only
> fetches the tiles intersecting the current map viewport — see
> `UA.contextLayers.loadTilesForBbox` in `js/ua.context_layers.js`.
> The on-disk `ways_<slug>.json` is then a thin **v3 envelope**:
>
> ```json
> { "schemaVersion": 3, "coverage": "full",
>   "tileIndexUrl": "out/ctxtiles/bonn/index.json" }
> ```
>
> The loader continues to accept the legacy v1 (flat) and v2
> (`{schemaVersion:2, ways, geometries}`) shapes for unchanged
> back-compat with checked-in `out/` snapshots and third-party
> tooling — see `SUPPORTED_WAYS_SCHEMA_VERSIONS = [1,2,3]`.
>
> The "**nur auf gematchten Straßen**" chip in the filter panel is
> **independent** of the layer's coverage: it filters accident
> points (those with `matched_way_id` set) regardless of how many
> ways the overlay layer happens to render.

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

### Sidecar `*.enrichment.meta.json` (aktueller Stand: v3)

Per-file dataset-wide attribution:

```json
{
  "schemaVersion": 3,
  "enrichmentScriptVersion": "1.0.0",
  "citySlug": "bonn",
  "generatedAt": "2026-01-15T03:14:15.000Z",
  "tileIndexPath": "ctxtiles/bonn/index.json",
  "sources": {
    "osm":     { "source": "OpenStreetMap (Overpass)", "producerVersion": "1.2.0", "extractDate": "2026-01-10", "coverage": "full" },
    "dem":     { "source": "SRTM Local Tiles",         "producerVersion": "1.1.0", "resolutionM": 30 },
    "traffic": { "source": "OSM-highway-proxy",        "producerVersion": "1.0.0", "datasetVersion": "1.0.0" }
  },
  "counts": { "features": 1234, "matchedToWay": 1100, "withElevation": 1234, "withTrafficProxy": 410, "ways": 320, "fullWays": 22000, "contextTiles": 49 },
  "dictFields": ["highway", "surface"]
}
```

The web app loads it lazily, **only when the Context-Layers panel is
opened**, behind a `requestIdleCallback` guard.

The sidecar — and the companion `ways_<city>.json` — are only emitted
when at least one provider produced data. A run with no providers
configured rewrites the GeoJSON in place but never touches the
sidecar files, so the weekly `enrich.yml` cron stays a true no-op
until provider data is wired up. (For the same reason, the cron's
commit step ignores meta-only diffs.)

Each per-source block also embeds a `producerVersion` field that is
mirrored from the corresponding `osm_<city>.json` /
`dem_<city>.json` / `traffic_<city>.json` payload (which now also
carries `producerVersion` at the top level). This lets QA jobs assert
the deployed producer version with a one-liner — e.g.
`jq -r '.producerVersion' out/osm_bonn.json` — without falling back to
node-count heuristics.

## Slope classification

| `slope_class` | Range (`abs(slope_percent)`) |
| --- | --- |
| `flat`        | ≤ 2 % |
| `gentle`      | ≤ 4 % |
| `moderate`    | ≤ 6 % |
| `steep`       | ≤ 10 % |
| `very_steep`  | > 10 % |

> **Einheit:** Die Schwellwerte oben werden auf **Prozent** angewendet,
> nicht auf das Verhältnis. Eine 5 %-Steigung ist `road_slope_percent = 5`,
> nicht `0.05`. `tests/unit/enrichGeojson.test.js` pinnt diesen Vertrag
> mit parametrischen Tests und einem expliziten Regressions-Test für den
> 0.05-Fall.

## Slope diagnostics (PR-berlin-slope-qa)

Drei zusammenhängende Sicherungsnetze stellen sicher, dass die
Slope-Klassifizierung pro Stadt plausibel bleibt:

1. **Per-City-Plausibilitätsprüfung.**
   `scripts/slope-plausibility.json` listet pro Stadt eine Obergrenze
   für `slope.verySteepShare` und eine Untergrenze für
   `slope.flatGentleShare`. `npm run validate:slope-plausibility`
   liest jede `out/output_all_years_<slug>.enrichment.meta.json` und
   bricht die CI ab, wenn die Werte nicht im Erwartungsbereich liegen.
   Berlin (flach) darf z. B. höchstens 5 % `very_steep` enthalten,
   Stuttgart bis zu 25 %. Städte ohne Eintrag fallen auf `_default`
   (30 % / 30 %) zurück.

2. **Diagnose-Report `npm run qa:slope`.**
   Erzeugt `out/qa/slope_<slug>.json` und `.csv` für eine angegebene
   Viewport-Bbox (Default: Berlin Mitte, 52.521463 / 13.379320, z=16).
   Wenn die Producer-Eingaben (`out/osm_<slug>.json` und ein DEM-
   Tiles-Verzeichnis via `ENRICH_DEM_TILES_DIR`) verfügbar sind, läuft
   `_sampleAlongPolyline` mit dem lokalen DEM-Sampler erneut, sodass
   der Report die *exakten* Zahlen des Producers zeigt. Andernfalls
   wird auf den Tile-Layer (`out/ctxtiles/<slug>/`) zurückgegriffen.
   Das CI-Workflow `.github/workflows/enrich.yml` lädt diesen Report
   für Berlin und Bielefeld als Artefakt hoch.

3. **Optionales Debug-Overlay im Frontend.**
   `?mapLayer=slope&debugSlope=1` zeigt pro Straße `road_slope_percent`
   als permanenten Tooltip in der Karte. Mit `&debugSlopeSamples=1`
   können (sobald ein zukünftiger Producer DEM-Sample-Punkte in
   `out/ctxtiles/<slug>/debug/<x>/<y>.json` schreibt) auch die
   einzelnen DEM-Abtastpunkte gerendert werden. Das Overlay ist hinter
   Query-Params verborgen und beeinflusst die Produktion nicht.

### Slope-Screenshots (derzeit ausgesetzt)

Die früheren Berlin-/Bielefeld-Szenarien wurden aus dem kanonischen
Screenshot-Lauf entfernt: Sie warteten nicht auf Context-Geometrie und
zeichneten deshalb Empty-State-Karten als vermeintlichen Slope-Nachweis auf.
Die Reaktivierung erfolgt erst mit einem versionierten Dataset oder Fixture
und Black-box-Prüfungen für Overlay-Pixel, Legende und Debug-Tooltips
(Tracking: #400).

Die zugehörige Plausibilitätsprüfung kann jederzeit isoliert laufen:

```bash
npm run validate:slope-plausibility   # CI-Gate
npm run qa:slope                      # Berlin-Diagnose-Report
node scripts/qa-slope-report.js --city bielefeld
```

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
    Bei `schemaVersion >= 3` liest der Loader den Manifest-Pfad aus
    `tileIndexPath` (Sidecar) und lädt daraus viewport-lazy die
    tatsächlichen Z/X/Y-Tiles.
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

<a id="matched-only-disclaimer"></a>

## Datenausschnitt der Karten-Layer (Straßennetz vs. matched-only Signal)

> **Kanonischer Disclaimer — referenziert von `WERKBANK_V2.md` und
> `docs/architecture.md`.** Beim Aktualisieren bitte ausschließlich
> diesen Absatz pflegen, damit die Beschreibung nicht auseinanderdriftet.

Mit `PRODUCER_VERSION = '1.2.0'` und `schemaVersion: 3` zeigen die
Karten-Layer („Straßensteigung", „Verkehrsbelastung") **das vollständige
OSM-Straßennetz im BBox der Stadt** an, nicht mehr nur die im
Enrichment-Lauf gematchten Wege. Technisch wird das Netz in
Slippy-Tiles (`out/ctxtiles/<slug>/<x>/<y>.json`) ausgeliefert; der
Browser holt nur Tiles, die das aktuelle Viewport schneiden.

Inhaltlich gilt weiterhin: die *Datenquellen* hinter den Farbklassen
unterscheiden sich nach Wegtyp.

* **Verkehrsbelastung** stammt aus dem DTV-Proxy (Highway-Tag → Klassen-
  schätzung, ohne tatsächliche Zählungen). Jeder Weg im Netz bekommt
  damit einen Klassenwert, **kein** gemessener Verkehrswert.
* **Straßensteigung** wird per DEM für **alle** OSM-Wege im v3-Kontext-
  netz berechnet — der DEM-Producer (`scripts/producers/dem_producer.js`,
  ab `PRODUCER_VERSION = '1.1.0'`) liest jede Way-Geometrie aus
  `osm_<slug>.json` (`wayGeometries`), tastet die Polylinie alle ~30 m
  über lokale SRTM-Tiles ab und schreibt den **Median der Segment-
  Steigungen** als `road_slope_percent` (Methode `median_segments`,
  robust gegen einzelne SRTM-Ausreißer auf kurzen Wohnstraßen). Im
  API-Fallback (`--use-api`) wird ersatzweise nur die Endpunkt-Steigung
  berechnet (Methode `endpoint`, `confidence: low`). Ways ohne
  berechenbares Signal (DEM-Lücke, Way < 5 m, etc.) erscheinen in der
  Steigungs-Legende als „kein Steigungssignal" und werden in neutralem
  Grau gezeichnet — die Polylinie ist sichtbar, aber ohne Farbklasse.
* Der Chip-Filter „Nur Unfallstrecken" (`ctxOnlyMatched`) ist eine
  **Filteroperation auf Unfallpunkten**, nicht auf den Karten-Layern.
  Er bleibt unverändert verfügbar und ist *unabhängig* von der
  Datenabdeckung der Layer.

Die Wahl, das volle Netz darzustellen statt nur gematchter Wege,
stützt die „Kontext nicht Ursache"-Disclaimer-Politik oben:
Anwender:innen sehen explizit, welche Straßen *kein* Slope-Signal
tragen (weil dort schlicht kein gemeldeter Unfall lag) statt sie
unsichtbar zu machen.

### Legacy / Kompatibilität

Ältere `ways_<city>.json` im Schema v1/v2 (matched-only) werden vom
Loader weiterhin akzeptiert; die Overlays zeichnen in diesem Fall nur
die im Enrichment-Lauf gematchten OSM-Wege (das ursprüngliche
„matched-only"-Verhalten). Beim nächsten geplanten Enrich-Lauf nach dem
Producer-Bump ersetzt CI diese Dateien durch die v3-Envelope plus
zugehöriges `out/ctxtiles/<slug>/`-Verzeichnis.

## Roll-out: regenerating `ways_<city>.json` for v2 geometries

The `geometries` block in the v2 schema is produced **only** when the
upstream OSM producer (`scripts/producers/osm_producer.js`) ships the
full per-way polyline. That capability landed with
`PRODUCER_VERSION = '1.1.0'` (pre-1.1.0 caches stored only the first +
last node and therefore cannot be turned into road overlays). The
producer's CI cache is keyed on `PRODUCER_VERSION`, so a normal
`enrich.yml` run after the bump will re-fetch from Overpass once and
backfill the new geometry table.

**QA checklist before merging a deploy that depends on the road
overlays:**

1. Confirm the latest `out/osm_<city>.json` was produced by
   `osm_producer.js` ≥ 1.1.0. The producer version is not embedded in
   the per-city file, so check either the `enrich.yml` run summary
   (`producerVersion` field of the OSM job log) or spot-check that any
   way under `.ways` has more than two entries in its `geometry`
   array — pre-1.1.0 caches stored only the first + last node. If the
   file is older, re-run `enrich.yml` (or its `osm` job); the cache
   key is bumped so it will refetch from Overpass once.
2. Re-run `node scripts/enrich_geojson.js` so each
   `out/ways_<city>.json` is rewritten with `schemaVersion: 2` and a
   non-empty `geometries` map. The script is idempotent, so re-running
   on already-enriched data is safe.
3. Spot-check one city in the browser: open
   `werkbank_v2.html?city=<slug>&mapLayer=slope,traffic` — the
   "Karten-Layer" control should appear top-left and the matched road
   segments should be colour-coded.

A fall-back is built in: a v1 (legacy flat) `ways_<city>.json` still
loads — popups and chip filters keep working — but the road-overlay
checkboxes stay disabled with a "(lädt …)" hint until a v2 file is
deployed. There is no client-side migration; the file must be
regenerated on the producer side.

The unit suite enforces the schema contract:

* `tests/unit/osmProducer.test.js` — full per-way geometry retained
  for indexed ways, dropped for everything else; `PRODUCER_VERSION`
  pinned.
* `tests/unit/enrichGeojson.test.js` — `enrichCity()` emits
  `schemaVersion: 2`, the `geometries` block, and the Douglas–Peucker
  generalisation; the v2 file shape round-trips on disk.
* `tests/unit/uaContextLayers.test.js` — loader accepts both v2 and
  legacy flat shapes and exposes `state.geometries`.

If any of those three suites starts failing on a producer-version bump
or schema change, treat it as a roll-out gate, not an isolated test
failure.



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

### Producers

The `osm_<city>.json` / `dem_<city>.json` / `traffic_<city>.json`
files are populated by per-source *producer* scripts that run as
preceding steps in `.github/workflows/enrich.yml`:

| Producer | Script | Source | Status |
| --- | --- | --- | --- |
| OSM     | `scripts/producers/osm_producer.js`      | Overpass `way[highway]`                | wired up |
| DEM     | `scripts/producers/dem_producer.js`      | SRTM Local Tiles (local, see below)    | wired up |
| DEM tiles | `scripts/producers/dem_tile_producer.js` | AWS Open Data SRTM HTTPS mirror (HGT) | wired up |
| Traffic | `scripts/producers/traffic_producer.js`  | OSM `highway` → DTV proxy              | wired up |

* **OSM** reads `cities.txt`, derives a bounding box from each
  `out/output_all_years_<city>.geojson`, queries the public Overpass
  API (`way[highway]` with `out tags geom;`), snaps every accident
  point to the nearest way (≤ 50 m by default) and writes
  `osm_<city>.json`. Since `PRODUCER_VERSION = '1.2.0'` the on-disk
  payload carries `coverage: "full"` and a top-level `wayGeometries`
  table holding the **full** polyline of every way in the city
  bbox (not only the matched ones), which the DEM producer consumes.
* **DEM** (default: local SRTM tile sampling, see below) deduplicates
  accident points at 5 dp (≈ 1.1 m), then for each unique point
  looks up elevation from a locally-cached SRTM HGT tile. The slope
  is derived from the adjacent pixel gradient within the tile (1
  pixel ≈ 30 m for SRTM1) in a **single** memory read — no network
  calls. When the OSM producer's output is available, per-way
  `road_slope_percent` is computed for **every** way in
  `wayGeometries` (i.e. the full v3 city-bbox network, since
  `PRODUCER_VERSION = '1.1.0'`) by sampling the polyline every ~30 m
  via the same tile lookup and taking the **median** of the
  per-segment grades. The legacy `--use-api` path still uses
  endpoint-only slopes (low confidence) to stay inside the
  Open-Meteo free tier. The workflow's `dem` cache key includes the
  OSM producer version, so any future OSM coverage upgrade
  auto-invalidates the DEM cache; per-city resume additionally falls
  back to a freshness check that regenerates a stale matched-only
  `dem_<slug>.json` when its `wayElevations` covers <50 % of the
  current `osm_<slug>.json`'s `wayGeometries`.
* **Traffic** is intentionally a *proxy* derived from each matched
  OSM way's `highway` class (motorway → ~50 000 DTV, residential →
  ~800, etc.) — see `HIGHWAY_DTV_PROXY` in
  `scripts/producers/traffic_producer.js`. Real licensable counts
  (BASt SDV, city Zählstellen) can be plugged in later by a parallel
  producer that overwrites `traffic_<slug>.json`. Output is marked
  `source: "OSM-highway-proxy"`, `confidence: "low"` so the proxy
  nature is explicit downstream.

Each producer's CI step is wrapped in `actions/cache` keyed on the
producer version + the ISO week, so upstream APIs are hit at most
once per week. The traffic key additionally includes the OSM key, so
a refreshed OSM cache invalidates the dependent traffic cache.

The cache steps use `save-always: true`, and each producer's
`produceCity` skips cities whose per-city output file
(`osm_<slug>.json` / `dem_<slug>.json` / `traffic_<slug>.json`) is
already present. Together this makes runs **resumable**: an
interrupted, timed-out, 429-throttled or cancelled run still saves
the cities it managed to produce, and the next invocation only
fetches the cities that are still missing.

To force a full re-fetch (e.g. after upstream data has changed but
the producer version hasn't been bumped) pass the corresponding
workflow input (`force_osm` / `force_dem` / `force_traffic`) on
`workflow_dispatch`, or run the producer locally with `--force`.

### DEM local tile sampling

Open-Meteo's free Elevation API imposes a tight request budget (~10 000
requests/day/IP). With ~10 000 unique accident points × 5 samples per
point × 25 cities = ~1.25 million requests/run, GitHub-runner IPs are
reliably rate-limited (HTTP 429) within seconds. No amount of backoff
tuning fixes a structural 125× overuse.

**Solution**: download SRTM 1°×1° HGT tiles once per year and sample
them in-process. Germany needs approximately 30 tiles
(≈ 9° × 8° = 72°², but many are ocean/border); each is ≈ 26 MB
uncompressed (SRTM1, 3601×3601 Int16 samples). Total cache size: up to
~780 MB uncompressed, stored under `$ENRICH_DEM_TILES_DIR`.

**Tile source**: AWS Open Data SRTM HTTPS mirror — no API key or login
required:
```
https://s3.amazonaws.com/elevation-tiles-prod/skadi/<NS><lat>/<name>.hgt.gz
```

**Cache key**: `dem-tiles-<version>-YYYY` (annual). SRTM is a fixed
survey; the tiles never change. `save-always: true` persists partial
downloads.

**Sampling algorithm**: bilinear interpolation from the four surrounding
pixels (O(1) in-memory read). Slope is derived from the adjacent-pixel
gradient within the same tile — no extra lookups. This reduces the
per-point sample count from 5 (old API path) to **1**.

**HTTP API fallback**: set `--use-api` on the CLI (or don't set
`$ENRICH_DEM_TILES_DIR`) to revert to the Open-Meteo path. The mocked
`opts.fetchElevations` used in unit tests is unaffected — it is always
honoured when provided.

#### Seeding the tile cache manually (offline / first run)

```bash
# Download all tiles for cities listed in cities.txt.
ENRICH_DEM_TILES_DIR=.enrichment-cache/dem-tiles \
  node scripts/producers/dem_tile_producer.js

# Download tiles for a single city.
ENRICH_DEM_TILES_DIR=.enrichment-cache/dem-tiles \
  node scripts/producers/dem_tile_producer.js --city Bonn
```

Each `.hgt.gz` download is decompressed on-the-fly; only the raw
`.hgt` file is stored in the cache directory. Already-downloaded tiles
are skipped automatically (`--force` overrides this).

### Per-city matrix workflow

`.github/workflows/enrich-matrix.yml` is an optional, parallel
variant of `enrich.yml`. It splits the producer stage into one
matrix job per city (`max_parallel` configurable, default `4`),
caches each city's outputs under a per-city + per-week key, then
hands every city's three small JSONs to an aggregator job via
`actions/upload-artifact`. The aggregator unpacks the artifacts
into a single `.enrichment-cache/` tree, runs the regular
`scripts/enrich_geojson.js` + size-budget check, and commits.

Trade-off: 3-4× lower wall-clock for the producer stage at the
cost of more total runner-minutes (one runner per city instead of
one shared runner) and a larger CI surface. Use it for one-off
"rebuild everything" runs after a producer version bump; the
default scheduled run still uses the simpler single-job
`enrich.yml`.

Run locally:

```bash
node scripts/producers/osm_producer.js     --city Bonn --out-dir .enrichment-cache/osm

# Download SRTM tiles for Bonn (skipped on subsequent runs — tiles are cached).
ENRICH_DEM_TILES_DIR=.enrichment-cache/dem-tiles \
  node scripts/producers/dem_tile_producer.js --city Bonn

ENRICH_OSM_DATA_DIR=.enrichment-cache/osm \
ENRICH_DEM_TILES_DIR=.enrichment-cache/dem-tiles \
  node scripts/producers/dem_producer.js     --city Bonn --out-dir .enrichment-cache/dem

ENRICH_OSM_DATA_DIR=.enrichment-cache/osm \
  node scripts/producers/traffic_producer.js --city Bonn --out-dir .enrichment-cache/traffic

ENRICH_OSM_DATA_DIR=.enrichment-cache/osm \
  ENRICH_DEM_DATA_DIR=.enrichment-cache/dem \
  ENRICH_TRAFFIC_DATA_DIR=.enrichment-cache/traffic \
  node scripts/enrich_geojson.js --city Bonn
```

To fall back to the Open-Meteo API (e.g. for testing or debugging):

```bash
ENRICH_OSM_DATA_DIR=.enrichment-cache/osm \
  node scripts/producers/dem_producer.js --city Bonn --use-api --out-dir .enrichment-cache/dem
```

## Source data licensing

The schema's `*_source` fields are designed for **selective omission**.
A city without licensable counts simply ships only
`traffic_proxy_class` (or omits the traffic stage entirely). Always
verify each source's redistribution clause before committing a new
dataset to the public repo.
