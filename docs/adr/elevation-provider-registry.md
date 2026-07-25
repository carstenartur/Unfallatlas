# ElevationProvider registry and claim semantics

Status: first architecture slice for issue #412.

## Decision

Elevation sources are registered through a pure, fail-closed registry before they may be used by the enrichment pipeline. A provider descriptor binds publisher, dataset and distribution URLs, licence, attribution, spatial resolution, model type, CRS, coverage and the policy for recording retrieval time.

Provider selection is deterministic:

1. lower priority tier wins;
2. within one tier, finer declared resolution wins;
3. the provider ID is the stable final tie-breaker;
4. disabled or geographically non-covering providers are never returned;
5. when no complete descriptor covers a city, selection returns no provider instead of silently selecting an undocumented fallback.

The first registered source is Hannover's official DGM1. It is intentionally scoped to Hannover. SRTM remains in the existing producer until its current source/provenance record is migrated into this registry; it is not declared here as a precision-capable road provider.

## Claim boundary

The registry also centralises the semantic difference between a road grade and terrain context.

`Straßenlängsneigung` is permitted only when all of the following hold:

- the source is a high-resolution DTM (at most 5 m in the first contract);
- the road geometry is matched;
- the profile was calculated using robust linear regression;
- the analysed window is at least 20 m;
- at least five elevation samples contributed;
- no bridge, tunnel, layer or similar risk is active.

Every other case is labelled `Geländeneigung im Umfeld`, uses no decimal precision in the presentation contract and exposes explicit uncertainty reasons.

## Follow-up integration

A subsequent #412 slice must connect the registry to `dem_producer.js`, implement the Hannover DGM1 reader/reprojection path and add the QGIS-verified flat, slope and bridge/tunnel gold cases. The existing full-network OSM geometry, atomic generation and context-tile pipeline remain in place.
