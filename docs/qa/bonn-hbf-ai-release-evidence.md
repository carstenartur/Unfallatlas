# Real Bonn Hbf facts and remaining AI release evidence (#622)

This case is **Bonn Hauptbahnhof / Münsterplatz / Maximilianstraße /
Thomas-Mann-Straße**, not Adenauerallee. The latter was an incorrect reverse
geocode of a midpoint. Bounds come from `tests/e2e/count-scope.spec.js`:
50.730000–50.735500 N, 7.091000–7.101000 E. The smaller 111-case document
appendix rectangle is a different case.

## Reproduce and verify

```sh
node scripts/generate-export-template-defaults.js --check
node scripts/qa-bonn-hbf-ai-golden.js
```

The second command builds the canonical site and launches Playwright Chromium.
An environment with an existing supported browser may set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. `--skip-build` reuses a canonical build
only after checking exact runtime file bytes and decompressed city/POI/source
metadata against this checkout. Use `--update` only after reviewing explained
source/code/fact drift; it writes the actual output, never historical constants.

Generation visits the real application, opens the export dialog, confirms the
area name and three relevant places, generates `UA.computeExportReport` with
its installed production scope/semantic/cohort/AI adapters, and verifies that
the shared name survives a real page reload. External basemaps are blocked.
The historical wrong reverse-geocode response is an explicit adversarial input;
it is neither a verified area label nor a new geocoding receipt. Template text
requests are unavailable in this case, so it also exercises the generated
canonical offline defaults and configured Bonn recipient through the actual
report path.

`tests/fixtures/bonn-hbf-ai-golden.v1.json` pins actual production statistics,
all seven yearly values, deviations including local Wilson bounds, Newcombe
difference bounds and isSignificant,
filters/bounds, exact discovery rows, full area count, heatmap/POIs, source and
runtime hashes, four production view URLs, declarative map scene/input hashes
and the planned political trace. It excludes generation clocks by construction.
Only the separate execution envelope is ignored by semantic comparison; source
and political-search evidence dates are not generically discarded. Comparison
writes exact changed paths to `out/qa/bonn-hbf-ai/golden-drift.json`, distinguishing
source/runtime hash changes from altered facts. Updating the fixture is not an
automatic approval of drift.

## Current verified facts and method boundary

The published current source reproduces 37 Rad+Pkw AND cases in 2019–2025:
0 fatal, 1 serious and 36 slight; annual totals 6, 8, 5, 2, 2, 9, 5. The complete
area before the involvement filter contains 312 cases. An independent check of
the city data splits the 1,963 cases after active filters into 37 local and
1,926 reference cases. Mask 5 is 37/37 locally and 1,875/1,926 in the rest of
Bonn. The ratio is 1.0272 and the difference is 2.65 percentage points. The
Newcombe 95% interval is [−6.78, 3.46] percentage points, with
`isSignificant=false` and `focus=[]`. The seven-year OLS slope is
−0.14285714285714288, R² is 0.013157894736846809 and the classification is
stagnierend.

### Reference and uncertainty decision

Partition the fully loaded city records by the exact report geometry after
applying identical active filters to both groups. A record on the inclusive
boundary is local. Membership comes from each record's coordinates. Aggregate
counts, the viewport render cap and the load buffer play no role. The
comparison requires a complete city source for the selected city, agreement
between its reported feature count and the original point count, partitionable
coordinates, and at least one record in each group. Reports without the
`deviations.reference` method marker retain their
original city-wide interpretation and local Wilson interval.

Use Newcombe's method 10, combining uncorrected Wilson bounds from both groups
for `difference = locR − baseR`. For local bounds `[lL, uL]` and reference bounds
`[lR, uR]`, subtract `hypot(locR − lL, uR − baseR)` from the difference for the
lower bound and add `hypot(uL − locR, baseR − lR)` for the upper bound. The
existing `ciLow` and `ciHigh` describe the local proportion. A zero observed
reference share leaves the ratio undefined. The difference and its interval
remain available when both groups contain records. An interval above zero
keeps that row visible even when other patterns qualify for the ratio ranking.
[Newcombe (1998), method 10](https://pubmed.ncbi.nlm.nih.gov/9595617/)

`isSignificant=true` means that the lower bound for this individual difference
exceeds zero. The approximate intervals assume an independent binomial model.
Disjoint groups prevent overlap of records. Correlation among crashes in space
or time can still affect coverage. The parallel search is exploratory and
the intervals are unadjusted for multiplicity. A spatial cluster or an
official hotspot designation requires separate evidence. Absolute accident
rates require suitable exposure data.

## Review artifacts and real blockers

`out/qa/bonn-hbf-ai/` contains the actual deterministic report, source manifest,
external facts/prompt, production server model input and prompt, and review and
execution receipts. The production server feature extractor, preselection,
input builder, prompt builder, proposal schema and value-add rubric are reused;
no replacement statistics or fake response is supplied. Receipts hash the exact
input, prompt, schema and rubric and record provider availability only as a
boolean, with no credential values. A model version and execution timestamp
remain null until real evidence is supplied.

Run `node scripts/qa-bonn-hbf-ai-golden.js --run-model` with the configured
`GEMINI_API_KEY` and `AI_ASSESSMENT_MODEL` to submit the captured production
prompt after the Golden comparison passes. Each live request saves its raw
answer, parsed JSON, serving model version, execution receipt and rubric in
a separate `out/qa/bonn-hbf-ai/provider-run-*/` directory. Missing model
version, invalid output and an unsupported filing verdict fail the live check.
The default run stays offline.

An offline imported response can be examined with `--model-response FILE
--provider-receipt FILE`; the receipt must name the provider/model/exact version,
execution time and matching input, prompt, schema, rubric and canonical JSON response hashes. The production value-add rubric
runs even on an invalid/missing receipt. A locally supplied receipt is a claim,
not independently authenticated provider execution. This case stays blocked
while political and live-map evidence are incomplete, even if a response claims
ready. Inspect `model-review-receipt.json` for exact binding hashes.

The hermetic Golden's planned political search includes the confirmed area name, Bonn,
Münsterplatz, Maximilianstraße and Thomas-Mann-Straße. Search execution and
verified direct proceeding links are absent; this is **not-searched**, not zero
results. Real motions, resolutions, administrative answers, traffic trials and
ongoing plans have not been compared. Scene/input fingerprints prove which
selection and view URLs are intended; image hashes are null and no live image
inspection is claimed by this Golden. The separate bounded live check below
does not change that negative fixture. The illustrative location-brief example.org fixtures do
not supply positive acceptance for this case. A configured real provider run,
methodology demonstration, complete positive evidence and an independent rubric
review remain external release gates.

## Integrated source binding and bounded live check, 2026-11-08

After integrating the reviewed context providers and consultation timelines,
the production browser reproduced all case facts, source-file hashes, view URLs,
map scene and accident-row fingerprints unchanged: 37 selected / 312 complete
area. Exactly three technical fields changed: the export and filter runtime
hashes, and the source data fingerprint. The latter now binds the existing
context evidence: 312 points, SRTM 30 m terrain and 301 qualitative OSM traffic
proxies. This does not activate measured counts or DGM1 for this Bonn case.
The original filter transformation is unchanged. A subsequent complete browser
verification reported zero Golden drift.

A separate real public-site inspection at 17:32:41–17:34:21 UTC reproduced
37 marked Rad+Pkw AND cases in all four requested map modes. Standard loaded
35 OSM tiles; hybrid and analysis loaded Esri imagery with CARTO labels;
orthophoto loaded Esri imagery. The visible NRW/BKG fallback to World Imagery
does not establish an official orthophoto acquisition date or geometry accuracy.
These observations precede the later 17:36:51 deployment and are explicitly an
old-runtime baseline. Screenshots were inspected internally, but their file
transfer failed; no persistent image receipt or image hash is claimed.

The actual published catalogue used for the separate bounded search contained
25,206 records, source clock `2026-11-07T14:07:49.627Z`, and verified decompressed
SHA-256 `1cf8053bebefab8321a4dab93fbd7c5cbf236e90058453524dcd733a1e291b40`.
Literal title/metadata searches returned 7 Münsterplatz, 21 Maximilianstraße,
22 Thomas-Mann-Straße and 22 Am Hauptbahnhof matches: 72 term matches and
71 unique records. These counts include 2026 material, distinguishable by each
record's date; they do not establish full-text or historical political coverage.

Six relevant official detail URLs were requested. All returned HTTP 200 with
an access-check page, rather than the proceeding text. Examples include the
[2019 bus/cycle-lane proceeding](https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=778),
[Maximilianstraße proposal](https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2005870),
[Thomas-Mann-Straße proposal](https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2013917),
and the [2026 Hauptbahnhof proposal](https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2027425)
with its [administrative response](https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2028602).
No challenge was bypassed and no alternative route was probed afterward.
Catalogue document types do not prove adoption or implementation; both remain
unverified. The separate receipt is `partial`, `reviewRequired: true`, with
SHA-256 `2d5bca5066530909022d29fe94da1e1e8fc3fbbb9e1bc9be9ae8da0df29319d8`.
No AI execution, expert approval or completed political research is claimed.

## Name and template/configuration UI

The export dialog provides labelled name/place inputs, explicit confirmation,
neutral reset and a live status message. Confirmation is bound to the current
selection geometry; a changed area invalidates it before report generation.
`areaName`, `areaSearchTerms` and `areaNameGeometry` are canonical shared URL
parameters. The original city/bounds binding uses the same six-decimal precision
as shared selection URLs. It is validated after map hydration, including for
viewport-only names; stale, cross-city or unbound old names need confirmation.
Geometry synchronization clears stale names before publishing new bounds. Explicit
place terms replace an unverified midpoint street in research terms.

`templates/*.txt` is the canonical generic text source. Run
`node scripts/generate-export-template-defaults.js` after text changes; the
checked generated `js/ua.export_template_defaults.js` feeds both exporters and
the regression rejects drift. City-specific external overrides retain priority.
Resolution text uses the configured committee qualifier (Bonn:
Bezirksvertretung Bonn); unresolved configuration remains an explicit check
rather than becoming a default Bezirksrat. The server model-input builder accepts both the normalized `name` and the
production configuration's `gremium` field, so the configured recipient is not
lost during handoff. The underlying jurisdiction still requires human
confirmation before submission.


## Final review corrections and reproducibility, 2026-11-08

The production research panel now distinguishes its generated terms from deliberate
manual edits. A confirmed geometry-bound area replaces old generated midpoint
terms on reopening and direct search; manual terms remain intact. Automatic AI
research derives its location context from that same confirmation, leaving the
unverified midpoint street/district empty, so server variant expansion cannot
reintroduce the old Adenauerallee label. Real request/variant regressions passed.

The exploratory/unadjusted limitation now survives the actual AnalysisScope
wrapper and appears in structured methodology, preview, DOCX/PDF and both AI
paths, including the deterministic fallback. The server prompt cache version is
2.6. No formula, threshold, denominator or statistical value changed.

Two actual Chromium runs on the integrated canonical build produced byte-identical
Golden snapshots. Independent recursive review found exactly eight changed paths:
the explanatory digest note, the explicit methodology limitations, and six runtime
file hashes. Every other field—including counts, years, geometry, statistics,
source data fingerprint, views, model-release state and political evidence—was
unchanged. The final fixture SHA-256 is
`38d7ae24913749d50d8abc1f633d9945b20a08a5c4f785b77a41f6808c2f6a86`.
The combined source-clock, publication, area-name, asset, methodology, scope and
Golden contract check passed 9 suites / 182 tests; the focused final fixture
check passed separately. Actual model, scientific and positive political
acceptance remain absent.


## Typed context export binding, 2026-11-08

One actual Chromium harness run on export commit
`11e0fa1fc19029107bd5a81aa3127a2b97bec5e8`, including the canonical build,
produced exactly one changed Golden field:
`inputs.runtimeFiles.js/ua.export_v2.js`. Its SHA-256 changed from
`82f09ad1a7492c0637f9e161b02ae64036bcfb1ee7665a6855e27eebc200f7e4` to
`3898d90ef06b51f81aaec22513b9c7a1b1eafd97d127c71f6bbf0e41c88476d9`.
Independent recursive review compared every snapshot field and checked the new
hash against the actual production file. All other fields remain identical,
including 37 selected / 312 complete-area cases, years, geometry, statistics,
source-file and source-data fingerprints, map views, political research and
model-release state. The real draw/share and viewport-reload checks also passed.

The approved generated bytes replace fixture SHA-256
`38d7ae24913749d50d8abc1f633d9945b20a08a5c4f785b77a41f6808c2f6a86`
with `6e423de6a4ea79be8d186e4fd8b04fad7de59284ea4f6b2710c7ab14615dc577`.
The fixture update contains only that explained runtime hash change. No second
browser run or new external-source/live-map observation is claimed. The earlier
bounded live evidence above remains historical; actual model, manual Word,
scientific and positive political acceptance are not granted by this update.


## Official prior decisions for the station area, 2026-11-10

The Bonn council adopted item 5.2 (DS 232044) on 14 March 2024. Point 10 asked the administration to investigate a continuous pedestrian width of at least 3.00 m north of the planned cycle lane on Maximilianstraße up to Am Hauptbahnhof, and to report the consequences. The council commissioned further design work, with a construction decision to follow the detailed design. [Official minutes, item 5.2, pages 36–37](https://www.bonn.de/medien-global/amt-13/amtsblatt/34_2024_Amtsblatt-Niederschrift-Rat-14.03.2024.pdf)

On 8 May 2025 the council directed planners to continue the cycle route along Maximilianstraße and consider physical measures to reduce conflicts with pedestrians. A new motion for this part of the Golden area can request the current design, implementation date and planned monitoring for the existing decisions. The 37 bicycle–car crashes cover the whole selected area. Attribution to this particular route or to pedestrian–cycle conflicts requires separate case-level evidence. [City announcement of 9 May 2025](https://www.bonn.de/pressemitteilungen/mai/umgestaltung-zob-vorschlaege-aus-beteiligung-werden-auf-umsetzung-geprueft.php)

A separate run of the production portal search used the Golden area and bounds with Münsterplatz, Maximilianstraße and Thomas-Mann-Straße. The existing public OParl QA guard recorded two initial network requests and blocked six out-of-scope fallback attempts. The production service reported `POLITICAL_PROVIDER_UNAVAILABLE` before returning a catalogue or findings. The two council records above were verified in city publications. This run supplies no complete automated search or zero-result evidence.

The production model service reported `isAvailable() === false`. Its execution receipt had no model version, execution time or response hash. A real response and provider receipt bound to the Golden input and prompt, followed by an independent rubric and subject-matter review, remain outstanding.

## Public station-area search and official aerial imagery, 2026-11-11

Chromium used the published Golden area and its original 37-case selection. Searches in the normal council browser returned 6 records on the first page for Münsterplatz, 15 for Maximilianstraße, 15 for Thomas-Mann-Straße and 15 for Am Hauptbahnhof. The displayed search status identified incomplete coverage. A separate search for 232044 found five related records, including the [original ZOB proceeding](https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2014540) and the [amendment on pedestrian widths](https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2016420). The public browser then selected the original and the amendment with the two “Für Bericht” checkboxes and adopted them. The normally generated report retained both official links and identifiers (232044 and 232044-02 AA), with 37 cases still selected. The [city's contemporaneous account of the March 2024 vote](https://www.bonn.de/pressemitteilungen/maerz-2024/neubau-des-zentralen-omnibus-bahnhofs-rat-beauftragt-naechste-planungsphasen.php), the council minutes and the May 2025 city announcement above establish the decision and continued planning. Implementation still needs separate evidence. All 133 catalogue requests observed in this reference-case run used the Pages origin.

The old city orthophoto service returned HTTP 404. The NRW WMS returned an OGC `LayerNotDefined` exception for `nw_dop` with HTTP 200. The capabilities document advertises `nw_dop_rgb` for colour imagery. For the same 600 × 600 m bounding box centred at the station, the corrected GetMap returned a decoded 256 × 256 PNG (180,050 bytes, SHA-256 `3248ecfa57adf7389c5508fbfba00408718a18200ec54122708937e178f2f79a`). The provider metadata distinguishes the date of access from the flight date. [NRW WMS capabilities](https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities) · [City notice about the former map service](https://www.bonn.de/pressemitteilungen/juli/anpassungen-bei-der-digitalen-geoinformation-der-stadt-bonn.php)
