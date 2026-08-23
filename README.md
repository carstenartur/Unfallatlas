# Unfallwerkbank – Verkehrsunfälle räumlich untersuchen und nachvollziehbar teilen

> **Wo häufen sich Unfälle? Welche Beteiligten sind betroffen? Liegen auffällige Stellen an Schulen, Kitas oder bestimmten Straßenabschnitten?**
>
> Die Unfallwerkbank macht amtliche Unfallatlas-Daten als interaktive Karte nutzbar. Eine Analyse lässt sich direkt im Browser öffnen, als reproduzierbarer Link weitergeben und als Daten- oder Dokumentexport sichern.

[![CI](https://github.com/carstenartur/Unfallatlas/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/carstenartur/Unfallatlas/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/carstenartur/Unfallatlas?sort=semver&label=Release)](https://github.com/carstenartur/Unfallatlas/releases/latest)
[![License](https://img.shields.io/github/license/carstenartur/Unfallatlas)](LICENSE)

[![Rad-Pkw-Unfälle am Bonner Hauptbahnhof als Heatmap](docs/screenshots/13-bonn-hbf-radunfaelle.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=1&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010)

**[Werkbank öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Hannover&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&maxPoints=100000&viewportPaddingPct=20&heatRadius=25&includeCyclist=1&includePedestrian=1&includeCar=1&includeMotorcycle=0&includeGkfz=0&includeSonstig=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&showSchools=1&showKindergartens=1&showArgumentation=1&mapMode=standard&orthophotoOpacity=92&centerLat=52.3759&centerLon=9.7320&zoom=12)** ·
**[Nutzungsanleitung](docs/DOKUMENTATION.md)** ·
**[Praxisbeispiele](docs/DOKUMENTATION.md#praxisbeispiele)** ·
**[Datenstatus](https://carstenartur.github.io/Unfallatlas/data-status/)**

*Klick auf einen Screenshot öffnet die gezeigte Stadt, den Kartenausschnitt und die zugehörigen Filter in der Werkbank.*

---

## Wofür ist die Unfallwerkbank gedacht?

Die Werkbank unterstützt die Vorbereitung und Diskussion konkreter Fragen zur kommunalen Verkehrssicherheit:

- Unfallhäufungen in einer Stadt oder einem markierten Bereich erkennen,
- Beteiligungskombinationen wie **Rad + Pkw** oder **Fahrrad-Alleinunfälle** untersuchen,
- Tageszeit, Wochentag, Unfallschwere und Fahrbahnzustand filtern,
- Schulen, Kitas und verfügbare Straßen- oder Geländekontexte einbeziehen,
- eine Analyse per URL teilen oder als CSV, GeoJSON, KML, Word beziehungsweise PDF exportieren.

Sie richtet sich unter anderem an Kommunalpolitik, Verkehrsplanung, Verwaltungen, Verbände, Initiativen, Forschung und Journalismus. Die Werkbank liefert eine **Analyse- und Argumentationshilfe**, aber keinen automatischen Kausalitätsnachweis und keine fertige verkehrsrechtliche Bewertung.

## In drei Minuten zur ersten Analyse

1. **[Öffentliche Browser-Version öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Hannover&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&maxPoints=100000&viewportPaddingPct=20&heatRadius=25&includeCyclist=1&includePedestrian=1&includeCar=1&includeMotorcycle=0&includeGkfz=0&includeSonstig=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&showSchools=1&showKindergartens=1&showArgumentation=1&mapMode=standard&orthophotoOpacity=92&centerLat=52.3759&centerLon=9.7320&zoom=12).**
2. Links eine Stadt wählen und die gewünschten Beteiligten aktivieren.
3. **ODER**, **UND** oder **Alleinunfall** passend zur Fragestellung einstellen.
4. Karte verschieben oder mit **Bereich markieren** einen Ausschnitt festlegen.
5. Zwischen Cluster, Heatmap und den verfügbaren Kartenansichten wechseln.
6. Über **Analyse/Export öffnen** Ergebnisse prüfen, herunterladen oder den Link kopieren.

Die URL speichert den adressierbaren Analysezustand. Dadurch können andere Personen dieselbe Stadt, Auswahl, Kartenposition und Filterkombination öffnen.

## Der Ablauf als kurze Animation

[![Demo-Ablauf der Unfallwerkbank: Stadt wählen, filtern, Karte untersuchen und exportieren](docs/demo.gif)](docs/demo.gif)

Die Animation zeigt einen zusammenhängenden realen Ablauf aus dem aktuellen Server-/Docker-Build: Stadt und Filter setzen, den Kartenausschnitt untersuchen, einen Bereich markieren und die Analyse- und Exportansicht öffnen.

---

## Typische Analysen

### Rad- und Pkw-Beteiligung an einem konkreten Ort

Die markierte Heatmap am Bonner Hauptbahnhof zeigt nur Unfälle, an denen sowohl Rad- als auch Pkw-Verkehr beteiligt waren.

[→ Bonn-Hbf-Analyse in der öffentlichen Browser-Version öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=1&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010)

[![Rad-Pkw-Heatmap mit markiertem Bereich am Bonner Hauptbahnhof](docs/screenshots/13-bonn-hbf-radunfaelle.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=1&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010)

### Fahrrad-Alleinunfälle

Der Alleinunfall-Modus blendet Unfälle mit anderen erfassten Beteiligungsarten aus. Häufungen können ein Anlass sein, Belag, Führung, Kanten, Gleise oder andere örtliche Bedingungen genauer zu prüfen.

[![Fahrrad-Alleinunfälle in Bonn](docs/screenshots/11-fahrrad-alleinunfaelle.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=0&includeMotorcycle=0&involvementMode=solo&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7350&centerLon=7.1000&zoom=13)

### Schul- und Kita-Umfeld

Bei ausreichender Zoomstufe lassen sich Schulen und Kitas zusammen mit den gefilterten Unfallstellen betrachten.

[![Rad- und Fußverkehrsunfälle mit Schulen und Kitas in Bonn](docs/screenshots/12-poi-schulen-kitas.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7350&centerLon=7.0950&zoom=16)

### Vom Kartenausschnitt zum Bericht

Die folgende Konfiguration begrenzt Rad-Pkw-Unfälle auf 6–18 Uhr und einen markierten Bereich. Nach dem Öffnen **Analyse/Export öffnen** wählen.

[→ Öffentliche Werkbank für Export öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18&centerLat=50.7330&centerLon=7.0950&zoom=15&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000)

[![Exportansicht mit sichtbarem Filter- und Ortskontext](docs/screenshots/14-export-filterkontext.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18&centerLat=50.7330&centerLon=7.0950&zoom=15&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000)

Der Dokumentexport übernimmt Filter, räumliche Auswahl, Statistik und – soweit verfügbar – Karten- und Kontextinformationen.

[![Gerenderte Vorschau eines PDF-Exports](docs/screenshots/15-export-pdf-rendered.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7330&centerLon=7.0950&zoom=15&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000)

Die [Nutzungsanleitung](docs/DOKUMENTATION.md) erklärt die einzelnen Schritte, Darstellungen und Grenzen ausführlich.

---

## Was die Ergebnisse aussagen – und was nicht

Die Werkbank arbeitet mit den veröffentlichten, polizeilich erfassten Unfallorten und den darin enthaltenen Merkmalen. Daraus folgen wichtige Grenzen:

- Nicht gemeldete oder nicht im Datensatz enthaltene Ereignisse bleiben unsichtbar.
- Eine räumliche Häufung oder ein Kontextmerkmal beweist keine Unfallursache.
- Kleine Fallzahlen und stark gewählte Filter können zu instabilen Prozentwerten führen.
- Schulen und Kitas sowie Straßenattribute stammen, soweit verwendet, aus OpenStreetMap.
- Die angezeigte Verkehrsklasse ist bei entsprechenden Kontextdaten ein **projektinterner OSM-Proxy**, keine gemessene Verkehrsdichte.

Für Entscheidungen sollten Karte und Export mit Ortskenntnis, aktuellen Planungen, Verkehrsbelastungen und einer fachlichen Einzelfallprüfung verbunden werden. Mehr dazu: [Methodik und Grenzen](docs/DOKUMENTATION.md#methodik-und-grenzen).

## Verfügbarkeit und Aktualität

Der derzeit eingecheckte und geprüfte Unfalldatenbestand umfasst die Jahrgänge **2016–2025**. Aktualisierungen werden nicht direkt nach `main` geschrieben, sondern zunächst in einem automatischen **Pull Request** zur Prüfung bereitgestellt.

Welche Städte, Jahrgänge und Zusatzdaten verfügbar sind, kann sich unterscheiden:

- [Datenstatus und Aktualität](https://carstenartur.github.io/Unfallatlas/data-status/)
- [Städte- und Regionen-Katalog](docs/CITY_CATALOG.md)
- [Datenherkunft und Aktualisierungsverfahren](DATA_STATUS.md)

Die technischen Aktualisierungsabläufe stehen bewusst nicht am Anfang dieser README. Sie sind für Betreiber:innen und Mitwirkende in den verlinkten Betriebs- und Entwicklungsdokumenten beschrieben.

## Dokumentation nach Aufgabe

| Ziel | Einstieg |
|---|---|
| Werkbank bedienen und Beispiele nachspielen | [Nutzungsanleitung](docs/DOKUMENTATION.md) |
| Einen Maßnahmen-Steckbrief verstehen | [Maßnahmen-Steckbriefe](docs/LOCATION_BRIEF.md) |
| Verfügbarkeit einer Stadt prüfen | [Städte-/Regionen-Katalog](docs/CITY_CATALOG.md) |
| Daten und Skripte außerhalb der Weboberfläche nutzen | [CLI-Nutzung](usage.md) |
| Unfallwerkbank selbst betreiben | [Docker und Serverbetrieb](docs/docker.md) |
| Architektur, Tests oder Code ändern | [Entwicklungs- und Architekturübersicht](ARCHITECTURE.md) |
| Daten aktualisieren oder veröffentlichen | [Datenstatus und Veröffentlichungsprozess](DATA_STATUS.md) |

Weitere fachliche und technische Dokumente sind unter [`docs/`](docs/) abgelegt. Die README bleibt absichtlich auf den Nutzen und den schnellsten Einstieg konzentriert.

---

## Datenquelle und Lizenz

Die Unfalldaten stammen aus dem [Unfallatlas des Statistikportals der deutschen Bundesländer](https://unfallatlas.statistikportal.de/) und werden unter der [Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0) verwendet. Karten- und POI-Inhalte können Daten von OpenStreetMap-Mitwirkenden enthalten.

- Projektlizenz: [Apache License 2.0](LICENSE)
- Credits und Drittkomponenten: [docs/credits.md](docs/credits.md)
- Zitierfähige Veröffentlichung: https://doi.org/10.5281/zenodo.20936471
