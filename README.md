# Unfallatlas

Shell-Skript zum Konvertieren von Unfallatlas-Daten für Hannover in ein CSV-Format,
das sich direkt in Google Maps (und Google Earth) importieren lässt.

Der aktuelle Stand verarbeitet mehrere Jahrgänge (2016–2024) automatisch
und filtert auf Fahrradunfälle.

---

## Voraussetzungen

Benötigt werden:

- sh
- curl
- unzip
- awk
- head

(Getestet unter Linux und macOS)

---

## Aufruf

    ./convertAmt2gmaps.sh

Es sind keine Parameter notwendig.  
Die Region ist aktuell fest auf Hannover konfiguriert.

---

## Beispielausgabe

![image](https://user-images.githubusercontent.com/3164220/208239129-527fc27d-a4bb-43a7-a6cb-98942747689d.png)

Nach der Ausführung liegen mehrere CSV-Dateien im Ausgabeverzeichnis:

![image](https://user-images.githubusercontent.com/3164220/208239194-ad727afd-75fc-475c-9b27-4e7cffe621f8.png)

---

## Was das Skript macht

Für jedes verfügbare Jahr:

1. Download der Unfallatlas-CSV (EPSG:25832)
2. Automatisches Finden der eigentlichen CSV-/TXT-Datei im ZIP
   (Pfad und Dateiname unterscheiden sich je Jahr)
3. Filterung auf:
   - Region Hannover (ULAND=03, UREGBEZ=2, UKREIS=41)
   - Fahrradunfälle (IstRad = 1)
4. Umwandlung in ein Google-Maps-kompatibles CSV mit:
   - WKT-Punktgeometrie
   - sprechendem Namen
   - Objekt-ID
5. Begrenzung auf maximal 2000 Zeilen pro Jahr
   (Google-Maps-Import-Limit)

---

## Ausgabe

Nach dem Lauf liegen im Verzeichnis out/ folgende Dateien:

    out/
     ├─ output2016.csv
     ├─ output2017.csv
     ├─ output2018.csv
     ├─ output2019.csv
     ├─ output2020.csv
     ├─ output2021.csv
     ├─ output2022.csv
     ├─ output2023.csv
     ├─ output2024.csv
     └─ output_all_years.csv

- outputYYYY.csv – je Jahr eine Datei (max. 2000 Zeilen)
- output_all_years.csv – zusammengeführte Datei über alle Jahre

---

## Datenquelle

Unfallatlas:  
https://unfallatlas.statistikportal.de/

Open-Data-Downloads:  
https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/

Koordinatensystem:  
ETRS89 / UTM Zone 32N (EPSG:25832)

---

## Ursprüngliches Datenformat (Beispiel)

    OBJECTID_1;ULAND;UREGBEZ;UKREIS;UGEMEINDE;UJAHR;UMONAT;USTUNDE;UWOCHENTAG;
    UKATEGORIE;UART;UTYP1;ULICHTVERH;IstRad;IstPKW;IstFuss;IstKrad;IstGkfz;
    IstSonstig;STRZUSTAND;LINREFX;LINREFY;XGCSWGS84;YGCSWGS84
    1;01;0;03;000;2018;01;08;5;2;0;7;0;1;0;0;0;0;0;0;
    612054,34;5969634,01;10,70395;53,86308

---

## Konvertiertes Format

    WKT,Name,OBJECTID
    "POINT (9.613538860000062 52.392190656000082)",Fahrrad 8541 (2019),8541
    "POINT (9.963940036000054 52.316034063000075)",Fahrrad 8618 (2019),8618

- WKT: Punktgeometrie (Lon/Lat, Google Maps)
- Name: Unfall-ID, Jahr, optional Lichtverhältnisse / Straße
- OBJECTID: Original-ID aus dem Unfallatlas

---

## Import in Google Maps

1. Google Maps → Meine Orte → Karten
2. Karte erstellen
3. CSV-Datei importieren
4. Spalte WKT als Geometrie verwenden
5. Spalte Name als Beschriftung wählen

Achtung:  
Google Maps erlaubt maximal 2000 Objekte pro Import.  
Daher werden im Skript nur die ersten 2000 Datensätze je Jahr erzeugt.

![image](https://user-images.githubusercontent.com/3164220/208238452-d67a3db4-b15e-40ce-994b-34ab86ae9813.png)
![image](https://user-images.githubusercontent.com/3164220/208238510-32f58332-969e-4fff-9f89-c22ee4198048.png)

---

## Google Earth

Die in Google Maps erzeugte Karte kann anschließend direkt in Google Earth
geöffnet werden.

![image](https://user-images.githubusercontent.com/3164220/208238767-f230bfd7-e631-468d-97a6-0307a3457f18.png)

Beispiel:
https://www.google.com/maps/d/viewer?hl=de&mid=141aHGXdO_4ZUzENVbB2fFYjxQDgcpac

---

## Orts- und Bezirksliste im Skript

Am Anfang des Skripts befindet sich eine umfangreiche kommentierte Liste:

- Bundesländer
- Amtsgerichts- / Kreiskennziffern
- Gültigkeit der Daten nach Jahr

Diese Liste dient ausschließlich als Referenz
und erleichtert das Anpassen der Region im Skript.

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