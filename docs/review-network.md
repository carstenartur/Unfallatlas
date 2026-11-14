# Netzregister für die Stellensuche

Hannover stellt in **Stellen finden** das Netzregister zusätzlich zu den Prüfbereichen bereit. Es umfasst die im OpenStreetMap-Auszug kartierten Straßenabschnitte, Netzknoten mit mindestens drei Armen und ausdrücklich kartierten Querungen innerhalb der Stadtbezirksgrenzen. Abschnitte sind höchstens rund 250 m lang. Ein OSM-Knoten beschreibt eine Netzanbindung. Mehrere solcher Punkte können zu einem baulich zusammengehörenden Knoten gehören.

Jeder geladene Unfallpunkt wird höchstens einem Netzobjekt zugeordnet. Die Werkbank bevorzugt eine passende OSM-Wegzuordnung in der Nähe. Kandidaten mit ähnlich plausibler Lage werden als mehrdeutig ausgewiesen. Die Fallliste des Netzobjekts und die Unfallzahl im markierten Umfeld haben jeweils ihren eigenen Umfang. Die Lagezuordnung dient der Sichtung. Unfallhergänge, Verkehrsströme und Wirkungen einer Maßnahme brauchen eigene Belege.

Das Netzregister wird bei vollständigem Stadt-Unfalldatensatz geladen. Der öffentliche Build enthält die Daten und funktioniert mit den vorhandenen Browserfunktionen. Geteilte Links enthalten die Kennung des Netzobjekts, die Netzrevision, die Suchkriterien und das genaue Rechteck. Ist die verlinkte Revision nicht verfügbar, lässt sich das markierte Umfeld weiterhin betrachten.

## Einen Treffer einordnen

Die Detailansicht vergleicht den ausgewählten Knoten, die Querung oder den Abschnitt mit allen anderen Netzstellen desselben Typs in der Stadt. Für jede Stelle gelten dieselben Suchfilter. Angezeigt werden die Zahl der Stellen mit mehr beziehungsweise gleich vielen zugeordneten Unfällen sowie die Unfälle mit schweren und mit tödlichen Folgen am gewählten Ort. Auch Stellen ohne passende Fälle gehen in den Vergleich ein. Unterschiedliche Verkehrsmengen, die Länge der Abschnitte und die Bauform können die Fallzahlen beeinflussen.

Für Querungen können ausdrücklich kartierte OSM-Angaben zu Markierung, Beleuchtung, Signalisierung und Mittelinsel vorliegen. Im Netztyp-Filter lassen sich unbeleuchtete und unmarkierte Querungen auswählen, auch zusammen mit der Suche nach Stellen ohne zugeordneten Fall. Fehlende Angaben bleiben offen. Das optionale Merkmals-Paket verwendet dieselbe Netzrevision wie die Geometrie.

Die Detailansicht zeigt vorhandene geprüfte Verkehrszählungen und Modellwerte mit Einheit und Zeitraum. Für Hannover werden zusätzlich die über die Kartenebene lokal eingelesenen VMZ-Radzählstellen im ausgewählten Rechteck mit ihren gemeldeten Werten aus den gewählten Jahren angezeigt. Tages- und Monatswerte einer Station beschreiben den Verkehr an diesem Zählpunkt. Eine Unfallrate für die gesamte Kreuzung erfordert zusätzliche richtungs- und zeitraumbezogene Verkehrsmengen.

Für Brühlstraße / Escherstraße sind der Beschluss zur Aufpflasterung von 2021 und die Antworten zum Planungsstand von 2022 und 2023 hinterlegt. Der Generator ordnet solche geprüften Quellen über `networkSite.id` und die genaue Geometrie aus der städtischen Datei `<stadt>-discovery-sites.json` zu. Ändert sich der Bezugspunkt, wird die Zuordnung bis zur erneuten Prüfung ausgelassen. Das Datum einer Auskunft bezeichnet den damals berichteten Stand.

## Eine Stelle im Bezirk untersuchen

In **Stellen finden** stehen für Hannover und Bonn amtliche Stadtbezirke zur Auswahl. Ein Prüfbereich wird einem Bezirk zugeordnet, wenn er vollständig innerhalb der Bezirksgrenze liegt. In Hannover untersucht die Werkbank Netzobjekte, in Bonn räumliche Prüfbereiche. Ein weiterer Ort mit Bezirksgrenzen kann seine Geometrien über das bestehende Gremientemplate bereitstellen. Die vier Bonner Bezirksgeometrien der Bundesstadt Bonn stammen aus dem am 17. Oktober 2026 dokumentierten Datenbestand des Ratsatlas Bonn (CC0). Die Eingabedatei, ihr Prüfwert und der Link zur städtischen Quelle stehen im GeoJSON.

**Wiederkehrende Muster** erfordern mindestens drei passende Fälle aus mindestens zwei Jahren. **Schwere Folgen** ordnet nach der Zahl der Unfälle mit Getöteten oder Schwerverletzten. **Querungen im Schulumfeld** erfasst im Hannoveraner Netz ausdrücklich als unbeleuchtet oder unmarkiert kartierte Querungen bis 200 m Luftlinie vom Schulstandort, auch ohne zugeordnete Unfälle. Ein bestätigter Gehweg von Kindern und das tatsächliche Verkehrsaufkommen erfordern zusätzliche örtliche Quellen.

**Fall und weiteres Vorgehen** enthält einen Link, der auch nach dem erneuten Öffnen den ausgewählten Fall wiederherstellt. Datierte, geprüfte Quellen führen vom Beschluss bis zum jeweils belegten Umsetzungsstand. Die zusätzliche Ratsrecherche kann räumlich überlappende Dokumente mit ihren Originalquellen öffnen. Eine Straße kann länger als der gewählte Ausschnitt sein. Für die Bedeutung eines Vorgangs am konkreten Ort ist die Originalstelle maßgeblich. Die [Stichprobe für Hannover und Bonn](qa/2026-11-14-mapped-ris-audit.md) zeigt unter anderem einen amtlichen Kartenpunkt, der rund 489 m vom im Antrag genannten Knoten entfernt liegt.

**Wirkungskontrolle** benötigt ein belegtes Inbetriebnahmedatum. Ein eigener Quellenlink und Monat können in der Fallansicht ergänzt und mit dem Fall geteilt werden. Die Werkbank vergleicht je Seite bis zu drei aufeinanderfolgende, abgeschlossene Kalenderjahre der amtlichen Unfallatlas-Lieferung. Sie gleicht die Zahl der geladenen Stadtfälle für jedes Jahr mit dem veröffentlichten Jahresbestand ab. Bei privaten Importen ohne diesen Nachweis bleibt die Jahresabdeckung offen. Das Jahr der Inbetriebnahme bleibt außen vor. Es gelten derselbe Ort, dasselbe Zielmuster und dieselben inhaltlichen Filter. Die zeitliche Begrenzung der ursprünglichen Stellensuche wird für den Vergleich aufgehoben. Benachbarte Netzstellen desselben Typs und verfügbare Verkehrszählungen werden gesondert ausgewiesen. Die Fallzahlen allein erlauben keinen Schluss auf die ursächliche Wirkung. Bei fehlenden Jahrgängen zeigt die Werkbank, welche Jahre noch benötigt werden.

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
