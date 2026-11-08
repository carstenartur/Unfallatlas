# Shared scalable council catalogue and map controls

## Authorized outcome

Implement the agreed improvements and merge them into main after verification.
Bonn and Hannover continue to use one publication and reader contract. Berlin is
a scalability case, not a new source integration. Preserve the historical import
and mobile corrections already present on PR 750.

## Data contract

The complete imported records remain authoritative. Map data is a derived view:
only verified geometry, compact labels, counts and lazy detail references belong
in its initial payload. Unmapped records and unmapped mentions in partially
mapped records remain searchable and retrievable. An official geometry need not
have a corresponding derived locations[] entry. Never invent marker positions.

Introduce a versioned partitioned snapshot alongside the readable v1 format.
Bound both leaf payloads and directory nodes; do not replace the city JSON with
an equally unbounded global ID, term or tile directory. Use immutable hashed
assets and publish the small manifest last. Retain source timestamps, coverage,
assessment totals and failure/expiry semantics during local migration.

Use stable record identities, separate geometry/location identities, and lazy
forward/reverse relationship lookup. Year, tile and array offset are not the
identity of a new location. Related records can cross years and map coverage.
Long location lists and popular places/terms must have bounded pages. Existing
v1 references remain valid for their v1 snapshot; do not mix generations.

The shared reader supports records, search, relations and spatial access.
The map must not load all record or search partitions. The search includes
unmapped records. Missing partitions and bounded result pages are explicit,
never an asserted complete empty search. Source URLs retain validation.

Spatial access must retain crossing lines and multipart geometry, deduplicate
logical geometry, and offer an honest overview when detail density exceeds the
request/render budget. Share grid/resource/concurrency/cache mechanisms with
the accident and road-context implementations rather than adding a third copy.
Budgets account for decoded bytes and concurrent requests, not only file count.

## Historical acquisition

Persist completed source work by source, scope, year/cursor and revision. A run
budget ends a resumable work unit, not the archive. Reconcile known metadata and
retry failed detail reads without discarding verified records. Historical year
selection is configurable; extend Hannover to 2014 for the first larger live
publication, matching the existing Bonn source lookback. Preserve earlier years
on subsequent runs. Do not claim the entire official archive is complete unless
source evidence establishes that scope. Do not mirror all original PDF files.

## Map controls

One floating, labelled Karte entry replaces Ebenen and Karten-Layer and hosts
the existing background choice. Groups distinguish background, accident display,
surroundings, road context and council documents. Cluster and heatmap remain
independently selectable. Remove duplicate primary controls, reuse state and
render pathways, retain URL/export provenance and source capability checks.
Keep filters and action tools separate. Use opaque readable icons/text over a
lightly translucent surface, touch targets at least 44 CSS px, keyboard state,
focus return and compact mobile presentation. Closing controls never disables
layers. Include the main panel in mobile occlusion handling.

## Acceptance

- Existing v1 snapshots, citations and representative live records still work.
- First map load excludes unrelated/unmapped record partitions; details and
  unmapped relatives are fetched only when requested.
- A tenfold archive increase does not force a tenfold initial map download for
  an unchanged local view; dense single-place histories are paginated.
- More than 50,000 records and more than eight locations per record survive
  publication, lookup and validation without silent truncation.
- Long crossing geometry, unknown places, duplicate source-native numbers,
  changed locations, missing assets and stale async requests are covered.
- Both actual city datasets migrate without losing records, assessments,
  location evidence or relations; all referenced assets validate.
- One coherent accessible map control is usable at phone, landscape and tablet
  sizes; current background and export policies are preserved.
- Canonical repository CI is green before the authorized merge; verify the
  subsequent main/publication result and report any external source limit.
