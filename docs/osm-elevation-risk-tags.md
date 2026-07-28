# Normalisierte OSM-Risikotags für DGM-Straßenprofile

Der mit #571 eingeführte Struktur-Postprozessor bewahrt die exakten
OpenStreetMap-Werte wie `bridge=viaduct`, `tunnel=culvert` oder
`embankment=dyke`. Diese Rohwerte sind fachlich wertvoll und dürfen nicht durch
boolesche Flags ersetzt werden.

Die bestehende Neigungslogik in `js/ua.elevation_provider.js` erwartet jedoch
einen kleinen stabilen Risikovertrag mit `yes`/`no` sowie einer ganzzahligen
`layer`-Angabe. `scripts/producers/osm_elevation_risk_producer.js` erzeugt
deshalb zusätzlich für jeden Way:

```json
{
  "elevationRiskTags": {
    "bridge": "yes",
    "tunnel": "no",
    "layer": "1",
    "embankment": "no",
    "cutting": "no"
  }
}
```

Die ursprünglichen OSM-Felder bleiben daneben unverändert erhalten.

## Normalisierung

Für `bridge`, `tunnel`, `embankment` und `cutting` gilt:

- fehlend, leer, `no`, `false`, `0` oder `none` → `no`
- jeder andere explizite Wert → `yes`

Damit werden unter anderem `viaduct`, `culvert`, `covered`, `dyke` und
projektspezifische positive Werte nicht übersehen.

`layer` wird als kanonische ganzzahlige Zeichenkette im Bereich −100 bis 100
gespeichert. Fehlend und `-0` werden zu `0`. Nicht ganzzahlige oder
unplausible Werte brechen die Ableitung ab.

## Zwingende Eingangs-Coverage

Der Producer akzeptiert ausschließlich ein OSM-Artefakt mit:

- `structureTags.coverage: "full"`,
- Way-Anzahl identisch zur lokalen `ways`-Tabelle,
- genau den geprüften Strukturfeldern,
- gültigem Query-Fingerprint.

Ohne diesen Vertrag könnte ein fehlendes Tag auch durch eine unvollständige
Overpass-Antwort entstanden sein und dürfte nicht als negatives Merkmal gelten.

## Wirkung im Neigungsalgorithmus

Der abgeleitete Vertrag kann unverändert an
`computeRoadGradient(..., { osmTags })` übergeben werden:

- Brücke oder Tunnel: DGM beschreibt nicht die Fahrbahnoberfläche; Ergebnis
  `usable: false`, keine numerische Straßenlängsneigung.
- Nichtnull-`layer`: zusätzliche Unsicherheit außerhalb der Geländeebene.
- Damm oder Einschnitt: Profil bleibt gegebenenfalls nutzbar, Qualität wird
  sichtbar reduziert und der Grund ausgegeben.

Die Tests verwenden den realen gemeinsamen Theil-Sen-Profilalgorithmus und
belegen diese Wirkung auch für `bridge=viaduct`, `tunnel=culvert` und
`embankment=dyke`.

## Lokale Verwendung

```bash
node scripts/producers/osm_elevation_risk_producer.js \
  --input .enrichment-cache/osm/osm_hannover.json
```

Standardmäßig wird atomar in dieselbe Datei geschrieben. `--output` erzeugt
eine getrennte Datei. Ein bereits aktueller Vertrag wird übersprungen; ändert
sich einer der fünf Rohwerte, erzwingt der Struktur-Fingerprint eine neue
Ableitung.

## Provenienz

Das Top-Level-Feld `elevationRiskTags` bindet:

- Producer- und Schema-Version,
- Ableitungszeitpunkt,
- vollständige Way-Coverage,
- ursprünglichen Struktur-Query-Fingerprint,
- SHA-256-artigen Fingerprint über alle relevanten Rohwerte,
- den erwarteten Consumervertrag.

Vorher- und Nachher-SHA-256 des kompletten OSM-Artefakts werden beim Dateilauf
ausgegeben.

## Noch offen in #412

Dieser Slice normalisiert die Strukturwerte und beweist ihre Wirkung im
gemeinsamen Algorithmus. Weiter fehlen:

- kanonische Verkettung von OSM-Struktur- und Risikoproducer,
- Übergabe von `ways[wayId].elevationRiskTags` in den produktiven DGM1-Lauf,
- Speicherung der resultierenden robusten Profile im DEM-/Kontextartefakt,
- sichtbare Darstellung der Ausschluss- und Unsicherheitsgründe,
- reale Hannover-/QGIS-Goldprofile.
