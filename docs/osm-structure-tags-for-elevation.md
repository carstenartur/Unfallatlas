# OSM-Strukturtags als DGM-Sicherheitsgrenze

Ein digitales Geländemodell beschreibt die Geländeoberfläche. Bei Brücken,
Tunneln, Dämmen und Einschnitten kann diese Oberfläche erheblich von der
befahrenen Straße abweichen. Deshalb darf die Unfallwerkbank eine mit DGM1
berechnete Längsneigung erst als Fahrbahnkontext verwenden, wenn die zugehörige
OSM-Straße auf diese Strukturmerkmale geprüft wurde.

## Nachgelagerter Producer

`scripts/producers/osm_structure_producer.js` ergänzt ein bereits erzeugtes
`osm_<stadt>.json` um:

- `bridge`
- `tunnel`
- `layer`
- `embankment`
- `cutting`

Der bestehende Geometrieproducer bleibt unverändert. Der Nachlauf liest die
bereits ausgewählten Way-IDs und fragt sie gebündelt über Overpass ab:

```text
[out:json][timeout:180];
way(id:...);
out tags;
```

Dadurch werden weder Straßengeometrien noch Node-Listen ein zweites Mal
übertragen.

## Fail-closed-Coverage

Ein fehlendes `bridge`- oder `tunnel`-Tag darf nur dann als „nicht gesetzt“
interpretiert werden, wenn **jeder** angefragte Way in der Overpass-Antwort
vorhanden war. Der Producer bricht deshalb ab bei:

- fehlenden Ways,
- zusätzlichen, nicht angefragten Ways,
- doppelten IDs,
- Nicht-Way-Elementen,
- ungültigen oder nicht sicher darstellbaren IDs,
- unvollständiger lokaler Way-Tabelle.

Erst bei exakter Coverage entsteht der Top-Level-Vertrag:

```json
{
  "structureTags": {
    "schemaVersion": 1,
    "producerVersion": "1.0.0",
    "source": "OpenStreetMap (Overpass)",
    "licenseId": "ODbL-1.0",
    "coverage": "full",
    "wayCount": 1234,
    "fields": ["bridge", "tunnel", "layer", "embankment", "cutting"],
    "queryFingerprint": "..."
  }
}
```

Die Abwesenheit eines Feldes in `ways[wayId]` ist erst zusammen mit diesem
`coverage: "full"` belastbar.

## Lokale Verwendung

```bash
node scripts/producers/osm_structure_producer.js \
  --input .enrichment-cache/osm/osm_hannover.json
```

Standardmäßig wird die Datei atomar ersetzt. Mit `--output` kann eine getrennte
Ausgabe erzeugt werden. `--batch-size` und `--delay` steuern gebündelte,
höfliche Overpass-Aufrufe. Bereits vollständig angereicherte Dateien werden
ohne `--force` übersprungen.

## Provenienz

Der Lauf bewahrt den SHA-256 des OSM-Artefakts vor der Anreicherung und meldet
zusätzlich den finalen Hash. `queryFingerprint` bindet die sortierte Way-Menge
und die geprüften Strukturfelder. Die eigentlichen Live-Antworten bleiben
zeitabhängiger OSM-Kontext und werden nicht als amtliche DGM-Quelle dargestellt.

## Noch offen in #412

Dieser Slice schafft die notwendige Struktur-Coverage. Für die vollständige
DGM1-Produktion fehlen weiterhin:

- Einbindung des Nachlaufs in den kanonischen lokalen Kontextdaten-Befehl;
- Übergabe der Way-Tags an `computeRoadGradient`;
- vollständiger Ausschluss von Brücken und Tunneln sowie sichtbare Abwertung
  von Dämmen und Einschnitten im erzeugten DEM-Artefakt;
- reale Hannover-Goldprofile und QGIS-Vergleiche;
- produktive Registrierung des hashgepinnten DGM1-Snapshots.
