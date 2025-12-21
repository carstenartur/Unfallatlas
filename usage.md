# Unfallatlas – Usage

Diese Datei beschreibt die **Bedienung des Shell-Skripts `convertAmt2gmaps.sh`**
und alle verfügbaren Optionen.

Das Skript lädt Unfallatlas-Daten (2016–2024), filtert sie nach Region, Stadt
oder Beteiligungsart und erzeugt **CSV- und GeoJSON-Dateien** für
Google Maps, Google Earth, GIS- und AR-Anwendungen.

---

## Schnellstart

```sh
./convertAmt2gmaps.sh
```

Ohne Parameter verwendet das Skript:

- Region: **Hannover**
- Beteiligung: **Fahrradunfälle (IstRad=1)**
- Jahre: **2016–2024**
- Limit: **2000 Datensätze pro Jahr**

---

## Allgemeine Optionen

```text
--years "YYYY YYYY ..."     Jahre auswählen (Default: 2016–2024)
--limit N                  Maximale Datensätze pro Jahr (Default: 1999)
--outdir DIR               Ausgabeverzeichnis (Default: out)
-h, --help                 Hilfe anzeigen
```

Beispiel:

```sh
./convertAmt2gmaps.sh --years "2022 2023 2024" --limit 1500
```

---

## Regionsbasierte Filterung (klassisch)

Die Region wird über amtliche Schlüssel gesetzt:

```text
--uland       Bundesland (2-stellig)
--uregb       Regierungsbezirk (1-stellig)
--ukreis      Kreis (2-stellig)
--ugemeinde   Gemeinde (3-stellig, optional)
```

Beispiel (Region Hannover):

```sh
./convertAmt2gmaps.sh --uland 03 --uregb 2 --ukreis 41
```

Beispiel (bestimmte Gemeinde im Kreis):

```sh
./convertAmt2gmaps.sh --uland 03 --uregb 2 --ukreis 41 --ugemeinde 001
```

---

## Stadtbasierte Filterung (≥ 100.000 Einwohner)

Das Skript unterstützt eine **benutzerfreundliche Stadt-Auswahl**
über einen lokalen Cache.

### Cache erzeugen (einmalig)

```sh
./convertAmt2gmaps.sh --update-city-cache
```

Dabei wird eine Datei erzeugt:

```text
out/city_cache.tsv
```

Diese enthält:
- Stadtname
- AGS (Amtlicher Gemeindeschlüssel)
- Einwohnerzahl

### Stadt auswählen

```sh
./convertAmt2gmaps.sh --city "Hannover"
./convertAmt2gmaps.sh --city "Frankfurt am Main"
```

Das Skript setzt intern automatisch:
- ULAND
- UREGBEZ
- UKREIS
- UGEMEINDE

### Städte anzeigen / suchen

```sh
./convertAmt2gmaps.sh --list-cities
./convertAmt2gmaps.sh --search "ber"
```

---

## Filter nach Beteiligungsarten

Standardmäßig ist aktiviert:

```text
IstRad = 1
```

Weitere Optionen:

```text
--rad  1|0     Fahrrad
--pkw  1|0     PKW
--fuss 1|0     Fußgänger
--krad 1|0     Kraftrad
```

Beispiele:

```sh
# Nur Fahrradunfälle
./convertAmt2gmaps.sh --rad 1

# Fahrrad- UND Fußgängerbeteiligung
./convertAmt2gmaps.sh --rad 1 --fuss 1

# Alle Unfälle (keine Beteiligungsfilter)
./convertAmt2gmaps.sh --rad "" --pkw "" --fuss "" --krad ""
```

Leere Werte bedeuten: **nicht filtern**.

---

## Ausgabeformate

### CSV (Google Maps kompatibel)

Pro Jahr:

```text
out/outputYYYY.csv
```

Zusätzlich:

```text
out/output_all_years.csv
```

Spalten (Auszug):

```text
WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND
```

---

### GeoJSON (GIS / AR / Web)

Pro Jahr:

```text
out/outputYYYY.geojson
```

Zusätzlich:

```text
out/output_all_years.geojson
```

GeoJSON enthält:

- Point-Geometrien (WGS84)
- Attribute als `properties`:
  - Unfallschwere
  - Unfalltyp
  - Zeit
  - Straßenzustand
  - Lichtverhältnisse

---

## Typische Workflows

### Google Maps

```sh
./convertAmt2gmaps.sh --city "Hannover"
```

CSV importieren → WKT als Geometrie → Name als Label.

---

### Google Earth

```sh
./convertAmt2gmaps.sh --city "Berlin" --years "2023"
```

CSV oder GeoJSON über Google Maps laden, anschließend in Google Earth öffnen.

---

### GIS / QGIS / AR

```sh
./convertAmt2gmaps.sh --city "Hamburg"
```

Direkt `output_all_years.geojson` laden.

---

## Hinweise & Limits

- Google Maps erlaubt **max. 2000 Objekte pro Import**
- Das Skript begrenzt daher automatisch pro Jahr
- Koordinaten werden **korrekt in WGS84** ausgegeben
- Fehlende Spalten in einzelnen Jahrgängen werden automatisch toleriert

---

## Fehlerbehebung

**Stadt nicht gefunden**
```text
ERROR: Stadt "X" nicht im Cache gefunden
```

→ Cache aktualisieren oder suchen:

```sh
./convertAmt2gmaps.sh --update-city-cache
./convertAmt2gmaps.sh --search "x"
```

---

## Lizenz & Datenquelle

Unfallatlas:
https://unfallatlas.statistikportal.de/

Datenlizenz Deutschland – Namensnennung – Version 2.0  
https://www.govdata.de/dl-de/by-2-0