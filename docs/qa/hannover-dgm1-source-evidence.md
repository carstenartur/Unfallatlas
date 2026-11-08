# Hannover DGM1: real bounded acquisition and producer evidence

Date: 8 November 2026. Isolated worktree `dgm1-work`, branch
`feat/hannover-real-dgm1`, base `adeed733c8e9e1215c3f08f85d93ec0c4ecd4666`.
`context-integration` was inspected read-only. No account, remote-write,
access-protection bypass, citywide data activation or manual-QGIS claim occurred.

## Outcome

Real official data have now been acquired, pinned and processed rather than
represented by a source descriptor alone. Two small spatial snapshots are usable
by the existing adapter and profile producer:

| Snapshot | Actual source | Grid | Points / cells | Real OSM ways processed |
|---|---|---|---:|---:|
| City-centre sample | Complete official 1,825,987-byte test ZIP, nine XYZ entries | E 549810.5–550654.5; N 5801920.5–5802559.5; 1 m | 540,800 | 637 after two explicit invalid-layer exclusions |
| Lindener Berg | Original `4701B.xyz` and `4801A.xyz` from the official Mitte production archive | E 547500.5–548499.5; N 5801500.5–5801999.5; 1 m | 500,000 | 219 |

The grids cover approximately 0.5408 km² and 0.5 km² respectively, using cell-area
accounting. They establish no citywide coverage. Total preserved downloaded data
bodies, including original OSM XML and metadata/index ranges, are **8,846,686
bytes**, below the authorized 50 MB ceiling. Tiny error responses and headers do
not materially alter that bound. No complete 114/185 MB archive was downloaded.

The source snapshots, manifests, original-response headers, ZIP indexes, original
XYZ files, producer outputs, profile CSVs, extraction/reproduction scripts,
independent numeric check and plotted profiles are in:

`/workspace/scratch/299a981d5ae8/dgm1-acquisition`

## Verified official sources and metadata

The exact configured [municipal DGM1 dataset page][dataset] explicitly describes
one-metre terrain points, a **2010 laser-scanner survey**, the full city dataset,
ASCII XYZ and visualization GeoTIFF distributions. Its [product PDF][product]
repeats these facts. It states publication **2024-01-15**, change **2023-03-01** and
horizontal CRS **ETRS89 / UTM Zone 32N, EPSG:25832**. The [official ISO metadata
record][metadata] and downloaded XML corroborate the source/CRS/publication and
identify CC BY 4.0. A separate temporal metadata element begins in 2023; it is
not evidence of a new 2023 laser survey. The survey year, dataset publication,
archive HTTP Last-Modified, archive-entry timestamps and actual retrieval are
kept distinct.

The inspected DGM page, product PDF and ISO XML do **not** establish a vertical
datum. It remains null. The separate municipal survey-benchmark page mentions
NN/Höhenstatus 130, but transferring that fact to this DGM would be unsupported.
No NN, NHN, DHHN92 or DHHN2016 designation is inferred from EPSG:25832 or from
plausible numerical heights.

The [municipal use conditions][terms] specify CC BY 4.0 International and the
source notice **“Datenquelle: CC-BY-4.0 – Bereich Geoinformation – LH Hannover”**.
The ISO record additionally requests the year of data receipt. Evidence therefore
uses that notice and Landeshauptstadt Hannover (2026), identifies the survey year
2010, and discloses cropping/mosaicking/profile derivation as processing.
OpenStreetMap road data retain separate ODbL-1.0 / © OpenStreetMap contributors
attribution and their actual API source URLs and retrieval dates.

Static configuration now fills the verified acquisition/publication fields;
verticalDatum stays null. It does not register a small excerpt as citywide data.

## Actual distribution and archive index

The official page links these **observed URLs**, without guessed filenames:

- [Test ZIP][sample]: complete original downloaded; 1,825,987 bytes; HTTP
  Last-Modified 2023-01-27T14:35:57Z. It contains `Testdaten_DGM_xyz.zip` and
  `Testdaten_DGM_tif.zip`. The nested XYZ ZIP has nine entries; their internal
  file timestamps are 2016-12-06, not the dataset publication date.
- [West XYZ archive][west]: advertised 112 MB; actual HEAD Content-Length
  **114,447,854**, Last-Modified 2024-02-27T05:32:21Z, ETag
  `"6d255ee-6125659a90340"`; central directory has **119 XYZ entries**.
- [Mitte XYZ archive][mitte]: advertised 181 MB; actual HEAD Content-Length
  **185,387,169**, Last-Modified 2024-02-27T05:30:44Z, ETag
  `"b0cc8a1-6125653e0e900"`; central directory has **192 XYZ entries**.
- [Süd XYZ archive][south], [Ost XYZ archive][east], [Nord XYZ archive][north]:
  official page advertises 202 MB,158 MB,222 MB respectively. Their full bytes and
  individual indexes were not downloaded, and their advertised rounded sizes are
  not presented as measured Content-Lengths.

Normal HTTPS `Range` requests with the observed `If-Match` ETag returned 206 and
correct Content-Range. Exactly 65,536 bytes from each of West and Mitte supplied
their complete central directories and EOCD. This is the published ZIP format
and normal partial download, not a hidden service/API or protection workaround.

For two selected Mitte entries the workflow followed actual central-directory
local offsets, decoded their real ZIP local headers, decompressed only the exact
listed payload and checked ZIP CRC32 and uncompressed size before SHA-256:

| Entry | Original bytes | ZIP compressed bytes | Original file SHA-256 |
|---|---:|---:|---|
| 4701B.xyz | 9,250,000 | 1,004,866 | `c8c0d6c51827cd0545cf1e6b9da22aa0b7aebfd156173603d6ec3bba1889c37e` |
| 4801A.xyz | 9,250,000 | 996,279 | `3e18321cdc82fd890e4c0060e0d82d5561d9ce58c4e7cdb7eebba1bf950e1ddf` |

Actual range bodies, including a bounded margin after the compressed entry,
were 1,070,402 and 1,061,815 bytes. Every requested offset and entry name came from
the verified ZIP directory. The complete archive SHA-256 is explicitly unknown;
an ETag or ZIP CRC is not represented as a cryptographic whole-archive hash.

## Reproducible local pins

The complete test ZIP SHA-256 is:

`e04bcbee1800eac23b580b94f9c245a0f6829fa2cca3ccd07512052fcf9726a5`

The local adapter manifests have these external pins:

- City-centre `snapshot/manifest.json`:
  `0fd56f7c4dff4637ca9746d7504aff8194116cf9de1a2fa723919b99e71043e5`
- Lindener `lindener/snapshot/manifest.json`:
  `48f7af6bbce51087dd8fc2799116428f5773b6619b5c8c3020067a3226139137`

`source-manifest.json` in each scope records original files/ranges and the derived
mosaic hash, byte count, grid and processing notice. The city-centre mosaic
concatenates original rows in filename order, retaining one real header and
normalizing line endings. The Lindener mosaic concatenates the two original
headerless files byte-for-byte; no coordinate or height value is edited or
resampled. `SHA256SUMS` / `all-artifacts.json` inventory the evidence files.

Offline reproduction from the preserved originals:

```bash
python /workspace/scratch/299a981d5ae8/dgm1-acquisition/rebuild-snapshots.py
node /workspace/scratch/299a981d5ae8/dgm1-acquisition/run-real-producer.js /path/to/integrated/repository
node /workspace/scratch/299a981d5ae8/dgm1-acquisition/lindener/run-real-producer.js /path/to/integrated/repository
node /workspace/scratch/299a981d5ae8/dgm1-acquisition/extract-reference-profiles.js /path/to/integrated/repository
node /workspace/scratch/299a981d5ae8/dgm1-acquisition/lindener/extract-reference-profiles.js /path/to/integrated/repository
python /workspace/scratch/299a981d5ae8/dgm1-acquisition/plot-combined-references.py
```

`acquire-indexed-tile.py` can repeat only the two index-identified HTTPS ranges;
it uses the preserved ETag and fails if that version changes. The saved ZIP and
XML provide the exact originals even if later public versions change.

The producer is the real repository implementation. Its ordinary context
prerequisite validates every selected way and normalized structure tag. Initial
Overpass bbox queries returned 406, so the public primary OSM map API supplied
actual complete geometries and tags; the sidecars identify that API accurately.
Only the structure producer's pure mapping and risk producer are reused offline,
with source metadata explicitly naming OpenStreetMap API, not pretending an
Overpass acquisition. The existing profile producer then finds the prepared
contract current and performs the real grid preload and Theil-Sen computation.
Two city-centre ways (`59312041`, `271478069`) contain raw `layer=-0,7`; they are
listed as excluded, not silently coerced into safe integer layers. The raw XML
retains their original data. The Lindener selection has no such exclusions.

## Geographically documented reference cases

These are **automated real-source references**, not manually accepted gold
cases. Direction follows the original OSM geometry, not traffic direction.

| Case | Actual OSM way and anchor (lat,lon) | Requested ±20 m | Requested ±50 m |
|---|---|---|---|
| Near-flat Friedrichswall | [4697937](https://www.openstreetmap.org/way/4697937);52.3683066,9.7407410 | +0.1%;40 m;41 samples;MAD0.014 m | 0.0%;81.3 m actual;83 samples;MAD0.017 m |
| Clear slope, Am Lindener Berge | [23101052](https://www.openstreetmap.org/way/23101052);52.3630532,9.7059495 | −4.8%;40 m;41 samples;MAD0.019 m | −4.4%;100 m;101 samples;MAD0.073 m |
| Structure, Friederikenbrücke | [24011492](https://www.openstreetmap.org/way/24011492);52.3695976,9.7335759 | usable:false;gradient:null;35.8 m | usable:false;gradient:null;35.8 m |

[Municipal Friedrichswall information][friedrichswall] locates it by the Rathaus,
Culemannstraße and Willy-Brandt-Allee. The [municipal Lindener Berg
account][lindener] explicitly identifies Am Lindener Berge as the steep route
across the 89 m hill; it corroborates geography and broad slope character, not this
numerical gradient or this dataset's vertical datum. The [official
Friederikenbrücke page][bridge] identifies the bridge at the Landtag over the
Leine into the Maschpark. Its DGM curve is therefore not its bridge-surface
profile; `bridge_surface_not_represented_by_dtm` and `non_ground_osm_layer`
correctly suppress the road gradient.

The additional Hardenbergstraße reference (`6138345`) yields+2.9% on an actual
33.4 m way in both requested windows. Its short geometry is explicitly retained
rather than presented as 100 m. The [municipal bridge-replacement
record][hardenberg] geographically locates this street/Leine approach; it does
not certify its present height profile.

Spacing sensitivity 1/2/5 m preserves Friedrichswall 0.1%/0.0%, Am Lindener Berge
−4.8%/−4.4%, and bridge exclusion. Hardenbergstraße varies only 2.9–3.0%.
Independent Python float 64 lookup in the original height rows and independent
NumPy pairwise-median fitting reproduce the numerical gradients; maximum height
difference from the Float 32 provider is below**0.0000033 m** for these cases.
Coordinate/sample positions are shared with production, so this is not an
independent CRS validation. CSVs and the plotted profiles retain numerical
samples, actual lengths, original-data source credit and the manual-validation
boundary. `reference-profiles.png` includes both normal cases and the anomaly.

## Actual producer coverage

| Scope | Ways | Computed 20/50 m | Estimator usable 20/50 m | Structure-unusable 20/50 m | Unavailable 20/50 m |
|---|---:|---:|---:|---:|---:|
| City-centre | 637 | 514 /526 | 437 /449 | 77 /77 | 123 /111 |
| Lindener | 219 | 179 /184 | 173 /178 | 6 /6 | 40 /35 |

“Estimator usable” is the implementation's output, not a manual declaration of
road-surface accuracy. Out-of-grid, insufficient-sample and short-geometry
outcomes remain unavailable. These are not 79104-way Hannover production results.
No accident→way matching was performed, and the artifacts say so explicitly.

## Concrete quality finding 24855098

[OSM way 24855098](https://www.openstreetmap.org/way/24855098), version 8 from
2023-11-16T09:50:15Z, is an ordinary `highway=residential` part of Am Lindener
Berge: `lanes=2`, `surface=asphalt`, `sidewalk=both`. It has **no** bridge, tunnel,
layer, embankment or cutting tags. It is neither a steps nor a footway case.

For its 25.3 m geometry the existing estimator emits−26.1%,27 samples,
MAD1.625 m, uncertainty 19.1 percentage points, `usable:true`, `quality:high` and no
uncertainty reasons. An original-DGM sample drops about 3.805 m over one metre of
along-way distance. This is an observable sharp change in the old terrain data;
its physical cause/current road alignment is **not** established here. No
retaining-wall or field diagnosis is invented.

The exact code explains `high`: DTM+2,1 m resolution+3,>=15 samples+2 and supplied
high match quality+2 total 9, meeting the high-score threshold 9. MAD above 0.75 m
gives zero bonus, but no penalty. Uncertainty is computed separately and never
caps quality or usability. No maximum-MAD, maximum-uncertainty or slope rejection
threshold is stated in the inspected ADR, provider docs, issue body or its six
comments. The documented source/window/sample/no-risk conditions are satisfied.
Rejecting it would require a new reviewed calibration rule, rather than simply
applying an existing threshold. Therefore no new statistical method or invented
threshold was added. Exact tags, geometry, output, samples, maximum drop and
score explanation are preserved in `lindener/quality-anomaly-audit.json`.

## Narrow implementation changes and tests

Actual official bytes exposed two reproducible format/operational failures:

1. The sample begins with `x y z`; the adapter previously rejected line 1. It now
   permits that literal header only on the first physical line. Repeated or
   interior headers still fail. Half-metre cell centres remain unchanged.
2. Real OSM extracts include sub 2 m ways. The estimator rejects them before
   sampling, previously aborting the entire profile batch. The producer now
   records `insufficient_geometry` for their two windows while computing other
   ways. Invalid risk tags remain fail-closed; no unsafe normalization was added.

Both were observed RED before implementation and GREEN after. Four bounded
real-source regression excerpts include original rows, exact source/file pins,
geometries and structure exclusions; the full-archive slope needs only 235
original rows. They are separate from the pre-existing synthetic maths tests.
Static acquisition/publication metadata were also verified RED→GREEN.

Final affected verification: **13 suites,123 tests passed**. This covers the
registry, elevation algorithm, all Hannover DGM provider/profile/anchor/help
contracts, real references, source/risk/context prerequisites, canonical
orchestration and runtime applicator. `git diff --check` is clean. The full
project suite was not re-run for this narrow DGM branch; combined integration
verification belongs to parent.

## What remains before activation/closure

The real-source data gate is materially advanced: original production tiles,
subset manifests, real geometry runs and repeatable numerical references now
exist. Still required are manual original-DGM/QGIS/road-profile receipts,
confirmation of vertical datum, review of the concrete quality anomaly and an
explicit accepted policy for old survey/current geometry differences. Broader
city coverage requires additional controlled tile acquisition/partitioning and
verified matching to the released runtime network, not treating this 1.04 km² of
excerpts as the whole city. The canonical opt-in atomic root/manifest/SHA contract
was inspected but not changed or configured to advertise these partial samples
as citywide evidence. No issue was closed and no remote evidence was published.

[dataset]: https://www.hannover.de/Leben-in-der-Region-Hannover/Verwaltungen-Kommunen/Die-Verwaltung-der-Landeshauptstadt-Hannover/Dezernate-und-Fachbereiche-der-LHH/Stadtentwicklung-und-Bauen/Fachbereich-Planen-und-Stadtentwicklung/Geoinformation/Open-GeoData/3D-Stadtmodell-und-Gel%C3%A4ndemodell/Digitales-Gel%C3%A4ndemodell-DGM1
[product]: https://www.hannover.de/content/download/641402/file/Produktblatt_DGM.pdf
[metadata]: https://e-government.hannover-stadt.de/geonetwork/geonetwork/api/records/50cb104b-925c-41b0-9659-deb3f7015615
[terms]: https://www.hannover.de/Leben-in-der-Region-Hannover/Verwaltungen-Kommunen/Die-Verwaltung-der-Landeshauptstadt-Hannover/Dezernate-und-Fachbereiche-der-LHH/Stadtentwicklung-und-Bauen/Fachbereich-Planen-und-Stadtentwicklung/Geoinformation/Open-GeoData/Nutzungsbedingungen
[sample]: https://www.hannover.de/content/download/641403/file/Testdaten_DGM1.zip
[west]: https://opengeodata.hannover-stadt.de/DGM1_XYZ_Teil_West.zip
[mitte]: https://opengeodata.hannover-stadt.de/DGM1_XYZ_Teil_Mitte.zip
[south]: https://opengeodata.hannover-stadt.de/DGM1_XYZ_Teil_Sued.zip
[east]: https://opengeodata.hannover-stadt.de/DGM1_XYZ_Teil_Ost.zip
[north]: https://opengeodata.hannover-stadt.de/DGM1_XYZ_Teil_Nord.zip
[friedrichswall]: https://presse.hannover-stadt.de/pmDetail.cfm?pmid=30409
[lindener]: https://www.hannover.de/Kultur-Freizeit/Geschichte-Geschichten/Echt-hann%C3%B6versch/Zehn-Dinge/Zehn-Dinge%2C-die-man-im-Winter-in-Hannover-unbedingt/Feuerwerk-vom-Lindener-Berg-aus-bestaunen
[bridge]: https://www.hannover.de/Media/01-DATA-Neu/Facetten/Hannover.de/Echt-hann%C3%B6versch/Architektur-in-Hannover/Zehn-Br%C3%BCcken-in-Hannover%2C-%C3%BCber-die-man-mal-gegangen-sein-muss/Die-Friederikenbr%C3%BCcke
[hardenberg]: https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/1801-2018
