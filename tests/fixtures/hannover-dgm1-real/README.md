# Real Hannover DGM1 reference excerpts

These are selected original height rows from public municipal data retrieved on
8 November 2026. Coordinate and height values are unchanged. Sample excerpts
retain the observed `x y z` header; the full-archive excerpt preserves original
spacing, decimals and CRLF line endings. Cropping is a derived-data operation.

- Source: Landeshauptstadt Hannover, DGM1, 1 m, EPSG:25832.
- Licence: CC BY 4.0, https://creativecommons.org/licenses/by/4.0/.
- Required source credit: **Datenquelle: CC-BY-4.0 – Bereich Geoinformation – LH Hannover (2026)**.
- Original survey: laser scanning in 2010; dataset publication: 15 January 2024.
- Vertical datum: not established by the inspected DGM metadata; unknown.
- Road geometries/tags: © OpenStreetMap contributors, ODbL 1.0,
  https://www.openstreetmap.org/copyright.

`reference-cases.json` contains the exact original ZIP URL/hash (sample), full
archive ETag and original entry hash, excerpt hashes, geographic coordinates,
OSM identifiers/timestamps, source roles and expected automated outcomes.
Missing cells in the sparse full-archive excerpt are intentionally NoData.

These tests demonstrate repeatable computation from real source bytes. They do
**not** constitute manual QGIS, survey, current-ground or road-surface validation.
The anomalous profile is documented separately below.

On 11 November 2026 the complete Mitte archive was verified and original rows
for Way 24855098 (Am Lindener Berge) were extracted from `4801A.xyz`.
The reference now verifies the reproduced high residual and the low quality
rating. Source and derived hashes are recorded in `reference-cases.json`.
