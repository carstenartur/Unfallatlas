# Unfallwerkbank V2 – Dokumentation

## Überblick

Die **Unfallwerkbank V2** ist eine interaktive Webanwendung zur Visualisierung und Analyse
von [Unfallatlas](https://unfallatlas.statistikportal.de/)-Daten (Open Data) für deutsche Städte.
Sie ermöglicht:

- **Filterung** nach Stadt, Unfallschwere, Beteiligungsart (Rad, Fuß, PKW, Krad), Uhrzeit und Straßenzustand
- **Darstellung** der Unfälle als Cluster-Karte oder Heatmap
- **Bereich markieren** – gezieltes Auswählen eines Kartenausschnitts für die Auswertung
- **POI-Anzeige** – Schulen, Kindergärten und Kitas in der Nähe von Unfallschwerpunkten sichtbar machen
- **Export** als PDF oder Word-Dokument – z. B. als Vorlage für Bezirksratsanträge

![Startansicht der Unfallwerkbank V2](screenshots/01-startansicht.png)

---

## Voraussetzungen

- Moderner Webbrowser (Chrome, Firefox oder Edge empfohlen)
- Für lokale Nutzung: Python 3 (`python3 -m http.server 8000`) oder ein anderer lokaler Webserver
- Internetverbindung (für Kartenkacheln und Unfallatlas-Daten)

---

## Schnellstart

```bash
# Repository klonen
git clone https://github.com/carstenartur/Unfallatlas.git
cd Unfallatlas

# Lokalen Webserver starten
python3 -m http.server 8000

# Anwendung im Browser öffnen
# http://localhost:8000/werkbank_v2.html
```

---

## Benutzeroberfläche

Nach dem Öffnen der Seite erscheint die Kartenansicht links und das Steuerungspanel rechts.

![Startansicht](screenshots/01-startansicht.png)

| Bereich | Beschreibung |
|---|---|
| **Karte (links)** | Interaktive Leaflet-Karte mit Unfallpunkten |
| **Steuerungspanel (rechts)** | Filter, Anzeigemodi, Zeichnen und Export |

---

## Funktionen im Detail

### Stadtauswahl

Wähle im Dropdown **Stadt** eine Stadt aus. Die Unfalldaten werden automatisch vom
Unfallatlas geladen und auf der Karte angezeigt.

![Stadtauswahl](screenshots/02-stadtauswahl.png)

---

### Unfallschwere filtern

Im Feld **Unfallschwere** kann nach Schweregrad gefiltert werden:

| Wert | Beschreibung |
|---|---|
| (alle) | Alle Schweregrade anzeigen |
| 1 | Getötete |
| 2 | Schwerverletzt |
| 3 | Leichtverletzt |

---

### Beteiligung filtern

Die Checkboxen unter **Beteiligung** schränken die Anzeige auf bestimmte Unfallbeteiligte ein:

- 🚲 **Rad** – Fahrradunfälle
- 🚶 **Fuß** – Fußgängerunfälle
- 🚗 **PKW** – Pkw-Unfälle
- 🏍️ **Krad** – Motorradunfälle

Die Verknüpfung mehrerer Filter wird über die **Modus-Buttons** gesteuert:

| Modus | Bedeutung | Beispiel |
|---|---|---|
| **ODER** | Mindestens eine der gewählten Beteiligungsarten | 🚲 ODER 🚗 → zeigt Unfälle, an denen Rad *oder* PKW beteiligt war |
| **UND** | Alle gewählten Beteiligungsarten gleichzeitig beteiligt | 🚲 UND 🚗 → zeigt nur Unfälle, an denen Rad *und* PKW beteiligt waren |
| **Alleinunfall** | Nur Alleinunfälle der gewählten Art | 🚲 Alleinunfall → Fahrradunfälle ohne andere Beteiligung |

![Beteiligung und Filter](screenshots/03-filter.png)

#### Filterkombinationen – Praxisbeispiele

Durch geschickte Kombination der Filter lassen sich gezielte Fragestellungen beantworten:

| Fragestellung | Einstellung | Screenshot |
|---|---|---|
| Wo kollidieren Autos mit Fahrrädern? | 🚲 + 🚗 im **UND**-Modus | ![Auto+Fahrrad UND](screenshots/10-auto-fahrrad-und.png) |
| Wo stürzen Radfahrer ohne Fremdbeteiligung? | Nur 🚲 im **Alleinunfall**-Modus | ![Fahrrad-Alleinunfälle](screenshots/11-fahrrad-alleinunfaelle.png) |
| Wo sind Fußgänger und Radfahrer gefährdet? | 🚲 + 🚶 im **ODER**-Modus | Standard-Ansicht mit beiden Checkboxen |

**Auto+Fahrrad-Unfälle (UND-Modus)** zeigen Stellen, an denen es regelmäßig zu Kollisionen zwischen Pkw und Rad kommt – ein typischer Hinweis auf fehlende oder unzureichende Radinfrastruktur.

**Fahrrad-Alleinunfälle** deuten häufig auf schlechte Fahrbahnoberfläche, gefährliche Bordsteinkanten oder unübersichtliche Radwegführung hin. Diese Unfälle werden oft übersehen, weil kein Unfallgegner beteiligt ist.

---

### Zeitfilter

Mit den **Stundenbereich-Slidern** kann der Anzeigezeitraum auf bestimmte Tagesstunden
eingeschränkt werden (z. B. 6–18 Uhr für den Berufsverkehr).

![Stundenfilter](screenshots/08-stundenfilter.png)

Zusätzlich kann über **Wochentag** (alle / Wochenende / Werktag) und **Fahrbahnzustand**
(trocken / nass / winterglatt) weiter eingegrenzt werden.

---

### Cluster-Ansicht

In der Standard-**Cluster-Ansicht** werden Unfälle als farbige Kreise zusammengefasst.
Ein Klick auf einen Cluster vergrößert die Ansicht und zeigt Einzelpunkte.

![Cluster-Ansicht](screenshots/04-cluster-ansicht.png)

---

### Heatmap-Ansicht

Über den Button **Heatmap** wird die Darstellung auf eine Dichteverteilung umgeschaltet.
Rot eingefärbte Bereiche entsprechen Unfallschwerpunkten.

![Heatmap-Ansicht](screenshots/05-heatmap-ansicht.png)

---

### Legende

Ein Klick auf **Legende** (i-Button) öffnet eine Erklärung der verwendeten Farben und Symbole.

![Legende](screenshots/06-legende.png)

---

### Bereich markieren (Zeichnen)

Mit **Bereich markieren** kann ein Rechteck auf der Karte gezeichnet werden. Die Auswertung
und der Export beziehen sich dann nur auf die Unfälle innerhalb dieses Bereichs.
**Markierung löschen** entfernt das Rechteck wieder.

Der markierte Bereich wird auch in der URL gespeichert (Parameter `selSouth`, `selWest`,
`selNorth`, `selEast`), sodass die exakte Auswahl per Link geteilt werden kann.

![Bereich markieren](screenshots/09-bereich-markieren.png)

> **Tipp:** Ohne markierten Bereich bezieht sich der Export auf den aktuell sichtbaren
> Kartenausschnitt (Viewport). Für gezielte Analysen empfiehlt es sich, immer einen Bereich
> zu markieren.

---

### POI-Ansicht: Schulen und Kindergärten

Ab **Zoomstufe 15** werden automatisch **Schulen** 🏫 und **Kindergärten/Kitas** 🧒 als
Symbole auf der Karte eingeblendet. Diese Informationen stammen aus OpenStreetMap und werden
pro Stadt als GeoJSON bereitgestellt.

![POI-Ansicht mit Schulen und Kitas](screenshots/12-poi-schulen-kitas.png)

**Warum werden Schulen und Kitas angezeigt?**

Unfälle in der Nähe von Bildungseinrichtungen haben eine besondere Relevanz:

- **Kinder und Jugendliche** sind als Verkehrsteilnehmer besonders gefährdet
- **Schulwege** erfordern erhöhte Sicherheitsmaßnahmen
- In **Bezirksratsanträgen** verstärkt die Nähe zu sensiblen Einrichtungen die
  Dringlichkeit einer Maßnahme

Die Export-Funktion analysiert automatisch, wie viele Schulen und Kitas im markierten Bereich
und in einem Umkreis von 200 m liegen. Diese Information fließt als Abschnitt
**„Sensible Einrichtungen"** in den Export ein.

---

### Export und Bezirksratsantrag

Ein Klick auf **Analyse/Export öffnen** öffnet das Export-Modal.

![Export-Modal](screenshots/07-export-modal.png)

#### Warum ein Bezirksratsantrag?

Die Werkbank generiert einen **Entwurf für einen Bezirksratsantrag**. In vielen deutschen
Kommunen ist der Bezirksrat (oder Ortsrat / Stadtteilbeirat) das Gremium, das konkret
Verkehrssicherheitsmaßnahmen in einem Stadtteil beantragen kann. Ein typischer Antrag
enthält:

1. **Sachverhalt** – Beschreibung des Problems mit Daten
2. **Beschlussvorschlag** – Was die Verwaltung tun soll
3. **Datenquelle** – Nachweis, dass die Analyse auf amtlichen Daten basiert

Die Werkbank erstellt diesen Text automatisch auf Basis der aktuell eingestellten Filter
und des markierten Bereichs. Der Antrag ist als **Entwurf** gedacht und soll vor dem
Einreichen von der antragstellenden Person überarbeitet und ergänzt werden.

#### Zusammenhang zwischen Filtern und Export

Der Export-Text spiegelt die aktuellen Einstellungen wider:

| Einstellung | Wirkung im Export |
|---|---|
| **Stadt** | Name der Stadt im Betreff und Sachverhalt |
| **Unfallschwere** | Statistik zu Getöteten / Schwer- / Leichtverletzten im Bereich |
| **Beteiligung + Modus** | Analyse der Beteiligungskombinationen: welche Kombinationen (z. B. Rad+PKW) sind im markierten Bereich *überrepräsentiert* verglichen mit dem Stadtdurchschnitt |
| **Zeitfilter** | Nur Unfälle im gewählten Stundenbereich fließen in die Statistik ein |
| **Fahrbahnzustand** | Nur Unfälle bei gewähltem Zustand werden ausgewertet |
| **Markierter Bereich** | Vergleich: Unfälle im Bereich vs. gleiche Filter stadtweit |
| **POIs (Schulen/Kitas)** | Abschnitt „Sensible Einrichtungen" – Anzahl der Schulen/Kitas im Bereich und im 200-m-Umkreis |
| **Referenzdokumente** | Abschnitt mit Bezugsdokumenten (wenn Checkbox aktiv) |

![Export mit Filterkontext](screenshots/14-export-filterkontext.png)

#### Export-Optionen

| Option | Beschreibung |
|---|---|
| **Kartenausschnitt** | Kartenbild in den Export aufnehmen |
| **POIs (Schulen/Kitas)** | Analyse sensibler Einrichtungen im Bereich einbeziehen |
| **Referenzdokumente** | Verweise auf Quellen und Bezugsdokumente |
| **Als Word exportieren** | `.docx`-Datei herunterladen |
| **Als PDF exportieren** | PDF-Datei herunterladen |
| **Text kopieren** | Berichtstext in die Zwischenablage kopieren |
| **Link kopieren** | Direkt-Link zur aktuellen Ansicht kopieren |

Der generierte **Link** enthält alle Filtereinstellungen und den markierten Bereich als
URL-Parameter. So kann die exakte Analyse jederzeit reproduziert und an andere Personen
weitergegeben werden.

---

## Praxisbeispiele: Unfallanalyse in Bonn

Die folgenden Beispiele zeigen typische Analysen in Bonn. Die Links öffnen die Werkbank
mit den voreingestellten Filtern und dem passenden Kartenausschnitt.

> **Hinweis:** Die Links verwenden relative Pfade und funktionieren, wenn die Dokumentation
> aus dem Repository-Stammverzeichnis heraus geöffnet wird (z. B. über einen lokalen Server).

### Beispiel 1: Auto-Fahrrad-Kollisionen am Hauptbahnhof Bonn

Der Bereich rund um den Bonner Hauptbahnhof ist ein Knotenpunkt mit starkem Mischverkehr.
Hier kreuzen sich Rad- und Autoverkehr an mehreren Stellen.

**Filter:** 🚲 Rad + 🚗 PKW im **UND**-Modus, Heatmap aktiv, Bereich markiert

[→ Werkbank öffnen](werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=1&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010)

![Bonn Hbf – Rad+Auto-Unfälle](screenshots/13-bonn-hbf-radunfaelle.png)

**Einordnung:** Die Heatmap zeigt Häufungen von Rad-PKW-Kollisionen in unmittelbarer
Nähe des Bahnhofs. Solche Stellen sind typische Kandidaten für bauliche Maßnahmen wie
geschützte Radstreifen oder Abbiegeassistenzsysteme. Im Export-Text würde die Werkbank
automatisch berechnen, ob die Quote der Rad+PKW-Unfälle hier höher ist als im
Bonner Stadtdurchschnitt.

---

### Beispiel 2: Fahrrad-Alleinunfälle in Bonn

Alleinunfälle werden in der Verkehrsplanung oft unterschätzt, deuten aber auf
infrastrukturelle Mängel hin (schlechter Belag, Bordsteinkanten, Gleise).

**Filter:** Nur 🚲 Rad im **Alleinunfall**-Modus

[→ Werkbank öffnen](werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=0&includeMotorcycle=0&involvementMode=solo&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7350&centerLon=7.1000&zoom=13)

![Fahrrad-Alleinunfälle in Bonn](screenshots/11-fahrrad-alleinunfaelle.png)

**Einordnung:** Die Cluster zeigen, wo Radfahrer ohne Fremdbeteiligung verunfallen.
Häufungen können auf problematische Streckenabschnitte hinweisen. Durch Kombination
mit dem Fahrbahnzustand-Filter (z. B. „Nass/feucht") lassen sich wetterbedingte
Sturzstellen identifizieren.

---

### Beispiel 3: Unfälle in der Nähe von Schulen (Rad+Fuß, Berufsverkehr)

Unfälle im Umfeld von Schulen sind besonders besorgniserregend. Die POI-Anzeige
macht sichtbar, welche Einrichtungen betroffen sind.

**Filter:** 🚲 Rad + 🚶 Fuß im **ODER**-Modus, Uhrzeit 6–18 Uhr (Schulzeiten), Zoom 16

[→ Werkbank öffnen](werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18&centerLat=50.7350&centerLon=7.0950&zoom=16)

![POI-Ansicht mit Schulen und Kitas](screenshots/12-poi-schulen-kitas.png)

**Einordnung:** Ab Zoomstufe 15 werden Schulen 🏫 und Kitas 🧒 eingeblendet. So wird
sofort sichtbar, ob Unfallhäufungen im direkten Umfeld von Bildungseinrichtungen liegen.
Dies ist ein starkes Argument in Bezirksratsanträgen, da die Sicherheit von Kindern
auf dem Schulweg politisch höchste Priorität hat.

---

### Beispiel 4: Kompletter Workflow – vom Filter zum Bezirksratsantrag

Dieses Beispiel zeigt den typischen Ablauf von der Analyse bis zum fertigen Antrag:

1. **Stadt wählen:** Bonn auswählen
2. **Filter setzen:** 🚲 Rad + 🚗 PKW, UND-Modus, Uhrzeit 6–18 Uhr (Berufsverkehr)
3. **Bereich markieren:** Rechteck um den Bereich rund um den Hauptbahnhof zeichnen
4. **Analysieren:** Die Cluster/Heatmap zeigt Häufungen. POIs (Schulen/Kitas) werden sichtbar.
5. **Export öffnen:** Klick auf „Analyse/Export öffnen"

[→ Workflow nachspielen](werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18&centerLat=50.7330&centerLon=7.0950&zoom=15&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000)

![Export mit Filterkontext – Bonn Hbf](screenshots/14-export-filterkontext.png)

**Was passiert im Export:**

- Die Werkbank vergleicht die Unfälle **im markierten Bereich** mit dem **Bonner Stadtdurchschnitt** (bei gleichen Filtern für Schwere, Tageszeit und Fahrbahnzustand)
- Sie berechnet, welche **Beteiligungskombinationen überrepräsentiert** sind (z. B. „Rad+PKW-Unfälle sind hier 2,3× häufiger als im Stadtdurchschnitt")
- Sie listet **Schulen und Kitas** im Bereich und im 200-m-Umkreis auf
- Sie generiert einen **Bezirksratsantrag-Entwurf** mit Sachverhalt, Beschlussvorschlag und Datenquelle
- Der Export enthält einen **Link**, der die exakt gleiche Ansicht reproduziert

> **Wichtig:** Der Export-Text ist ein Entwurf. Vor dem Einreichen sollte er an die
> lokalen Gegebenheiten angepasst und mit eigenen Beobachtungen ergänzt werden.

---

## CLI-Skripte (Kurzreferenz)

| Skript | Plattform | Beschreibung |
|---|---|---|
| `convertAmt2gmaps.sh` | Linux / macOS | Unfallatlas-Daten herunterladen und in CSV/GeoJSON/KML konvertieren |
| `convertAmt2gmaps.ps1` | Windows (PowerShell) | Gleiche Funktion für Windows |

Ausführliche Informationen zu Parametern und Nutzung: → [README.md](../README.md)

---

## Datenquelle & Lizenz

Die Unfalldaten stammen aus dem
[Unfallatlas des Statistikportals der deutschen Bundesländer](https://unfallatlas.statistikportal.de/).

Die Daten stehen unter der
**[Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0)**
(`dl-de/by-2-0`) zur Verfügung.

---

## Technische Details

| Komponente | Technologie |
|---|---|
| Kartenanzeige | [Leaflet.js](https://leafletjs.com/) |
| Cluster-Ansicht | [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) |
| Heatmap | [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) |
| Zeichenwerkzeug | [Leaflet.draw](https://github.com/Leaflet/Leaflet.draw) |
| PDF-Export | [pdfMake](https://pdfmake.github.io/docs/) |
| Word-Export | [docx.js](https://docx.js.org/) |
| Tests | [Playwright](https://playwright.dev/) + [Jest](https://jestjs.io/) |
| CI/CD | GitHub Actions |
