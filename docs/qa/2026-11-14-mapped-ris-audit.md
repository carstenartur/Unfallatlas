# Stichprobe bereits kartierter Ratsvorgänge

Die Gegenprobe vom 14. November 2026 prüft, ob ein kartierter Vorgang tatsächlich einen örtlichen Verkehrsbezug hat und ob seine Geometrie zum beschriebenen Ort passt. Die Ziehung erfolgt aus allen als `mapped` oder `partial` geführten Vorgängen, einschließlich fachfremder Vorgänge mit Ortsangabe. Mehrere Kartenobjekte geben einem Vorgang keine zusätzliche Chance, gezogen zu werden.

| Stadtkatalog im Pages-Artefakt | Veröffentlichte Vorgänge | Mit Kartenbezug | Gezogene Vorgänge | Ortsurteil zu den vier verkehrsrelevanten Vorgängen |
|---|---:|---:|---:|---|
| Bonn, 7. November 2026 | 25.206 | 1.837 | 2 | 1 falsch, 1 offen |
| Hannover, 8. November 2026 | 109.605 | 7.896 | 2 | 2 zutreffend auf der angegebenen räumlichen Ebene |

## Prüfung am Original

| Vorgang | Abgleich |
|---|---|
| Bonn 261061, Parken an der Maarstraße | Der amtliche Datensatz enthält einen Punkt auf der Maarstraße. Eine Hausnummer oder ein konkreter Parkplatz fehlt in den geprüften Angaben. **Offen** bleibt, ob die Stelle selbst gemeint ist. [OParl-Vorgang](https://www.bonn.sitzung-online.de/oparl/papers/2027768) · [Straßenverlauf](https://www.openstreetmap.org/way/25428150) |
| Bonn 230218, Ladestation am Plittersdorfer Dorfplatz | **Falscher Punkt für das beschriebene Vorhaben.** Der amtlich gelieferte und unverändert veröffentlichte Punkt an der Steinstraße liegt rund 489 m vom im Antrag benannten Knoten mit der Plittersdorfer Straße entfernt. [OParl-Vorgang und Koordinaten](https://www.bonn.sitzung-online.de/oparl/papers/2010436) · [Vergleichsknoten](https://www.openstreetmap.org/node/96120720) |
| Hannover 15-0397/2016, abgestellte Fahrzeuge | **Beide Straßen als Orientierung zutreffend.** Der Antrag verlangt Kontrollen im Schachtebeckweg und Industrieweg. Die beiden abgeleiteten Straßenlinien kennzeichnet die Karte entsprechend. Für den Industrieweg nennt die Begründung einen engeren Abschnitt zwischen Wiesenauer Straße und Hackethalstraße. [Originalantrag](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0397-2016) · [Schachtebeckweg](https://www.openstreetmap.org/way/1056700937) · [Industrieweg](https://www.openstreetmap.org/way/427878326) |
| Hannover 15-1074/2020, Signalisierung am Lohweg | **Knoten zutreffend.** Der Antrag nennt die Einmündung des Lohwegs in die Höversche Straße. Der abgeleitete Punkt liegt rund 4 m vom kartierten gemeinsamen Straßenknoten entfernt. [Originalantrag](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1074-2020) · [Vergleichsknoten](https://www.openstreetmap.org/node/322128201) |

Die Prüfung nutzte für Bonn die öffentlichen OParl-Originale mit Betreff und Geodaten und für Hannover die amtlichen Antragstexte. Bei den beiden Kreuzungen wurde die Luftlinie zum gleichnamigen gemeinsamen Straßenknoten in OpenStreetMap berechnet. Der Datenvergleich ersetzt keine örtliche Vermessung. Aus vier Fällen lässt sich keine belastbare stadtweite Fehlerquote ableiten.

## Dieselbe Stichprobe wiederholen

Das lokale Verzeichnis `data/ris` enthält die beiden Manifeste und die zugehörigen komprimierten Partitionen aus dem [Pages-Lauf 43556414328](https://github.com/carstenartur/Unfallatlas/actions/runs/43556414328). Der Befehl liest die Dateien und gibt einen JSON-Bericht aus.

```sh
node scripts/audit-mapped-ris-locations.js \
  --seed 2026-11-14-mapped --size 2 \
  --reviews docs/qa/2026-11-14-mapped-ris-reviews.json \
  data/ris/bonn.json data/ris/hannover.json
```

Für eine neue Prüfrunde `--reviews` weglassen und Seed sowie Größe vor dem Lesen der Fälle festlegen. Voreingestellt sind 20 Vorgänge pro Stadt oder der gesamte kartierte Bestand, wenn er kleiner ist. Innerhalb einer Stadt ordnet der SHA-256-Wert aus Seed, Stadt und Vorgangs-ID die Fälle. Die Ergebnisdatei enthält den tatsächlichen Katalogumfang und die zeitliche und sachliche Abdeckung, Quelllinks, alle zugeordneten Geometrien, ihre kartografischen Herkunftsangaben sowie die ursprünglichen Ortsbelege einschließlich vorhandener Hausnummern. Jedes Urteil ist durch die `sampleId` an die konkrete Ziehung und die Hashes beider Manifeste gebunden.

Bei der Durchsicht für jeden Vorgang `relevance` (`yes`, `no`, `unclear`) für das Thema Verkehr im öffentlichen Raum und `location` (`correct`, `incorrect`, `unclear`) getrennt vergeben. Alle Kartenbezüge gegen die räumliche Aussage des Originals prüfen. Eine inhaltlich falsche Geometrie macht das Ortsurteil `incorrect`; lässt sich die notwendige Präzision bei einer der Geometrien nicht prüfen, lautet das Urteil `unclear`. Bei nur straßengenau bezeichneten Orientierungslinien dokumentiert die Begründung, wenn der Antrag einen engeren Abschnitt behandelt. Ein ungeprüfter Vorgang bleibt in der Liste der manuellen Entscheidungen ausgespart. Die beigefügte [Beurteilungsdatei](2026-11-14-mapped-ris-reviews.json) zeigt das Eingabeformat.

`relevantLocationPrecision` zählt pro Stadt exakt die zutreffenden unter den manuell als verkehrsrelevant und räumlich entscheidbar geprüften Vorgängen. Der Bericht weist offene Ortsurteile, fachfremde und ungeprüfte Vorgänge getrennt aus. Bei leerem Nenner ist der Anteil `null`. Wie viele relevante Fälle dem Katalog oder der Kartierung fehlen, kann diese Ziehung nicht bestimmen.
