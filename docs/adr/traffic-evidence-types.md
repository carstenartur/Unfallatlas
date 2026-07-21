# ADR: Traffic evidence types and fallback boundary

Status: proposed by PR #493  
Related: #312, #413, #414

## Decision

Every traffic statement in the Unfallwerkbank is represented as exactly one of
three evidence types:

1. `count` — an observed count published by a named source;
2. `model` — a modelled value published with model/version provenance;
3. `proxy` — a qualitative exposure class derived from road attributes.

The types are not interchangeable. Renderers must retain the selected type,
source, year, period, direction, unit, match distance and quality.

## Numeric-value rule

`count` and `model` observations require a finite numeric value and an explicit
unit such as `Kfz/24 h` or `Fahrräder/24 h`.

A `proxy` observation is forbidden from carrying a numeric value or traffic
unit. In particular, an OSM `highway` class may support a qualitative class
(`low`, `medium`, `high`, `very_high`) but must never be presented as measured
or modelled DTV.

## Evidence priority

For one road, mode and reference year the selection order is:

1. fresh measured count;
2. modelled value;
3. stale measured count, visibly marked with its year;
4. qualitative OSM proxy;
5. no traffic evidence.

A stale measurement does not silently override a newer model. The freshness
window is explicit input to the selection function.

## Matching

An explicit source `wayId` is preferred. Otherwise observations are matched to
the nearest road segment with a configured maximum distance. The result keeps:

- match method;
- distance in metres;
- match quality (`high`, `medium`, `low`).

Unmatched observations do not become city-wide defaults.

## Provenance and licensing

Traffic providers do not implement a second licensing policy. Their descriptor
is validated as a `traffic_count` SourceRecord by the shared SourceManifest
contract from #414. Unclear licences, missing attribution or restrictions on
redistribution/derivatives fail before an observation is available to a
renderer.

## Consequences

- Map, popup, filters and exports can use one typed result.
- CSV/GeoJSON/KML fields can distinguish measured, modelled and proxy data.
- PDF/DOCX wording cannot accidentally call an OSM proxy a traffic count.
- Additional municipal/state providers can be added without changing the
  evidence-selection algorithm.
