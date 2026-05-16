# Unfallatlas – Usage

> Diese Seite ist Teil der Unfallatlas-Doku. Zurück zur [README](README.md).

Diese Datei beschreibt die **Bedienung beider Skriptvarianten**:

- **Shell (Linux/macOS):** `convertAmt2gmaps.sh`
- **PowerShell (Windows / macOS / Linux):** `convertAmt2gmaps.ps1`

Beide Skripte laden Unfallatlas-Daten (2016–2024), filtern sie nach Region, Stadt
oder Beteiligungsart und erzeugen **CSV- und GeoJSON-Dateien** für
Google Maps, Google Earth, GIS- und AR-Anwendungen.

> Hinweis: Die Parameter-Namen unterscheiden sich leicht zwischen Shell und PowerShell.
> Diese Usage zeigt immer beide Varianten.

---

## Schnellstart

### Shell (Linux/macOS)

```sh
./convertAmt2gmaps.sh
```

### PowerShell (Windows / PowerShell 7+)

```powershell
pwsh ./convertAmt2gmaps.ps1
```

Ohne Parameter verwenden beide Skripte:

- Region: **Hannover**
- Beteiligung: **Fahrradunfälle (IstRad=1)**
- Jahre: **2016–2024**
- Limit: **2000 Datensätze pro Jahr**

---

## Voraussetzungen

### Shell-Version (`.sh`)

Benötigt werden:

- sh
- curl
- unzip
- awk
- grep
- sed
- head / tail

(Getestet unter Linux und macOS)

### PowerShell-Version (`.ps1`)

Empfohlen:

- PowerShell **7+** (`pwsh`)
- `unzip` im PATH (z. B. Git Bash, WSL, MSYS2 oder Windows 11 tar/unzip Tools)

> Wenn `unzip` fehlt, kann die PS-Version nicht direkt aus dem ZIP streamen.
> In diesem Fall: `unzip` installieren oder die ZIP-Datei manuell entpacken.

---

## Allgemeine Optionen

### Shell

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

### PowerShell

```text
-Years 2016,2017,...       Jahre auswählen (Default: 2016–2024)
-Limit N                   Maximale Datensätze pro Jahr (Default: 1999)
-OutDir DIR                Ausgabeverzeichnis (Default: out)
```

Beispiel:

```powershell
pwsh ./convertAmt2gmaps.ps1 -Years 2022,2023,2024 -Limit 1500
```

---

## Regionsbasierte Filterung (klassisch)

Die Region wird über amtliche Schlüssel gesetzt:

- ULAND (2-stellig)
- UREGBEZ (1-stellig)
- UKREIS (2-stellig)
- UGEMEINDE (3-stellig, optional)

### Shell

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

### PowerShell

```text
-ULAND       Bundesland (2-stellig)
-UREGBEZ     Regierungsbezirk (1-stellig)
-UKREIS      Kreis (2-stellig)
-UGEMEINDE   Gemeinde (3-stellig, optional)
```

Beispiel (Region Hannover):

```powershell
pwsh ./convertAmt2gmaps.ps1 -ULAND 03 -UREGBEZ 2 -UKREIS 41
```

Beispiel (bestimmte Gemeinde im Kreis):

```powershell
pwsh ./convertAmt2gmaps.ps1 -ULAND 03 -UREGBEZ 2 -UKREIS 41 -UGEMEINDE 001
```

---

## Stadtbasierte Filterung (≥ 100.000 Einwohner)

Beide Skripte unterstützen eine benutzerfreundliche Stadt-Auswahl über einen lokalen Cache.

### Cache erzeugen (einmalig)

#### Shell

```sh
./convertAmt2gmaps.sh --update-city-cache
```

#### PowerShell

```powershell
pwsh ./convertAmt2gmaps.ps1 -UpdateCityCache
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

#### Shell

```sh
./convertAmt2gmaps.sh --city "Hannover"
./convertAmt2gmaps.sh --city "Frankfurt am Main"
```

#### PowerShell

```powershell
pwsh ./convertAmt2gmaps.ps1 -City "Hannover"
pwsh ./convertAmt2gmaps.ps1 -City "Frankfurt am Main"
```

Das Skript setzt intern automatisch:
- ULAND
- UREGBEZ
- UKREIS
- UGEMEINDE

### Städte anzeigen / suchen

#### Shell

```sh
./convertAmt2gmaps.sh --list-cities
./convertAmt2gmaps.sh --search "ber"
```

#### PowerShell

```powershell
pwsh ./convertAmt2gmaps.ps1 -ListCities
pwsh ./convertAmt2gmaps.ps1 -Search "ber"
```

---

## Filter nach Beteiligungsarten

Standardmäßig ist aktiviert:

```text
IstRad = 1
```

Weitere Möglichkeiten:

- Fahrrad: `IstRad`
- PKW: `IstPKW`
- Fußgänger: `IstFuss`
- Kraftrad: `IstKrad`

### Shell

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

### PowerShell

```text
-Rad  1|0      Fahrrad
-PKW  1|0      PKW
-Fuss 1|0      Fußgänger
-Krad 1|0      Kraftrad
```

Beispiele:

```powershell
# Nur Fahrradunfälle
pwsh ./convertAmt2gmaps.ps1 -Rad 1

# Fahrrad- UND Fußgängerbeteiligung
pwsh ./convertAmt2gmaps.ps1 -Rad 1 -Fuss 1

# Alle Unfälle (keine Beteiligungsfilter)
pwsh ./convertAmt2gmaps.ps1 -Rad "" -PKW "" -Fuss "" -Krad ""
```

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

CSV-Spalten (Auszug):

```text
WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH
```

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
- Attribute als `properties`, u. a.:
  - Unfallschwere (UKATEGORIE)
  - Unfalltyp (UTYP1) / Unfallart (UART)
  - Zeit (Monat/Stunde/Wochentag)
  - Straßenzustand (STRZUSTAND)
  - Lichtverhältnisse (ULICHTVERH)

---

## Typische Workflows

### Google Maps

#### Shell

```sh
./convertAmt2gmaps.sh --city "Hannover"
```

#### PowerShell

```powershell
pwsh ./convertAmt2gmaps.ps1 -City "Hannover"
```

CSV importieren → WKT als Geometrie → Name als Label.

---

### Google Earth

#### Shell

```sh
./convertAmt2gmaps.sh --city "Berlin" --years "2023"
```

#### PowerShell

```powershell
pwsh ./convertAmt2gmaps.ps1 -City "Berlin" -Years 2023
```

CSV oder GeoJSON über Google Maps laden, anschließend in Google Earth öffnen.

---

### GIS / QGIS / AR

#### Shell

```sh
./convertAmt2gmaps.sh --city "Hamburg"
```

#### PowerShell

```powershell
pwsh ./convertAmt2gmaps.ps1 -City "Hamburg"
```

Direkt `output_all_years.geojson` laden.

---

## Hinweise & Limits

- Google Maps erlaubt **max. 2000 Objekte pro Import**
- Das Skript begrenzt daher automatisch pro Jahr
- Koordinaten werden **in WGS84 (Lon/Lat)** ausgegeben
- Fehlende Spalten in einzelnen Jahrgängen werden automatisch toleriert
- City-Cache:
  - wird lokal gespeichert (`out/city_cache.tsv`)
  - muss nur gelegentlich aktualisiert werden
  - ist optional (Region-Filter funktioniert ohne Cache)

---

## Fehlerbehebung

### Stadt nicht gefunden

```text
ERROR: Stadt "X" nicht im Cache gefunden
```

→ Cache aktualisieren oder suchen:

#### Shell

```sh
./convertAmt2gmaps.sh --update-city-cache
./convertAmt2gmaps.sh --search "x"
```

#### PowerShell

```powershell
pwsh ./convertAmt2gmaps.ps1 -UpdateCityCache
pwsh ./convertAmt2gmaps.ps1 -Search "x"
```

---

## Lizenz & Datenquelle

Unfallatlas:
https://unfallatlas.statistikportal.de/

Open-Data-Downloads:
https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/

Datenlizenz Deutschland – Namensnennung – Version 2.0  
https://www.govdata.de/dl-de/by-2-0
