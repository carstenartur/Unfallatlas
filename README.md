# Unfallatlas – Interaktive Unfallanalyse für deutsche Städte

> **Wo passieren Fahrradunfälle? Wo sind Schulwege gefährdet? Wo braucht es bessere Radinfrastruktur?**
>
> Der Unfallatlas macht amtliche Verkehrsunfalldaten (2016–2024) für alle deutschen Großstädte als interaktive Karte zugänglich – direkt im Browser, ohne Installation.

[![Startansicht der Unfallwerkbank V2](docs/screenshots/01-startansicht.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html)

---

## 🚀 Live-Demo & Dokumentation

| | Link |
|---|---|
| **Live-Demo (Werkbank V2)** | 👉 **[carstenartur.github.io/Unfallatlas/werkbank_v2.html](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html)** |
| **Vollständige Dokumentation** | 📖 [docs/DOKUMENTATION.md](docs/DOKUMENTATION.md) |
| **Architektur & Entwickler** | 🏗️ [ARCHITECTURE.md](ARCHITECTURE.md) |

---

## ⏱️ In 60 Sekunden zur ersten Analyse

1. **[Live-Demo öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html)** – läuft direkt im Browser
2. **Stadt wählen** – z. B. Bonn, Hannover, Berlin, Hamburg, …
3. **Filtern** – Unfallschwere, Beteiligung (🚲 🚶 🚗 🏍️), Uhrzeit, Fahrbahnzustand
4. **Analysieren** – Cluster, Heatmap oder Hotspot-Erkennung aktivieren
5. **Exportieren** – Bezirksratsantrag als PDF/Word herunterladen oder Link teilen

> Alle Filter werden in der URL gespeichert – gleiche URL → gleiche Analyse. Ideal zum Teilen und Reproduzieren.

---

## 🔑 Wichtigste Funktionen

| Funktion | Beschreibung |
|---|---|
| **Filterkombinationen** | Schwere, Beteiligung (ODER / UND / Alleinunfall), Uhrzeit, Wochentag, Fahrbahnzustand |
| **Cluster-Analyse** | Klick auf Cluster zeigt Beteiligungskombinationen mit Vergleich zum Stadtdurchschnitt |
| **Heatmap & Hotspots** | Dichteverteilung und automatische Erkennung überrepräsentierter Muster |
| **POI-Overlay** | Ab Zoomstufe 15: Schulen 🏫 und Kitas 🧒 auf der Karte – Schulwegsicherheit prüfen |
| **Bereichsauswahl** | Rechteck zeichnen → nur Unfälle in diesem Bereich auswerten |
| **Export als Bezirksratsantrag** | PDF / Word mit Sachverhalt, Statistik, Karte, POI-Analyse und Beschlussvorschlag |
| **Deterministische URLs** | Jede Analyse ist als Link teilbar und reproduzierbar |

---

## 📌 Konkrete Anwendungsbeispiele

### Beispiel 1: Auto-Fahrrad-Kollisionen am Bonner Hauptbahnhof

🚲 + 🚗 im **UND-Modus**, Heatmap aktiv → zeigt Häufungen von Rad-PKW-Kollisionen.

[→ Live in der Werkbank öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=1&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010)

[![Bonn Hbf – Rad+Auto-Unfälle](docs/screenshots/13-bonn-hbf-radunfaelle.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=1&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010)

### Beispiel 2: Fahrrad-Alleinunfälle (Infrastrukturmängel erkennen)

Nur 🚲 im **Alleinunfall-Modus** → deckt schlechten Belag, Bordsteinkanten und Gleise auf.

[→ Live in der Werkbank öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=0&includeMotorcycle=0&involvementMode=solo&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7350&centerLon=7.1000&zoom=13)

### Beispiel 3: Schulwegsicherheit – Unfälle neben Schulen und Kitas

🚲 + 🚶 im **ODER-Modus**, Berufsverkehr 6–18 Uhr, Zoom 16 → POIs (Schulen/Kitas) werden sichtbar.

[→ Live in der Werkbank öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18&centerLat=50.7350&centerLon=7.0950&zoom=16)

[![POI-Ansicht mit Schulen und Kitas](docs/screenshots/12-poi-schulen-kitas.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18&centerLat=50.7350&centerLon=7.0950&zoom=16)

---

## 🎯 Für wen ist das?

| Zielgruppe | Nutzen |
|---|---|
| **Bezirksräte / Kommunalpolitik** | Datenbasierte Anträge zur Verkehrssicherheit erstellen – direkt als PDF/Word-Export |
| **Radverkehrsbeauftragte** | Unfallschwerpunkte identifizieren und Maßnahmen priorisieren |
| **Verkehrsplaner / Ingenieurbüros** | Open-Data-Analyse mit reproduzierbaren, teilbaren Links |
| **ADFC / Bürgerinitiativen** | Argumentationsgrundlage für Verbesserungen an konkreten Stellen |
| **Forschung / Journalismus** | Explorative Unfallanalyse mit amtlichen Daten (2016–2024) |

---

## 📸 Screenshots

| Cluster-Ansicht | Heatmap | Export-Modal |
|---|---|---|
| [![Cluster](docs/screenshots/04-cluster-ansicht.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html) | [![Heatmap](docs/screenshots/05-heatmap-ansicht.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?showHeatmap=1&showCluster=0) | [![Export](docs/screenshots/07-export-modal.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?export=1) |

Weitere Screenshots und ausführliche Erklärungen: → [docs/DOKUMENTATION.md](docs/DOKUMENTATION.md)

---

## 🛠️ CLI-Datenkonvertierung

Neben der Web-Werkbank enthält das Projekt Shell-/PowerShell-Skripte zum Konvertieren der Unfallatlas-Rohdaten in CSV und GeoJSON für Google Maps, Google Earth und GIS-Anwendungen.

### Quickstart

```sh
./convertAmt2gmaps.sh                          # Standard: Hannover, Fahrrad, 2016–2024
./convertAmt2gmaps.sh --city "Bonn"            # Stadtbasiert
./convertAmt2gmaps.sh --city "Berlin" --years "2023 2024"  # Jahre einschränken
```

<details>
<summary><strong>Erweiterte CLI-Nutzung (klicken zum Aufklappen)</strong></summary>

### Voraussetzungen

- sh, curl, unzip, awk, grep, sed, head/tail (Linux/macOS)
- PowerShell 7+ für `convertAmt2gmaps.ps1` (Windows)

### Region explizit setzen

```sh
./convertAmt2gmaps.sh --uland 03 --uregb 2 --ukreis 41
./convertAmt2gmaps.sh --uland 03 --uregb 2 --ukreis 41 --ugemeinde 001
```

### Stadtbasiert filtern (≥ 100.000 Einwohner)

```sh
./convertAmt2gmaps.sh --update-city-cache       # Einmalig Cache erzeugen
./convertAmt2gmaps.sh --city "Frankfurt am Main"
./convertAmt2gmaps.sh --list-cities              # Alle Städte anzeigen
./convertAmt2gmaps.sh --search "ber"             # Suchen
```

### Beteiligungsarten filtern

```sh
./convertAmt2gmaps.sh --rad 1                   # Standard: Fahrrad
./convertAmt2gmaps.sh --rad 1 --fuss 1          # Fahrrad + Fußgänger
./convertAmt2gmaps.sh --pkw 1 --krad 1          # PKW + Kraftrad
```

### Ausgabe

```text
out/
 ├─ output2016.csv / .geojson
 ├─ …
 ├─ output2024.csv / .geojson
 ├─ output_all_years.csv
 └─ output_all_years.geojson
```

### Import in Google Maps

1. Google Maps → *Meine Orte* → *Karten* → *Karte erstellen*
2. CSV-Datei importieren → **WKT** als Geometrie, **Name** als Beschriftung
3. Max. 2000 Objekte pro Import

Die Karte kann anschließend direkt in Google Earth geöffnet werden.

Ausführliche Nutzungsinformationen (Shell + PowerShell): → [usage.md](usage.md)

</details>

---

## Datenquelle & Lizenz

| | |
|---|---|
| **Unfallatlas** | [unfallatlas.statistikportal.de](https://unfallatlas.statistikportal.de/) |
| **Open-Data-Downloads** | [opengeodata.nrw.de/…/unfallatlas](https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/) |
| **Datenlizenz** | [Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0) |
| **Koordinatensystem** | WGS84 (EPSG:4326, exportiert aus EPSG:25832) |

### Verwendete Bibliotheken

- [Leaflet](https://leafletjs.com/) – BSD-2-Clause · [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) – MIT · [leaflet.heat](https://github.com/Leaflet/Leaflet.heat) – MIT
- [pdfMake](https://pdfmake.github.io/docs/) · [docx.js](https://docx.js.org/) · [FileSaver.js](https://github.com/nicholasnet/FileSaver.js)
- Kartenkacheln: © [OpenStreetMap-Mitwirkende](https://www.openstreetmap.org/copyright)

---

## Weiterführende Informationen

- [Werkbank V2 – Features & POI-Integration](WERKBANK_V2.md)
- [Vollständige Dokumentation mit Screenshots](docs/DOKUMENTATION.md)
- [Architektur, Tests & Entwicklung](ARCHITECTURE.md)
- [SimRa – Beinaheunfälle im Radverkehr](https://urban-digital.de/mit-simra-sicherheit-im-radverkehr-herausfinden-wo-sich-beinaheunfaelle-im-radverkehr-haeufen/)
- [Nature: Bicycle crash data](https://www.nature.com/articles/s43588-022-00318-w)
- [Deutschlandatlas – Pendlerverflechtungen](https://www.deutschlandatlas.bund.de/DE/Karten/Wie-wir-uns-bewegen/100-Pendlerdistanzen-Pendlerverflechtungen.html)
- [Strava Heatmap](https://www.strava.com/heatmap)
- [Radverkehr in Deutschland](https://www.radverkehr-in-deutschland.de/)
