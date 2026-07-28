# Enrichment Pipeline

Die Enrichment-Pipeline ergänzt die amtlichen Unfallpunkte um räumlichen
Straßenkontext. Sie läuft reproduzierbar aus dem Checkout und schreibt erst
nach erfolgreicher Validierung atomar nach `out/`.

## Grundprinzipien

1. **Amtliche Unfalldaten bleiben die Primärdaten.** Kontextdaten ergänzen sie,
   ersetzen sie aber nicht.
2. **Kontext ist keine Ursache.** Steigung, Straßentyp und Verkehrsbelastung
   dürfen nicht als automatische Kausalerklärung eines Unfalls dargestellt
   werden.
3. **Gemessen, modelliert und Proxy bleiben getrennt.** Ein qualitativer Proxy
   darf niemals als Messwert oder als numerische Schätzung erscheinen.
4. **Fehlende oder nicht ausreichend lizenzierte Daten werden nicht
   erfunden.** Der Standardbestand fällt dann auf eine ausdrücklich
   qualitative Klasse zurück oder zeigt keinen Wert.
5. **Produktion ist fail-closed.** Ungültige Producer-Daten, fehlende
   Provenienz, unvollständige Tiles oder unplausible Steigungen verhindern die
   Installation des neuen Stadtbestands.

## Kanonischer Ablauf

Der manuelle und der automatische Kontext-Workflow rufen denselben
Maven-Lifecycle auf:

```bash
mvn verify -Pcontext-data-e2e \
  -Dcontext.city="Bonn" \
  -Dcontext.force=true
```

Der Ablauf liegt vollständig im Checkout:

1. `scripts/generate-context-city.js` erzeugt die Producer-Daten in einem
   isolierten Arbeitsverzeichnis.
2. `scripts/enrich_geojson.js` verbindet Unfallpunkte, Straßen und DEM-Daten.
3. `scripts/apply-qualitative-traffic-proxy.js` bindet den qualitativen
   OSM-Verkehrsproxy an Unfallpunkte, Way-Payloads, Kontext-Tiles und
   Provenienz-Sidecar, ohne numerische Verkehrswerte zu erzeugen.
4. `scripts/check-enrichment-inputs.js`,
   `scripts/check-context-datasets.js`,
   `scripts/check-slope-plausibility.js` und
   `scripts/check-data-paths.js` prüfen die erzeugten Daten.
5. Erst danach ersetzt `installGeneratedCity()` den bisherigen Stadtbestand
   als kleine Dateisystemtransaktion. Bei einem Fehler wird der alte Bestand
   wiederhergestellt.

## Producer

| Bereich | Producer | Standardquelle | Ergebnis |
|---|---|---|---|
| Straßennetz | `scripts/producers/osm_producer.js` | OpenStreetMap/Overpass | vollständiges OSM-Straßennetz im Stadt-BBox |
| DEM-Tiles | `scripts/producers/dem_tile_producer.js` | AWS Open Data SRTM | lokal zwischengespeicherte HGT-Tiles |
| Steigung | `scripts/producers/dem_producer.js` | lokales DEM | Höhen- und Way-Steigungsdaten mit Methode und Konfidenz |
| Verkehr-Fallback | `scripts/producers/traffic_producer.js` | OSM-`highway` | ausschließlich qualitative Proxyklasse |
| Gemessener/modellierter Verkehr | typisierte Providergrenze | lizenzierter Fachdatensatz | Zahl, Einheit, Zeitraum und Provenienz, sofern zulässig |

Die Provider-Caches werden über den Fingerprint der zugrunde liegenden
Unfall-Geometrie und die jeweilige Producer-Version gebunden. Ein formal
vorhandener, aber veralteter Cache gilt nicht als aktuell.

## Ausgelieferte Daten

### Unfall-Feature

Alle Felder sind optional. Wesentliche Kontextfelder sind:

| Feld | Typ | Bedeutung |
|---|---|---|
| `matched_way_id` | string | OSM-Way, dem der Unfall räumlich zugeordnet wurde |
| `road_context_source` | string | Quelle der Straßenzuordnung |
| `elevation_m` | number | Höhe über Meeresspiegel |
| `slope_percent` | number | lokale Steigung am Unfallpunkt |
| `slope_abs_percent` | number | Betrag der lokalen Steigung |
| `slope_class` | string | `flat`, `gentle`, `moderate`, `steep`, `very_steep` |
| `slope_source` | string | verwendeter DEM-Provider |
| `slope_confidence` | string | providerabhängige Konfidenz |
| `traffic_measurement_type` | string | `measured`, `modelled` oder `proxy` |
| `traffic_proxy_class` | string | qualitative Klasse `low`, `medium`, `high`, `very_high` |
| `traffic_volume_source` | string | stabile Quellenkennung |
| `traffic_volume_confidence` | string | Qualitäts-/Konfidenzangabe |
| `traffic_proxy_basis` | string | nachvollziehbare Grundlage des Proxys, z. B. `highway=primary` |

Numerische Felder wie `traffic_volume_value`, `traffic_volume_unit` und
`traffic_volume_year` sind **nur** für gemessene oder modellierte Provider
zulässig. Für `traffic_measurement_type: "proxy"` werden sie im
Produktionspfad entfernt; ihr Auftreten im Proxy-Provider führt zum Fehler.

### Way- und Tile-Payloads

Die ausgelieferten v3-Kontextdaten verwenden:

```text
out/ways_<stadt>.json.gz
out/ctxtiles/<stadt>/index.json.gz
out/ctxtiles/<stadt>/<x>/<y>.json.gz
out/output_all_years_<stadt>.enrichment.meta.json.gz
```

`ways_<stadt>.json` ist bei v3 eine kleine Envelope mit Verweis auf den
Tile-Index. Die eigentlichen Way-Attribute und generalisierten Geometrien
liegen in viewport-lazy geladenen Z/X/Y-Tiles. Der Browser lädt damit nur den
Straßenkontext, der für den aktuellen Kartenausschnitt benötigt wird.

Kategorische Felder können über die gemeinsamen Dictionaries im Tile-Index
integercodiert sein. Die expliziten Klassen `road_slope_class` und
`traffic_proxy_class` bleiben authoritative und dürfen nicht durch eine
versehentliche Dictionary-Deutung umklassifiziert werden.

## Steigung

### Klassifikation

| Klasse | Betrag der Steigung |
|---|---:|
| `flat` | ≤ 2 % |
| `gentle` | ≤ 4 % |
| `moderate` | ≤ 6 % |
| `steep` | ≤ 10 % |
| `very_steep` | > 10 % |

Die lokale Standardberechnung tastet eine Way-Geometrie entlang der Polylinie
ab und verwendet den Median der Segmentsteigungen. Ein API-Fallback mit nur
zwei Endpunkten wird als geringe Konfidenz markiert. Im Karten-Layer erscheinen
solche Werte in einer gedämpften Farbe; fehlendes Signal wird neutral grau
gezeichnet.

Die Plausibilitäts-Gates prüfen pro Stadt insbesondere:

- minimale Abdeckung der Straßen mit Steigungssignal,
- maximalen Anteil `very_steep`,
- erwartbare Verteilung für flache und topographisch anspruchsvolle Städte,
- Vorhandensein von Methode, Stichprobengröße und Konfidenz.

Ein höher aufgelöster DGM1-Provider wird über die vorhandene Providergrenze
integriert. Seine Validierung und Unsicherheitsangaben werden in #412 verfolgt.

## Verkehrsdaten

### Qualitativer OSM-Fallback

Der OSM-Fallback beantwortet nur die Frage, welcher groben funktionalen
Straßenklasse ein Abschnitt angehört. Er behauptet **keine** durchschnittliche
tägliche Verkehrsstärke und erzeugt keine Fahrzeuge-pro-Tag-Zahl.

Aktuelle Gruppierung:

| OSM-Straßenklassen | qualitative Proxyklasse |
|---|---|
| `motorway`, `trunk` und Links | `very_high` |
| `primary`, `secondary` und Links | `high` |
| `tertiary`, `unclassified` und Links | `medium` |
| `residential`, `living_street`, `service`, `pedestrian`, `track` | `low` |

Jeder Proxy-Eintrag enthält:

```json
{
  "measurementType": "proxy",
  "proxyClass": "high",
  "highwayClass": "primary",
  "confidence": "low",
  "qualityNotes": [
    "Qualitativer OSM-Straßenklassenproxy; kein gemessener oder modellierter Verkehrswert."
  ]
}
```

Die Kartenlegende bezeichnet die Klassen deshalb ausdrücklich als
**OSM-Straßenklassenproxy** und zeigt keine DTV-Grenzen.

### Gemessene und modellierte Provider

Die typisierte Grenze in `js/ua.traffic_provider.js` trennt:

- `measurementType: "measured"`,
- `measurementType: "modelled"`,
- `measurementType: "proxy"`.

Ein gemessener oder modellierter Datensatz muss mindestens stabile
Quellenkennung, Titel, Herausgeber, Lizenz, Zeitraum/Jahr, Einheit,
Transformationshinweise und Qualitätsangaben liefern. Der Import ist nur
zulässig, wenn Speicherung, Bearbeitung und Weitergabe mit dem vorgesehenen
Auslieferungsmodell vereinbar sind.

Nicht importiert werden insbesondere Datensätze mit:

- unklarer oder fehlender Lizenz,
- ausschließlicher nichtkommerzieller Nutzung,
- nicht erfüllbarer Attributionspflicht,
- Verbot der Weitergabe oder abgeleiteter Daten,
- fehlender Möglichkeit, Quelle und Zeitstand im Export sichtbar zu machen.

Die Einführung realer Zählstellenprovider und ihr räumlicher Matching-Vertrag
werden in #413 weitergeführt. Bis dahin bleibt der bundesweite Standardbestand
bewusst qualitativ.

## Provenienz-Sidecar

Das Sidecar bindet den ausgelieferten Stadtbestand an seine Producer:

```json
{
  "schemaVersion": 3,
  "citySlug": "bonn",
  "generatedAt": "2026-07-28T03:14:15.000Z",
  "tileIndexPath": "ctxtiles/bonn/index.json",
  "sources": {
    "osm": {
      "source": "OpenStreetMap (Overpass)",
      "coverage": "full"
    },
    "dem": {
      "source": "SRTM Local Tiles",
      "resolutionM": 30
    },
    "traffic": {
      "source": "OSM-highway-class-proxy",
      "measurementType": "proxy",
      "semantics": "qualitative-osm-highway-class-no-numeric-volume"
    }
  },
  "traffic": {
    "measurementType": "proxy",
    "numericValuesPresent": false
  }
}
```

Die vollständige Quellenbeschreibung des OSM-Proxys enthält ODbL-Lizenz,
Attribution und den Hinweis auf die vorgenommene qualitative Gruppierung.
Export-Renderer übernehmen diese Information über den gemeinsamen
`SourceManifest`-Vertrag.

## Browserdarstellung

- `js/ua.context_layers.js` lädt Envelope, Sidecar und Tiles.
- `js/ua.context_road_layer.js` zeichnet Steigung als breite Grundlinie und
  Verkehrsbelastung als schmale gestrichelte Innenlinie.
- Die Verkehrslegende sagt sichtbar „qualitativer Proxy“.
- Ein explizites `traffic_proxy_class` hat Vorrang vor Legacy-Feldern.
- Ein als Proxy markierter Datensatz mit bloßem Zahlenfeld wird nicht als
  Messwert visualisiert.
- Popup und Export unterscheiden Quelle, Messart und Konfidenz.

Der Filter „nur auf gematchten Straßen“ wirkt auf Unfallpunkte. Er ist nicht
mit der Abdeckung des vollständigen Straßen-Layers gleichzusetzen.

## QA und lokale Reproduktion

```bash
# Gesamter Kontextpfad einschließlich Browser-/Testcontainers-Prüfung
mvn verify -Pcontext-data-e2e -Dcontext.city="Bonn" -Dcontext.force=true

# Producer und Endartefakte
node scripts/check-enrichment-inputs.js --city Bonn
node scripts/check-context-datasets.js
node scripts/check-slope-plausibility.js
node scripts/check-data-paths.js --gzip-only --min-features 10

# Unit-Verträge
npm run test:unit -- --runInBand
```

Die Tests prüfen unter anderem:

- qualitative Proxyklassifikation ohne `value`, `unit` oder `year`,
- fail-closed bei numerischen Feldern in einem Proxy-Provider,
- Entfernung alter DTV-Felder aus GeoJSON, Way-Datei und Tiles,
- konsistente Provenienz im Meta-Sidecar,
- Renderer-/Legendenvertrag ohne DTV-Behauptung,
- atomare Installation und Rollback,
- Steigungsplausibilität und Tile-Konsistenz.

## Weiterführende Themen

- #412: hochaufgelöste, unsicherheitsbewusste Straßensteigungen
- #413: lizenzierte gemessene Verkehrszählungen mit explizitem Proxy-Fallback
- #414: gemeinsamer SourceManifest-Vertrag der Exportformate (abgeschlossen)
- `docs/architecture.md`: Komponenten- und Datenfluss
- `WERKBANK_V2.md`: Bedien- und Featurevertrag
