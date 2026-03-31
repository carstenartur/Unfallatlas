# Unfallwerkbank V2 – Dokumentation

## Überblick

Die **Unfallwerkbank V2** ist eine interaktive Webanwendung zur Visualisierung und Analyse
von [Unfallatlas](https://unfallatlas.statistikportal.de/)-Daten (Open Data) für deutsche Städte.
Sie ermöglicht:

- **Filterung** nach Stadt, Unfallschwere, Beteiligungsart (Rad, Fuß, PKW, Krad), Uhrzeit und Straßenzustand
- **Darstellung** der Unfälle als Cluster-Karte oder Heatmap
- **Export** als PDF oder Word-Dokument – z. B. für Bezirksratsanträge
- **Zeichnen** von Markierungsbereichen für gezielte Auswertungen

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

Wähle im Dropdown **Stadtauswahl** eine Stadt aus. Die Unfalldaten werden automatisch vom
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

- **ODER** – mindestens eine der gewählten Beteiligungsarten
- **UND** – alle gewählten Beteiligungsarten gleichzeitig beteiligt
- **Alleinunfall** – nur Alleinunfälle der gewählten Art

![Beteiligung und Filter](screenshots/03-filter.png)

---

### Zeitfilter

Mit den **Stundenbereich-Slidern** kann der Anzeigezeitraum auf bestimmte Tagesstunden
eingeschränkt werden (z. B. 6–18 Uhr für den Berufsverkehr).

![Stundenfilter](screenshots/08-stundenfilter.png)

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

Ein Klick auf **Legende** öffnet eine Erklärung der verwendeten Farben und Symbole.

![Legende](screenshots/06-legende.png)

---

### Zeichnen / Markieren

Mit **Bereich zeichnen** kann ein Polygon auf der Karte gezeichnet werden. Die Auswertung
und der Export beziehen sich dann nur auf die Unfälle innerhalb dieses Bereichs.
**Zeichnung löschen** entfernt das Polygon wieder.

---

### Export

Ein Klick auf **Bericht erstellen / Export** öffnet das Export-Modal.

![Export-Modal](screenshots/07-export-modal.png)

Im Modal stehen folgende Optionen zur Verfügung:

| Option | Beschreibung |
|---|---|
| **Karte einbeziehen** | Kartenbild in den Export aufnehmen |
| **POIs einbeziehen** | Points of Interest hinzufügen |
| **Referenzdokumente** | Verweise auf Quellen einbeziehen |
| **Als Word exportieren** | `.docx`-Datei herunterladen |
| **Als PDF exportieren** | PDF-Datei herunterladen |
| **Text kopieren** | Berichtstext in die Zwischenablage kopieren |
| **Link kopieren** | Direkt-Link zur aktuellen Ansicht kopieren |

Die generierte **Textvorlage** eignet sich direkt für Bezirksratsanträge oder Anfragen
an Stadtrat/Verkehrsplanung.

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
