# Unfall-Tiles und viewportbasierter Pilotmodus

## Zweck

Große Stadtdateien werden bislang vollständig geladen, bevor die Karte einen einzelnen Unfall anzeigen kann. Der Accident-Tile-Pilot ergänzt deshalb einen statischen, serverlosen Tile-Pfad, ohne bestehende Stadtanalysen oder Exporte stillschweigend auf Teilbestände umzustellen.

Der normale Betriebsmodus bleibt **Full City**. Viewport-Tiles werden nur verwendet, wenn die URL ausdrücklich enthält:

```text
accidentDataMode=viewport
```

Beispiel:

```text
werkbank_v2.html?city=Bonn&accidentDataMode=viewport&centerLat=50.73&centerLon=7.10&zoom=15
```

## Artefaktlayout

Der Producer schreibt ausschließlich gzip-Dateien:

```text
out/accidenttiles/<stadt>/index.json.gz
out/accidenttiles/<stadt>/<z>/<x>/<y>.json.gz
```

Das Manifest enthält mindestens:

- Schema- und Producer-Version,
- normalisierten Stadtschlüssel,
- Zoomstufe,
- SHA-256-Fingerprint der vollständigen Quell-FeatureCollection,
- Gesamtzahl der Quellfeatures,
- Anzahl expliziter und abgeleiteter Feature-Identitäten,
- sortierte Tile-Liste mit Featurezahl je Tile.

Jedes Tile ist eine eigenständige GeoJSON-`FeatureCollection`. Top-Level-Eigenschaften der Stadtdatei, etwa Enrichment-Dictionaries, werden in die Tile-Payloads übernommen.

## Erzeugung aus einem normalen Checkout

Eine Stadt:

```bash
npm run generate:accident-tiles -- --city Bonn
```

Mehrere Städte:

```bash
node scripts/build-accident-tiles.js --city Bonn --city Hannover
```

Alle Städte aus `cities.txt`:

```bash
npm run generate:accident-tiles
```

Alternative Verzeichnisse:

```bash
node scripts/build-accident-tiles.js \
  --input-dir .build/enriched \
  --output-dir .build/enriched \
  --zoom 13
```

Der Producer liest sowohl `.geojson` als auch `.geojson.gz`.

## Validierung und atomare Installation

Vor der Installation prüft der Producer:

1. Die Quelle ist eine GeoJSON-`FeatureCollection`.
2. Jedes Feature besitzt eine gültige Punktgeometrie.
3. Keine explizite oder abgeleitete Feature-Identität kommt doppelt vor.
4. Manifest und Tile-Payloads entsprechen dem erwarteten Schema.
5. Die Summe aller Tile-Features entspricht exakt der vollständigen Quelle.
6. Für jedes Manifest-Tile existiert genau eine lesbare gzip-Payload.
7. Im erzeugten Stadtbaum befinden sich keine rohen JSON-Dateien.

Erst nach erfolgreicher Validierung ersetzt der neue Baum den bisherigen Stadtbaum. Bei einem Installationsfehler wird der vorige Baum wiederhergestellt.

## Zentrale Datenzugriffsschicht

Der Browser konstruiert keine Accident-Tile-Pfade selbst. `UA.DataResources` besitzt die Pfad- und Kompressionspolitik:

- `accidentTileIndex`: gzip-only,
- `accidentTile`: gzip-only,
- `accidentGeoJson`: gzip-preferred für den kompatiblen Full-City-Modus.

`TiledAccidentProvider` wählt nur Ressourcentyp und Tile-Koordinaten. Direkte `fetch()`-Aufrufe, eigene `out/...`-Pfade oder ein Raw-JSON-Fallback gehören nicht zum Providervertrag.

## Laufzeitmodi

### Full City – Standard

Ohne `accidentDataMode=viewport` wird weiterhin die vollständige Stadtdatei geladen.

```text
ctx.accidentDataCoverage = {
  mode: "full-city",
  complete: true,
  provider: "static" | "custom",
  loadedFeatureCount: ...
}
```

Der Full-City-Modus fragt nicht probeweise das Tile-Manifest ab. Dadurch bleiben Netzwerkverhalten, Statistiken, Berichte und Exporte kompatibel.

### Viewport – expliziter Pilot

Mit `accidentDataMode=viewport` lädt der Browser das Manifest und nur die Tiles, die die initiale Karten-BBox schneiden.

```text
ctx.accidentDataCoverage = {
  mode: "viewport-partial",
  complete: false,
  provider: "tiled",
  bounds: { south, west, north, east },
  tileZoom: 13,
  sourceTotalCount: ...,
  sourceFingerprint: ...,
  loadedFeatureCount: ...
}
```

Die Datenquellenanzeige kennzeichnet den Zustand als „nur aktueller Kartenausschnitt“.

Fehlt das Manifest oder ist kein Karten-Bounds verfügbar, fällt der Pilot kontrolliert auf die vollständige Stadtdatei zurück. `fallbackReason` dokumentiert den Grund.

## Export- und Interpretationsgrenze

Ein viewportbasierter Teilbestand ist keine Stadtgesamtanalyse. Deshalb blockiert die Laufzeit in diesem Modus:

- Bericht/PDF/DOCX-Vorbereitung,
- CSV,
- GeoJSON,
- KML.

Die Fehlermeldung nennt die geladene und – sofern im Manifest vorhanden – vollständige Featurezahl und fordert dazu auf, `accidentDataMode=viewport` aus der URL zu entfernen.

Diese Sperre gilt auch für programmatische Aufrufe der öffentlichen Exportfunktionen. Sie ist keine reine UI-Warnung.

## Aktuelle Einschränkungen

Der erste vertikale Schnitt lädt die **initiale** Karten-BBox. Beim späteren Verschieben der Karte werden noch keine weiteren Unfalldaten inkrementell nachgeladen. Diese Begrenzung ist absichtlich:

- Der Provider-, Producer- und Coverage-Vertrag wird zunächst vollständig nachgewiesen.
- Bestehende Filter-, Statistik- und Renderpfade bleiben unverändert.
- Eine spätere Erweiterung kann BBox-Wechsel, Tile-Eviction und deduplizierte Datenzusammenführung ergänzen, ohne Dateiformat oder Sicherheitsgrenze erneut zu ändern.

## Automatisierte Nachweise

Die Tests prüfen unter anderem:

- deterministische gzip-Bytes,
- vollständige Feature-Summe,
- Duplicate- und Rollback-Verhalten,
- zentrale gzip-only-URLs,
- nur BBox-schneidende Tile-Requests,
- Full-City-Fallback bei fehlendem Manifest,
- Exportblockade bei Teilabdeckung,
- statischen Site-Build einschließlich Accident-Tiles,
- reale `werkbank_v2.html`: sichtbarer Unfallpunkt aus gzip-Tile, keine Full-City-Anfrage und kein Raw-JSON-Tilezugriff.
