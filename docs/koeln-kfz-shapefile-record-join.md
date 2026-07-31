# Positionsgleicher Join der Kölner Kfz-Zählwerte mit amtlicher Geometrie

Der Kölner Link-CSV-Provider erzeugt seit #568 typisierte, richtungsbezogene
Zählbeobachtungen. Das amtliche Shape-ZIP wird seit #578 als vollständiges,
hashgepinntes Archiv inventarisiert. `koeln_kfz_geometry_record_join_provider.js`
verbindet nun beide Quellen, ohne Feldnamen, Dateinamen oder Richtungen zu
erraten.

## Extern gepinntes Interpretationsschema

Die tatsächlichen Shape-Sets und DBF-Feldnamen werden in einer lokalen
UTF-8-JSON-Datei festgelegt. Deren SHA-256 muss beim Lauf separat angegeben
werden. Der Produktionspfad akzeptiert ausschließlich dieses exakte Schema:

```json
{
  "schemaVersion": 1,
  "type": "koeln-kfz-geometry-record-schema",
  "archiveSourceId": "traffic.geometry.koeln-kfz-2016-2019",
  "archiveSha256": "5672f1b61777ccbd5a1db6555dddf7c61a009eb161b13d4c7cbe530de9299238",
  "pointSet": {
    "id": "<geprüfter Basispfad des Punkt-Shapesets>",
    "nodeIdField": "<reales DBF-Knotenfeld>"
  },
  "lineSet": {
    "id": "<geprüfter Basispfad des Linien-Shapesets>",
    "segmentIdField": "<reales DBF-Segmentfeld>",
    "fromNodeIdField": "<reales Von-Knotenfeld>",
    "toNodeIdField": "<reales Nach-Knotenfeld>"
  },
  "encoding": "windows-1252",
  "crs": "EPSG:25832",
  "maxEndpointDistanceMeters": 5
}
```

Zusätzliche Felder im Schema werden abgewiesen. Damit kann kein späterer Lauf
stillschweigend eine vermeintliche Straßen-, Bezirks- oder OSM-Spalte deuten.

## Positionsgleicher Recordvertrag

- SHX liefert Offset und Länge jedes SHP-Records.
- SHP-Recordnummer, Inhaltslänge und Shape-Typ müssen exakt zum SHX passen.
- Punktsets unterstützen genau XY-Point-Records.
- Linien unterstützen XY-Polyline-Records; mehrteilige Linien werden nur
  verbunden, wenn aufeinanderfolgende Teile innerhalb der gepinnten
  Distanzgrenze zusammenhängen.
- DBF muss exakt gleich viele aktive Records besitzen.
- Gelöschte DBF-Zeilen, Leerwerte, unbekannte Kodierungen und fehlende
  Schemafelder brechen den Lauf ab.

Punkt-, Linien- und DBF-Record mit Index `n` werden ausschließlich miteinander
verbunden. Es gibt keine Suche nach ähnlich aussehenden IDs.

## Richtung

Die amtliche DBF-Linie wird gegen die referenzierten Von-/Nach-Knoten geprüft.
Ist ihre gespeicherte Punktreihenfolge umgekehrt, wird sie deterministisch
umgedreht. Beide gerichteten Geometrieschlüssel werden erzeugt:

```text
<segment>:<von-knoten>-><nach-knoten>
<segment>:<nach-knoten>-><von-knoten>
```

Das CSV-Merkmal `forward` oder `reverse` bleibt eine Eigenschaft der
Zählbeobachtung und ist bewusst **kein** Teil des amtlichen Geometrieschlüssels.
Damit funktionieren sowohl gemeinsame Segmentnummern für beide Richtungen als
auch eigene `R_NO`-Nummern, solange Segment und tatsächliche Knotenbeziehung im
Shape-Schema übereinstimmen.

## Koordinaten

EPSG:25832 und EPSG:32632 werden mit einer fest versionierten inversen
UTM-Zone-32-Transformation nach WGS84 überführt. Ausgaben außerhalb eines
plausiblen Deutschlandbereichs werden abgewiesen. Das Ergebnis ist eine
GeoJSON-`LineString`-Geometrie je Beobachtung.

## Vollständigkeitsgrenze

Jede typisierte CSV-Beobachtung muss eine amtliche gerichtete Geometrie erhalten.
Schon eine fehlende Zuordnung bricht den gesamten Lauf mit einem Coverage-Bericht
ab. Das Ergebnis bewahrt:

- beide Distributionshashes und Abrufzeitpunkte,
- Schema-Pfad und Schema-Hash,
- Shape-Recordnummer,
- Segment und gerichtete Knoten,
- Endpunktabstände,
- eventuelle Umkehrung der Quellgeometrie,
- CRS und Transformationskennung.

## Aufruf

```bash
node scripts/providers/koeln_kfz_geometry_record_join_provider.js \
  --schema-root /srv/unfallwerkbank/traffic/koeln \
  --schema koeln-shape-schema.json \
  --schema-sha256 <schema-hash> \
  --archive-root /srv/unfallwerkbank/traffic/koeln \
  --archive 'KFZ Zaehldaten 2016-2019_0.zip' \
  --archive-sha256 5672f1b61777ccbd5a1db6555dddf7c61a009eb161b13d4c7cbe530de9299238 \
  --archive-bytes <archiv-bytezahl> \
  --archive-retrieved-at <ISO> \
  --csv-root /srv/unfallwerkbank/traffic/koeln \
  --csv KFZ_Zaehldaten_2016-2019_link.csv \
  --csv-sha256 477da6900ee791b7b3db433e27d6bde778c2f138869198b448fb26827de65488 \
  --csv-bytes <csv-bytezahl> \
  --csv-retrieved-at <ISO> \
  --generated-at <ISO> \
  --output out/koeln-kfz-official-geometry.json
```

## Verbleibende Grenze von #413

Die resultierende `wayId` bleibt ausdrücklich die synthetische Kölner
Segmentkennung. Dieser Slice führt noch kein Distanz-/Richtungs-Matching auf
OpenStreetMap durch und interpoliert keine Messwerte auf benachbarte Straßen.
Der nächste Schritt kann die nun amtlich gerichteten WGS84-Linien mit
OSM-Ways vergleichen und dafür Distanz, Winkel, Knotenbezug und Konfidenz
separat ausweisen.
