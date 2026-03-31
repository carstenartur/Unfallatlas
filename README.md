# Unfallatlas

## 📖 Dokumentation

Die vollständige Dokumentation der Unfallwerkbank V2 mit Screenshots findest du unter:
**[docs/DOKUMENTATION.md](docs/DOKUMENTATION.md)**

---

Shell-Skript zum Konvertieren von Unfallatlas-Daten in ein CSV- und GeoJSON-Format,
das sich direkt in **Google Maps**, **Google Earth** sowie in andere GIS- und AR-Anwendungen
importieren lässt.

Der aktuelle Stand verarbeitet **mehrere Jahrgänge (2016–2024)** automatisch,
filtert standardmäßig auf **Fahrradunfälle** und kann wahlweise auf
**Regionen oder Städte (≥ 100.000 Einwohner)** eingeschränkt werden.

> **Hinweis für Entwickler:** Technische Informationen zur Architektur, Tests und Entwicklung finden Sie in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Voraussetzungen

Benötigt werden:

- sh
- curl
- unzip
- awk
- grep
- sed
- head / tail

(Getestet unter Linux und macOS)

---

## Aufruf (Quickstart)

```sh
./convertAmt2gmaps.sh
```

Ohne Parameter läuft das Skript wie bisher mit:

- Region **Hannover**
- Fahrradunfälle (`IstRad = 1`)
- alle verfügbaren Jahre (2016–2024)

---

## Erweiterte Nutzung

### Region explizit setzen (wie früher)

```sh
./convertAmt2gmaps.sh --uland 03 --uregb 2 --ukreis 41
```

Optional zusätzlich:

```sh
--ugemeinde 001
```

---

### Stadtbasiert filtern (≥ 100.000 Einwohner)

Einmalig Cache erzeugen:

```sh
./convertAmt2gmaps.sh --update-city-cache
```

Dann z. B.:

```sh
./convertAmt2gmaps.sh --city "Hannover"
./convertAmt2gmaps.sh --city "Frankfurt am Main"
```

Weitere Hilfen:

```sh
./convertAmt2gmaps.sh --list-cities
./convertAmt2gmaps.sh --search "ber"
```

Der Cache wird lokal unter `out/city_cache.tsv` abgelegt
und basiert auf öffentlichen Gemeindeverzeichnis-Daten.

---

### Jahre einschränken

```sh
./convertAmt2gmaps.sh --years "2021 2022 2023"
```

---

### Beteiligungsarten filtern

Standard: Fahrrad (`IstRad=1`)

Alternativ oder kombiniert:

```sh
--pkw 1
--fuss 1
--krad 1
```

Leere Werte bedeuten „nicht filtern“.

---

## Beispielausgabe

![image](https://user-images.githubusercontent.com/3164220/208239129-527fc27d-a4bb-43a7-a6cb-98942747689d.png)

Nach der Ausführung liegen mehrere Dateien im Ausgabeverzeichnis:

![image](https://user-images.githubusercontent.com/3164220/208239194-ad727afd-75fc-475c-9b27-4e7cffe621f8.png)

---

## Was das Skript macht

Für jedes ausgewählte Jahr:

1. Download der Unfallatlas-Datei (ZIP)
2. Automatisches Finden der eigentlichen CSV-/TXT-Datei im ZIP  
   (Pfad und Dateiname variieren je Jahr)
3. Filterung auf:
   - Region (ULAND / UREGBEZ / UKREIS / optional UGEMEINDE)
   - Beteiligung (z. B. Fahrrad)
4. Extraktion relevanter Attribute
5. Umwandlung in:
   - **Google-Maps-kompatibles CSV**
   - **GeoJSON (WGS84)**
6. Begrenzung auf maximal 2000 Datensätze pro Jahr  
   (Google-Maps-Import-Limit)

---

## Erweiterte enthaltene Attribute

Zusätzlich zu Ort und ID werden jetzt u. a. exportiert:

- **UKATEGORIE** – Unfallschwere  
- **UTYP1** – Unfalltyp  
- **UART** – Unfallart  
- **UMONAT**, **USTUNDE**, **UWOCHENTAG** – Zeitliche Einordnung  
- **STRZUSTAND** – Straßenzustand  
- **ULICHTVERH** – Lichtverhältnisse  

Diese Felder erscheinen:
- als zusätzliche Spalten im CSV
- als `properties` im GeoJSON

---

## Ausgabe

Nach dem Lauf liegen im Verzeichnis `out/`:

```text
out/
 ├─ output2016.csv
 ├─ output2016.geojson
 ├─ …
 ├─ output2024.csv
 ├─ output2024.geojson
 ├─ output_all_years.csv
 └─ output_all_years.geojson
```

---

## Interaktive Unfallwerkbank (werkbank.html)

Neben der reinen Datenkonvertierung enthält dieses Projekt eine **interaktive Analyse- und Visualisierungsoberfläche**:

👉 **https://carstenartur.github.io/Unfallatlas/werkbank.html**

Die *Unfallwerkbank* nutzt ausschließlich die erzeugten **GeoJSON-Dateien** und erlaubt eine explorative Analyse direkt im Browser, ohne zusätzliche Server-Komponenten.

### Unfallwerkbank V2 (mit POI und Bezugsdokumenten)

Eine erweiterte Version mit POI-Integration (Schulen, Kindergärten, Kitas) und Bezugsdokumenten ist verfügbar:

👉 **https://carstenartur.github.io/Unfallatlas/werkbank_v2.html**

Die V2 ergänzt die Export-Reports um:
- **POI-Analyse**: Automatische Erkennung von Schulen/Kindergärten/Kitas im oder nahe dem Unfallbereich
- **Bezugsdokumente**: Integration relevanter Verkehrssicherheitskonzepte und Planungen

**Wichtig:** Die ursprüngliche `werkbank.html` bleibt unverändert erhalten und funktioniert weiterhin vollständig.

Weitere Details zur V2-Funktionalität: siehe [WERKBANK_V2.md](WERKBANK_V2.md)

### Zweck

Die Werkbank dient dazu,

- Unfallhäufungen räumlich zu erkennen
- typische Beteiligungskombinationen (z. B. Alleinunfall Radfahrer) zu analysieren
- zeitliche, strukturelle und infrastrukturelle Ursachen sichtbar zu machen
- argumentationsfähige Berichte (z. B. für Bezirksräte) zu erzeugen

### Zentrale Funktionen

- **Städteauswahl** (auf Basis der erzeugten GeoJSON-Dateien)
- **Filter**:
  - Unfallschwere (UKATEGORIE)
  - Beteiligung: Rad, Fuß, PKW, Krad
  - Verknüpfung: ODER / UND / Alleinunfall
  - Uhrzeit (Stundenbereich)
  - Wochentag (Werktag / Wochenende)
  - Fahrbahnzustand
- **Darstellungsmodi**:
  - Marker-Cluster
  - Heatmap
  - „Nur auffällige“ Bereiche (Hotspot-Erkennung)
- **Freie Bereichsauswahl** per Rechteck (Leaflet.draw)

### Cluster-Popup

Beim Klick auf einen Cluster wird eine **Cluster-Analyse** angezeigt:

- Anzahl der Unfälle im Cluster
- Häufigste Beteiligungskombinationen (Piktogramme 🚲 🚶 🚗 🏍️)
- Prozentuale Anteile
- Optionaler Vergleich mit der stadtweiten Verteilung (Baseline)

Dies erlaubt das Erkennen **lokal überrepräsentierter Unfallmuster**.

### Analyse- & Export-Report

Über „Analyse/Export öffnen“ wird ein automatisch erzeugter Report erstellt:

- Auswertung des aktuellen Viewports oder der Markierung
- Zusammenfassung der Filtereinstellungen
- Statistische Kernaussagen (Anzahl, Schwere, Beteiligung)
- Textausgabe optimiert für:
  - Copy & Paste nach Word
  - Weitergabe als URL mit identischem Zustand

Der Report ist **deterministisch**:  
gleiche URL ⇒ gleiche Auswertung.

### Typischer Anwendungsfall

Beispiel Hannover:

- Filter: **Alleinunfälle Radfahrer**
- Ergebnis: deutliche Häufung an einem Straßenabschnitt nahe Theatermuseum
- Analyse zeigt das Zusammenwirken von:
  1. schlechtem Straßenzustand
  2. Kopfsteinpflaster
  3. Straßenbahnschienen

Solche Muster sind im Rohdatensatz kaum sichtbar, werden aber in der Werkbank unmittelbar nachvollziehbar.

### Technische Hinweise

- Die Werkbank ist **rein clientseitig** (HTML + JavaScript)
- Keine Nutzung der CSV-Ausgabe
- Datenquelle: `output_all_years_<stadt>.geojson`
- Modularer Aufbau (`js/ua.*.js`) zur getrennten Weiterentwicklung von:
  - Daten
  - Filtern
  - Karte
  - UI
  - Export

Die Werkbank befindet sich in aktiver Weiterentwicklung und ist primär als **Analyse- und Erkenntniswerkzeug** gedacht, nicht als fertiges Endprodukt.




---

## Konvertiertes CSV-Format (Beispiel)

```text
WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND
"POINT (9.61353886 52.39219065)",Unfall 8541 (2019) Kat:2,8541,2,7,0,1,8,5,0
```

---

## Import in Google Maps

1. Google Maps → *Meine Orte* → *Karten*
2. *Karte erstellen*
3. CSV-Datei importieren
4. Spalte **WKT** als Geometrie verwenden
5. Spalte **Name** als Beschriftung wählen

Achtung:  
Google Maps erlaubt maximal **2000 Objekte pro Import**.

![image](https://user-images.githubusercontent.com/3164220/208238452-d67a3db4-b15e-40ce-994b-34ab86ae9813.png)
![image](https://user-images.githubusercontent.com/3164220/208238510-32f58332-969e-4fff-9f89-c22ee4198048.png)

---

## Google Earth

Die in Google Maps erzeugte Karte kann direkt in Google Earth geöffnet werden.

![image](https://user-images.githubusercontent.com/3164220/208238767-f230bfd7-e631-468d-97a6-0307a3457f18.png)

Beispiel:
https://www.google.com/maps/d/viewer?hl=de&mid=141aHGXdO_4ZUzENVbB2fFYjxQDgcpac

---

## Datenquelle

Unfallatlas:  
https://unfallatlas.statistikportal.de/

Open-Data-Downloads:  
https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/

Koordinatensystem:  
ETRS89 / WGS84 (EPSG:4326, exportiert aus EPSG:25832)

---

## Datenlizenz

Datenlizenz Deutschland – Namensnennung – Version 2.0  
https://www.govdata.de/dl-de/by-2-0

---

## Verwendete Bibliotheken und Dienste

Für die interaktive Kartenvisualisierung werden folgende Open-Source-
Bibliotheken und Dienste verwendet:

- Leaflet (https://leafletjs.com/) – BSD-2-Clause License
- Leaflet.markercluster – MIT License
- leaflet.heat – MIT License
- OpenStreetMap Kartenkacheln  
  © OpenStreetMap-Mitwirkende, Lizenz: https://www.openstreetmap.org/copyright

Die Kartenkacheln werden ausschließlich zur Darstellung verwendet.

---

## Weitere Informationen

https://urban-digital.de/mit-simra-sicherheit-im-radverkehr-herausfinden-wo-sich-beinaheunfaelle-im-radverkehr-haeufen/  
https://www.nature.com/articles/s43588-022-00318-w  
https://www.deutschlandatlas.bund.de/DE/Karten/Wie-wir-uns-bewegen/100-Pendlerdistanzen-Pendlerverflechtungen.html  
https://www.strava.com/heatmap  
https://www.radverkehr-in-deutschland.de/