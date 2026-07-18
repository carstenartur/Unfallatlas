# Unfall-Tiles und viewportbasierter Modus

## Zweck

Große Stadtdateien werden im Standardmodus vollständig geladen, bevor die Karte einen einzelnen Unfall anzeigen kann. Der Accident-Tile-Modus ergänzt einen statischen, serverlosen und bei Kartenbewegungen inkrementell aktualisierten Datenpfad, ohne bestehende Stadtanalysen oder Exporte stillschweigend auf Teilbestände umzustellen.

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

Jedes Tile ist eine eigenständige GeoJSON-`FeatureCollection`. Top-Level-Eigenschaften der Stadtdatei, etwa Enrichment-Dictionaries, werden in die Tile-Payloads übernommen. Zusätzlich enthält jedes Tile ein positionsgleiches Array `featureIdentities`. Diese vom Producer erzeugten stabilen Identitäten ermöglichen deterministische Deduplizierung, ohne im Browser fachliche Felder erraten oder komplette Features erneut hashen zu müssen.

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
5. Jedes persistierte Feature besitzt genau eine persistierte Identität.
6. Die Summe aller Tile-Features und Identitäten entspricht exakt der vollständigen Quelle.
7. Für jedes Manifest-Tile existiert genau eine lesbare gzip-Payload.
8. Im erzeugten Stadtbaum befinden sich keine rohen JSON-Dateien.

Erst nach erfolgreicher Validierung ersetzt der neue Baum den bisherigen Stadtbaum. Bei einem Installationsfehler wird der vorige Baum wiederhergestellt.

## Zentrale Datenzugriffsschicht

Der Browser konstruiert keine Accident-Tile-Pfade selbst. `UA.DataResources` besitzt die Pfad- und Kompressionspolitik:

- `accidentTileIndex`: gzip-only,
- `accidentTile`: gzip-only,
- `accidentGeoJson`: gzip-preferred für den kompatiblen Full-City-Modus.

`TiledAccidentProvider` wählt nur Ressourcentyp und Tile-Koordinaten. Direkte `fetch()`-Aufrufe, eigene `out/...`-Pfade oder ein Raw-JSON-Fallback gehören nicht zum Providervertrag.

Der optionale Viewport-Controller wird über einen awaitbaren Bootstrap-Vertrag geladen. Der erste Viewport-Request wartet ausdrücklich auf diesen Vertrag und ist damit unabhängig davon, ob Browser, Proxy oder statischer Server das kleine Controller-Skript schneller oder langsamer als die parsergeladenen Skripte ausliefert.

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

Der Full-City-Modus fragt weder beim Start noch beim Verschieben oder Zoomen probeweise das Tile-Manifest ab. Dadurch bleiben Netzwerkverhalten, Statistiken, Berichte und Exporte kompatibel.

### Viewport – explizit und inkrementell

Mit `accidentDataMode=viewport` lädt der Browser das Manifest und nur die Tiles, die die aktuelle Karten-BBox schneiden. Nach `moveend` oder `zoomend` wird der neue Kartenausschnitt über den bestehenden `MapStore` und `RenderScheduler` debounced aktualisiert.

Ein typischer abgeschlossener Zustand lautet:

```text
ctx.accidentDataCoverage = {
  mode: "viewport-partial",
  complete: false,
  viewportComplete: true,
  status: "complete-for-viewport",
  provider: "tiled",
  city: "bonn",
  bounds: { south, west, north, east },
  epoch: 7,
  tileZoom: 13,
  requiredTileKeys: ["4256/2754", ...],
  requiredTileCount: 2,
  loadedTileKeys: ["4256/2754", ...],
  loadedTileCount: 2,
  missingTileKeys: [],
  missingTileCount: 0,
  manifestTileCount: ...,
  sourceTotalCount: ...,
  sourceFingerprint: ...,
  loadedFeatureCount: ...
}
```

Die Statuswerte bedeuten:

- `loading`: Für den aktuellen Kartenausschnitt läuft ein Request.
- `complete-for-viewport`: Alle im Manifest für den aktuellen Ausschnitt vorhandenen Tiles sind geladen.
- `degraded`: Mindestens ein erforderliches Tile fehlt oder konnte nicht verarbeitet werden.

`viewportComplete: true` bezieht sich ausschließlich auf den aktuellen Kartenausschnitt. `complete` bleibt im Viewport-Modus immer `false`, solange nicht nachweislich sämtliche Manifest-Tiles als vollständiger Stadtbestand geladen und validiert wurden.

Fehlt bereits das Manifest oder sind beim Start keine Karten-Bounds verfügbar, fällt der Modus kontrolliert auf die vollständige Stadtdatei zurück. `fallbackReason` dokumentiert den Grund. Fehlt dagegen ein einzelnes Tile während der laufenden Nutzung, bleibt der vorhandene Viewport-Datenstand erhalten und die Coverage wechselt ausdrücklich auf `degraded`.

## Nebenläufigkeit und stale Responses

Der Viewport-Controller besitzt einen monoton steigenden Request-Epoch. Zusätzlich bleibt der bestehende `RenderScheduler` die einzige Instanz, die einen Render-Epoch vergibt.

Bei einer neuen Kartenbewegung geschieht Folgendes:

1. `viewportChanged` invalidiert einen bereits laufenden Accident-Request sofort.
2. Der vorhandene Scheduler fasst schnelle Bewegungen per Debounce zusammen.
3. Der Controller lädt die für den neuesten Ausschnitt benötigten Tiles.
4. Nur wenn Controller- und Scheduler-Epoch weiterhin aktuell sind, werden `ctx.allPts`, Filter und Layer aktualisiert.
5. Eine verspätete Antwort eines älteren Ausschnitts darf den neueren Ausschnitt weder überschreiben noch erneut rendern.

Der Controller erzeugt keinen zweiten Timer- oder Renderloop.

## Cache und deterministische Zusammenführung

Der Provider cached Manifest- und Tile-Promises getrennt je Stadt. Dadurch gilt:

- Ein bereits geladenes Tile wird beim Zurückschwenken nicht erneut angefordert.
- Gleichzeitige Requests für dasselbe Tile teilen dieselbe Promise.
- Features werden nach stabiler Producer-Identität dedupliziert.
- Unterschiedliche Features mit derselben Identität werden als Datenkonflikt erkannt.
- Tile- und Feature-Reihenfolge sind deterministisch.
- Inaktive Tiles werden nach einem LRU-ähnlichen Zugriffszähler begrenzt; standardmäßig bleiben höchstens 96 Tiles je Stadt im Cache.
- Tiles des gerade angeforderten Viewports werden während der Bereinigung nicht entfernt.
- Ein Stadtwechsel trennt Daten- und Cachezustände; Cacheeinträge können je Stadt oder vollständig gelöscht werden.

## Export- und Interpretationsgrenze

Ein vollständig geladener Viewport ist keine Stadtgesamtanalyse. Deshalb blockiert die Laufzeit in diesem Modus weiterhin:

- Bericht/PDF/DOCX-Vorbereitung,
- CSV,
- GeoJSON,
- KML.

Die Fehlermeldung nennt die geladene und – sofern im Manifest vorhanden – vollständige Featurezahl und fordert dazu auf, `accidentDataMode=viewport` aus der URL zu entfernen.

Diese Sperre gilt auch für programmatische Aufrufe der öffentlichen Exportfunktionen. Sie ist keine reine UI-Warnung. Weder `complete-for-viewport` noch ein späterer Cachetreffer dürfen `complete` auf `true` setzen.

## Automatisierte Nachweise

Die Tests prüfen unter anderem:

- deterministische gzip-Bytes und persistierte Identitäten,
- vollständige Feature-/Identitätssumme,
- Duplicate-, Konflikt- und Rollback-Verhalten,
- zentrale gzip-only-URLs,
- Tile-Planung nur für manifestierte BBox-Schnitte,
- optionale/missing Tiles als expliziten degradierten Zustand,
- Promise-Cache, Rückkehr in frühere Ausschnitte und begrenzte Eviction,
- Stadtisolation,
- Request-Epoch und stale-response suppression,
- Einbindung in den bestehenden `MapStore`/`RenderScheduler`,
- keinerlei Tile-Probe im Full-City-Modus,
- Exportblockade bei Teilabdeckung,
- statischen Site-Build einschließlich Accident-Tiles,
- reale `werkbank_v2.html`: sichtbare gzip-Tile-Unfälle, Pan A → B → C, verspätete B-Antwort, Rückkehr zu A ohne Doppelabruf, keine Full-City-Anfrage und kein Raw-JSON-Tilezugriff.
