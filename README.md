# Unfallatlas

Shell-Skript zum Konvertieren von Unfallatlas-Daten in ein CSV- und GeoJSON-Format,
das sich direkt in **Google Maps**, **Google Earth** sowie in andere GIS- und AR-Anwendungen
importieren lässt.

Der aktuelle Stand verarbeitet **mehrere Jahrgänge (2016–2024)** automatisch,
filtert standardmäßig auf **Fahrradunfälle** und kann wahlweise auf
**Regionen oder Städte (≥ 100.000 Einwohner)** eingeschränkt werden.

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
https://carstenartur.github.io/Unfallatlas/

Wählt man dann zb Alleinunfälle Radfahrer entdeckt man auf der Karte
einen Strassenabschnitt vor dem Theathermuseum mit
einer starken Häufung. Man kann dann leicht einsehen warum das so ist.
Es kommen 3 Dinge zusammen:
1. schlechter Strassenzustand
2. Kopfsteinpflaster
3. Strassenbahnschienen


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

## Weitere Informationen

https://urban-digital.de/mit-simra-sicherheit-im-radverkehr-herausfinden-wo-sich-beinaheunfaelle-im-radverkehr-haeufen/  
https://www.nature.com/articles/s43588-022-00318-w  
https://www.deutschlandatlas.bund.de/DE/Karten/Wie-wir-uns-bewegen/100-Pendlerdistanzen-Pendlerverflechtungen.html  
https://www.strava.com/heatmap  
https://www.radverkehr-in-deutschland.de/