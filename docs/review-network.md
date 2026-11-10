# Netzregister für die Stellensuche

Hannover stellt in **Stellen finden** das Netzregister zusätzlich zu den Prüfbereichen bereit. Es umfasst die im OpenStreetMap-Auszug kartierten Straßenabschnitte, Netzknoten mit mindestens drei Armen und ausdrücklich kartierten Querungen innerhalb der Stadtbezirksgrenzen. Abschnitte sind höchstens rund 250 m lang. Ein OSM-Knoten beschreibt eine Netzanbindung. Mehrere solcher Punkte können zu einem baulich zusammengehörenden Knoten gehören.

Jeder geladene Unfallpunkt wird höchstens einem Netzobjekt zugeordnet. Die Werkbank bevorzugt eine passende OSM-Wegzuordnung in der Nähe. Kandidaten mit ähnlich plausibler Lage werden als mehrdeutig ausgewiesen. Die Fallliste des Netzobjekts und die Unfallzahl im markierten Umfeld haben jeweils ihren eigenen Umfang. Die Lagezuordnung dient der Sichtung. Unfallhergänge, Verkehrsströme und Wirkungen einer Maßnahme brauchen eigene Belege.

Das Netzregister wird bei vollständigem Stadt-Unfalldatensatz geladen. Der öffentliche Build enthält die Daten und funktioniert mit den vorhandenen Browserfunktionen. Geteilte Links enthalten die Kennung des Netzobjekts, die Netzrevision, die Suchkriterien und das genaue Rechteck. Ist die verlinkte Revision nicht verfügbar, lässt sich das markierte Umfeld weiterhin betrachten.

## Einen Treffer einordnen

Die Detailansicht vergleicht den ausgewählten Knoten, die Querung oder den Abschnitt mit allen anderen Netzstellen desselben Typs in der Stadt. Für jede Stelle gelten dieselben Suchfilter. Angezeigt werden die Zahl der Stellen mit mehr beziehungsweise gleich vielen zugeordneten Unfällen sowie die Unfälle mit schweren und mit tödlichen Folgen am gewählten Ort. Auch Stellen ohne passende Fälle gehen in den Vergleich ein. Unterschiedliche Verkehrsmengen, die Länge der Abschnitte und die Bauform können die Fallzahlen beeinflussen.

Für Querungen können ausdrücklich kartierte OSM-Angaben zu Markierung, Beleuchtung, Signalisierung und Mittelinsel vorliegen. Im Netztyp-Filter lassen sich unbeleuchtete und unmarkierte Querungen auswählen, auch zusammen mit der Suche nach Stellen ohne zugeordneten Fall. Fehlende Angaben bleiben offen. Das optionale Merkmals-Paket verwendet dieselbe Netzrevision wie die Geometrie.

Die Detailansicht zeigt vorhandene geprüfte Verkehrszählungen und Modellwerte mit Einheit und Zeitraum. Für Hannover werden zusätzlich die über die Kartenebene lokal eingelesenen VMZ-Radzählstellen im ausgewählten Rechteck mit ihren gemeldeten Werten aus den gewählten Jahren angezeigt. Tages- und Monatswerte einer Station beschreiben den Verkehr an diesem Zählpunkt. Eine Unfallrate für die gesamte Kreuzung erfordert zusätzliche richtungs- und zeitraumbezogene Verkehrsmengen.

## Eine weitere Stadt hinzufügen

Der Katalog unter `data/mobility/review-network/` enthält die freigeschalteten Städte. Der Generator erstellt den Eintrag, den Index und die komprimierten Teile in einem Durchlauf. Der Stadtschlüssel entspricht den vorhandenen Unfalldaten, etwa `frankfurt_am_main`. Eingaben sind ein datierter OSM-XML-Auszug und ein WGS84-Grenzdatensatz mit Herkunft und Lizenz.

```sh
python3 scripts/build-review-network.py \
  --city hannover \
  --osm /pfad/zu/Hannover.osm.gz \
  --boundary data/mobility/hannover-stadtbezirke.geojson \
  --source-url https://download.bbbike.org/osm/bbbike/Hannover/Hannover.osm.gz \
  --source-label '© OpenStreetMap contributors (ODbL 1.0), BBBike-Auszug Hannover' \
  --source-date 2026-11-08 \
  --source-sha256 9e9ee00893c266184ee2d66686b4bc5144ca9a7aa07912ce0aeb591b1cefbb38
```

Der Index verweist auf die Quelle und Lizenz. Die erzeugten OSM-Netzobjekte stehen unter der ODbL 1.0. Für die Hannover-Bezirksgrenze ist die separate Attribution der Landeshauptstadt im Index enthalten. Für eine Reproduktion wird der Auszug mit dem angegebenen Hash benötigt. Städte ohne Katalogeintrag verwenden die Suche nach Prüfbereichen.
