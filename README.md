# Unfallwerkbank – Interaktive Unfallanalyse für deutsche Städte

> **Wo passieren Fahrradunfälle? Wo sind Schulwege gefährdet? Wo braucht es bessere Radinfrastruktur?**
>
> Die Unfallwerkbank macht amtliche Verkehrsunfalldaten (2016–2024) für ausgewählte deutsche Großstädte als interaktive Karte zugänglich – direkt im Browser, ohne Installation.

[![Startansicht der Unfallwerkbank V2](docs/screenshots/01-startansicht.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html)

---

## 🚀 Live-Demo & Dokumentation

| Ressource | Link |
|---|---|
| **Live-Demo (Werkbank V2)** | 👉 **[carstenartur.github.io/Unfallatlas/werkbank_v2.html](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html)** |
| **Showcase (automatische Beispiel-Rotation)** | 🎠 [carstenartur.github.io/Unfallatlas/showcase.html](https://carstenartur.github.io/Unfallatlas/showcase.html) |
| **Vollständige Dokumentation** | 📖 [docs/DOKUMENTATION.md](docs/DOKUMENTATION.md) |
| **Architektur (Browser + Server + KI)** | 🏗️ [docs/architecture.md](docs/architecture.md) |
| **Server-API & Konfiguration** | 🔌 [docs/server-features.md](docs/server-features.md) |
| **Bundesweiter Städte-/Regionen-Katalog** | 🗺️ [docs/CITY_CATALOG.md](docs/CITY_CATALOG.md) |
| **Maßnahmen-Steckbriefe (Priorisierung)** | 🎯 [docs/LOCATION_BRIEF.md](docs/LOCATION_BRIEF.md) |
| **Persistenz-/Analyse-Service (Spring Boot)** | 🗄️ [analysis-service/README.md](analysis-service/README.md) |
| **Release-Checklist** | ✅ [docs/release-checklist.md](docs/release-checklist.md) |
| **Entwickler-Doku (Tests, CI)** | 🧰 [ARCHITECTURE.md](ARCHITECTURE.md) |

---

## ⏱️ In 60 Sekunden zur ersten Analyse

1. **[Live-Demo öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html)** – läuft direkt im Browser
2. **Stadt wählen** – z. B. Bonn, Hannover, Berlin, Hamburg, …
3. **Filtern** – Unfallschwere, Beteiligung (🚲 🚶 🚗 🏍️ 🚛 🚌), Uhrzeit, Fahrbahnzustand
4. **Analysieren** – Cluster, Heatmap oder Hotspot-Erkennung aktivieren
5. **Exportieren** – Bezirksratsantrag als PDF/Word herunterladen oder Link teilen

> Alle Filter werden in der URL gespeichert – gleiche URL → gleiche Analyse. Ideal zum Teilen und Reproduzieren.

---

## 🔑 Wichtigste Funktionen

| Funktion | Beschreibung |
|---|---|
| **Filterkombinationen** | Schwere, Beteiligung (🚲 🚶 🚗 🏍️ 🚛 🚌 – ODER / UND / Alleinunfall), Uhrzeit, Wochentag, Fahrbahnzustand |
| **Cluster-Analyse** | Klick auf Cluster zeigt Beteiligungskombinationen mit Vergleich zum Stadtdurchschnitt |
| **Heatmap & Hotspots** | Dichteverteilung und automatische Erkennung überrepräsentierter Muster |
| **POI-Overlay** | Ab Zoomstufe 15: Schulen 🏫 und Kitas 🧒 auf der Karte – Schulwegsicherheit prüfen |
| **Bereichsauswahl** | Rechteck zeichnen → nur Unfälle in diesem Bereich auswerten |
| **Export als Bezirksratsantrag** | PDF / Word mit Sachverhalt, Statistik, Karte, POI-Analyse und Beschlussvorschlag |
| **Datenexport** | Unfallpunkte direkt als 📊 CSV, 🗺️ GeoJSON oder 📍 KML herunterladen |
| **Deterministische URLs** | Jede Analyse ist als Link teilbar und reproduzierbar |

---

## 🗺️ Bundesweite Skalierung – Städte-/Regionen-Katalog

Unfallatlas führt einen **bundesweiten Katalog** aller unterstützten
deutschen Städte und Regionen.  Pro Ort ist transparent ausgewiesen,
welche Funktionen verfügbar sind – nicht jede Stadt muss sofort alle
Features mitbringen:

| Stufe | Bezeichnung           | Bedeutung                                                          |
|:-----:|:----------------------|:-------------------------------------------------------------------|
| **A** | Unfallanalyse         | Filter, Cluster, Heatmap, Hotspots, Export                         |
| **B** | Politische Recherche  | Anbindung an ein Ratsinformationssystem (Anträge/Beschlüsse …)     |
| **C** | Persistenz / Batch    | Maßnahmen-Steckbriefe, Top-N, Priorisierungen via Analysis-Service |

Jede Stufe ist pro Stadt als `supported`, `partially_supported` oder
`unsupported` markiert.  Die Liste, die Capability-Matrix und Hinweise
zur Pflege („wie nehme ich eine neue Stadt auf?") stehen in
[`docs/CITY_CATALOG.md`](docs/CITY_CATALOG.md).

API-Endpunkte (Node-Modus):

- `GET /api/cities` – Liste mit Capability-Matrix (filterbar via
  `?q=`, `?state=NW`, `?support=supportLevelB`, `?limit=…`)
- `GET /api/cities/:idOrKey` – Einzelner Ort (Lookup via id, Name oder
  amtlichem Gemeindeschlüssel)
- `GET /api/status` – aggregierte Capability-Übersicht inkl. Verteilung
  über die Stufen A/B/C

---

## 🗄️ Betriebsmodi – Browser-only · Node-Standalone · Node + Analysis Service

Die Werkbank lässt sich in drei klar abgegrenzten Modi betreiben.  Alle
Kernfunktionen (Karte, Filter, Cluster, Heatmap, deterministischer
PDF-/Word-Export, CSV/GeoJSON/KML) sind **immer** verfügbar – Server,
KI und Persistenz sind additive Erweiterungen.

| Modus                       | Wann sinnvoll?                                                                          | Was kommt dazu?                                                                                                       |
|-----------------------------|------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| **Browser-only**            | Schneller Einstieg, Live-Demo, einzelne Bezirksrats-Anträge.                             | Karte, Filter, Cluster/Heatmap/Hotspots, POI, Bereichsauswahl, deterministischer PDF-/Word-Export, CSV/GeoJSON/KML.    |
| **Node-Standalone**         | Lokales Hosten, KI-Bewertung, politische Recherche, Video-Export.                        | Zusätzlich: KI-Bewertung (mit Fallback), `POST /api/location-brief` (Berechnung), politische Recherche, Video-Export.  |
| **Node + Analysis Service** | Reproduzierbare Briefs, stadtweite Vergleiche, Top-N-Rankings je Profil.                 | Zusätzlich: versionierte Persistenz der Briefs (PostgreSQL via Spring Boot/Flyway), Lese-Endpunkte, Batch-Job-Anstoß.  |

Aktivieren des Persistenzmodus in der Node-App: einzige Pflicht-Variable
ist `ANALYSIS_SERVICE_BASE_URL` (z. B. `http://analysis-service:8081`).
Bei Nichterreichbarkeit greift ein Fallback – der Brief wird trotzdem
berechnet und zurückgegeben (`persistence.status: "persist_skipped"`),
alle anderen Endpunkte funktionieren unverändert.

Lokales Compose-Setup (Node + Analysis Service + PostgreSQL):

```bash
docker compose --profile persist up
```

### Typischer Ablauf (mit Persistenz)

1. **Stelle analysieren** – Karte, Filter und Bereichsauswahl wie gewohnt;
   `computeExportReport()` liefert das `structured`-Objekt.
2. **Location Brief erzeugen** – `POST /api/location-brief` mit
   `structured`, `locationId` (stabile Stellen-ID, z. B.
   `hannover::altenbekener_damm`) und `profile` (z. B.
   `low_hanging_fruit`).
3. **Optional persistieren** – `persist: true` mitsenden, dann wird der
   Brief versioniert in den Analysis Service geschrieben
   (`persistence.status: "persisted"`).
4. **Gespeicherte Briefs wieder abrufen** –
   `GET /api/location-briefs/by-location/:locationKey` liefert alle
   Versionen einer Stelle (neueste zuerst).
5. **Top-N / Profil-Rankings nutzen** –
   `GET /api/location-briefs/top?city=Hannover&profile=safety_first&limit=10`
   liefert die stadtweite Priorisierung je Profil; eine paginierte
   Übersicht gibt es über `GET /api/location-briefs?city=&profile=&page=&size=`.
6. **Prioritäten-Panel im Browser nutzen** – im Werkbank-V2-UI öffnet
   der Button **„📊 Prioritäten & gespeicherte Briefs"** ein Panel mit
   zwei Modi: *Top-N je Stadt + Profil* und *gespeicherte Briefs je Ort*.
   Jede Karte zeigt Ort/Titel, Profil, zentrale Scores, Konfliktmuster,
   empfohlene Maßnahmen, einen politischen Kontext-Hinweis sowie ein
   Status-Badge (`frisch berechnet` / `aus Persistenz` / `persistiert` /
   `Fallback`).  Ohne Analysis Service degradiert das Panel sichtbar:
   `dataStatus: "fallback_result"` mit klarer Begründung – die Karte
   und alle Export-Wege funktionieren unverändert.

Das stabile `dataStatus`-Vokabular auf API-Seite (zusätzlich zum
bestehenden `persistence.status`) ist:
`freshly_computed` · `loaded_from_store` · `persisted` ·
`fallback_result`.  Details und Beispiel-Responses:
[`docs/server-features.md` §14](docs/server-features.md#14-gruppe-priorities--decision-cards-für-die-prioritätenansicht).

Detaillierte Endpunkte, alle Env-Variablen (Timeout/Retry/Auto-Persist),
Persistenz-Lebenszyklus (`freshly_computed` / `loaded_from_store` /
`persisted` / `persist_skipped`) und Migrations-/Health-Hinweise:

- API-Referenz nach Gruppen → [`docs/server-features.md`](docs/server-features.md)
- Analysis Service (Domäne, Schema, Versionierung, Batch) → [`analysis-service/README.md`](analysis-service/README.md)

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

| Generierter PDF-Bezirksratsantrag |
|---|
| [![PDF-Export](docs/screenshots/15-export-pdf-rendered.png)](docs/screenshots/15-export-pdf-rendered.png) |

Weitere Screenshots und ausführliche Erklärungen: → [docs/DOKUMENTATION.md](docs/DOKUMENTATION.md)

---

## 🎭 Geführte Tour & Showcase

### Showcase – automatische Beispiel-Rotation

Die **[Showcase-Seite](https://carstenartur.github.io/Unfallatlas/showcase.html)** lädt die Beispiel-URLs aus der README nacheinander in einem `<iframe>` und wechselt automatisch alle 12 Sekunden. Ideal zum Präsentieren der Werkbank ohne manuelle Eingaben.

→ [showcase.html](showcase.html) öffnen · Play/Pause, Vor/Zurück, Dot-Navigation, Geschwindigkeit wählbar · Keyboard: ← →

### Geführte Tour in der Werkbank

Die **Werkbank V2** enthält einen eingebauten Tour-Player (`js/ua.tour.js`) der JSON-Sequenzen abspielt:

**Tour starten:**
- Klick auf **▶ Tour starten** im Panel unter „Geführte Tour" – startet die eingebaute Demo-Tour
- Oder URL-Parameter: `?tour=demo` (lädt `tours/demo.json`)
- Oder eigene Tour: `?tour=https://example.com/meine-tour.json`

**Tour-Overlay** zeigt:
- Aktuellen Schritt mit Beschreibung
- Fortschritt (z.B. „3 / 12")
- Play/Pause, Vor/Zurück, Beenden-Buttons

**Eigene Tour aufzeichnen (Recorder):**
1. Klick auf **⏺ Aufzeichnen** im Panel → roter REC-Badge erscheint
2. Normal in der Werkbank navigieren (Kartenausschnitt ändern, Filter setzen, Export öffnen)
3. Erneut auf den Button klicken → **Aufzeichnung stoppen**
4. Im Editor: Beschreibungen anpassen, Pausen editieren, Schritte löschen/sortieren
5. **Als JSON herunterladen** → in `tours/` ablegen und über `?tour=dateiname` aufrufen
6. **Vorschau abspielen** – direkt aus dem Editor heraus

**Tour-JSON-Format** (Beispiel):
```json
{
  "name": "Meine Tour",
  "steps": [
    { "action": "setCity",   "value": "Bonn",   "description": "Bonn laden",      "pause": 3000 },
    { "action": "flyTo",     "lat": 50.73, "lng": 7.10, "zoom": 14, "description": "Übersicht", "pause": 2000 },
    { "action": "setFilter", "filters": { "includeCyclist": true, "includeCar": true, "involvementMode": "and" }, "description": "Rad+Auto", "pause": 3000 },
    { "action": "openExport","description": "Export öffnen", "pause": 5000 },
    { "action": "closeExport","description": "Schließen",    "pause": 1000 }
  ]
}
```

---

## 🎬 Demo-Video

Das Projekt enthält einen automatisierten Demo-Ablauf auf Basis von [Playwright](https://playwright.dev/). Er durchläuft die wichtigsten Funktionen der Werkbank (Stadt wählen → Filter setzen → Heatmap → Legende → Export) und zeichnet das Ergebnis als Video auf.

![Demo-Ablauf der Unfallwerkbank V2](docs/demo.gif)

<details>
<summary><strong>Demo-Video selbst erzeugen (klicken zum Aufklappen)</strong></summary>

```bash
npm install
npx playwright install --with-deps chromium
npm run demo
```

Das Video wird unter `test-results/` als `.webm`-Datei gespeichert und kann z. B. mit `ffmpeg` in GIF oder MP4 konvertiert werden:

```bash
# Beispiel: WebM → GIF (wie oben)
ffmpeg -i test-results/<video>.webm -vf "fps=5,scale=800:-1:flags=lanczos" docs/demo.gif

# Beispiel: WebM → MP4
ffmpeg -i test-results/<video>.webm -c:v libx264 -crf 23 demo.mp4
```

</details>

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
./convertAmt2gmaps.sh --uland 03 --uregb 2 --ukreis 41 [--ugemeinde 001]
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

## 🐳 Docker

Die Unfallwerkbank ist als fertiges Docker-Image unter `ghcr.io/carstenartur/unfallatlas` verfügbar. Die Docker-Distribution enthält gegenüber der GitHub-Pages-Version einen zusätzlichen **„🎬 Als Video exportieren"-Button**, der den kompletten Analyse-Ablauf als GIF-Video generiert.

### Schnellstart

```bash
# Image ziehen und starten
docker run -p 8000:8000 ghcr.io/carstenartur/unfallatlas

# Browser öffnen → http://localhost:8000
```

### Mit Docker Compose

```bash
docker compose up
# → http://localhost:8000
```

### Lokal bauen

```bash
docker build -t unfallatlas .
docker run -p 8000:8000 unfallatlas
```

### Video-Export-Funktion (nur Docker)

Nach dem Start der Docker-Version erscheint im Export-Bereich ein **„🎬 Als Video exportieren"-Button**. Dieser:

1. Sammelt alle aktuellen Einstellungen (Stadt, Filter, Kartenposition, markierter Bereich)
2. Schickt sie an den integrierten Backend-Service
3. Playwright spielt den kompletten Ablauf animiert durch – von der Standardansicht über die Filterauswahl bis zum Bezirksratsantrag
4. Das fertige GIF wird automatisch heruntergeladen

> **Hinweis:** Der Button ist ausschließlich in der Docker-Distribution sichtbar. Auf GitHub Pages ist er nicht vorhanden (graceful degradation).

---

## ⚙️ Betriebsarten / Betriebs-Matrix

Die Werkbank unterstützt vier Betriebsarten mit unterschiedlichem
Funktions­umfang.  Alle Kernfunktionen (Karte, Filter, Cluster, Heatmap,
PDF-/Word-Export, CSV/GeoJSON/KML) sind **immer** verfügbar – Server und
KI sind optionale Erweiterungen.

| Funktion | Browser-only<br>(GitHub Pages) | Lokaler Server<br>**ohne** `GEMINI_API_KEY` | Lokaler Server<br>**mit** `GEMINI_API_KEY` | Docker |
|---|:---:|:---:|:---:|:---:|
| Karte, Filter, Cluster, Heatmap, Hotspots | ✅ | ✅ | ✅ | ✅ |
| POI-Overlay (Schulen, Kitas)              | ✅ | ✅ | ✅ | ✅ |
| Bereichsauswahl, geteilte URLs            | ✅ | ✅ | ✅ | ✅ |
| CSV / GeoJSON / KML-Export                | ✅ | ✅ | ✅ | ✅ |
| **Deterministischer PDF-/Word-Export**    | ✅ | ✅ | ✅ | ✅ |
| Geführte Tour & Recorder                  | ✅ | ✅ | ✅ | ✅ |
| **Politische Recherche** (Hannover, Berlin, Bonn, Hamburg) | ❌ | ✅ | ✅ | ✅ |
| **KI-Bewertung v2** (mit Fallback)        | ❌ | ✅ Fallback¹ | ✅ KI | ✅ (KI nur mit Key) |
| **KI-Bewertung v1** (`/api/ai/export-assessment`) | ❌ | ❌ (`503`) | ✅ | ✅ (nur mit Key) |
| **Video-Export** (`.gif`)                 | ❌ | ✅ | ✅ | ✅ |
| Konfiguration nötig                       | – | Node 18+ installieren, `npm run start:server` | zusätzlich `GEMINI_API_KEY` setzen | nur `docker run …` (optional `-e GEMINI_API_KEY=…`) |

¹ Ohne `GEMINI_API_KEY` antwortet `POST /api/ai/export-assessment/v2`
mit `200 OK` und `source: "fallback"` (deterministischer, datengestützter
Output ohne KI-Texte). Wer das nicht will, setzt `withFallback: false` im
Body und erhält dann `503`.

### Schnellauswahl

- **Nur ausprobieren / präsentieren** → Browser-only (Live-Demo).
- **PDF-Antrag schreiben + politische Recherche** → lokaler Server ohne KI.
- **Zusätzlich KI-Vorschläge & Maßnahmensteckbriefe** → lokaler Server mit
  `GEMINI_API_KEY` (Google Gemini).
- **Bezirksrats-Präsentationen mit Animations-GIF** → Docker.

### NPM-Skripte (Kurzreferenz)

| Skript                      | Zweck                                                                     |
|-----------------------------|---------------------------------------------------------------------------|
| `npm start` / `npm run start:server` | Lokalen Express-Server auf `:8000` starten (`node server/index.js`) |
| `npm run start:docker`      | Docker-Image bauen und starten (`docker compose up --build`)              |
| `npm test`                  | Unit- und Integrationstests (Jest)                                        |
| `npm run test:e2e`          | End-to-End-Tests im Chromium-Browser (Playwright)                          |
| `npm run test:coverage`     | Jest mit Coverage-Report unter `coverage/`                                |
| `npm run smoke`             | Smoke-Tests gegen einen laufenden Server (`scripts/smoke.sh`)             |
| `npm run demo`              | Erzeugt ein Demo-Video (Playwright `demo`-Projekt)                        |

Browser-Entwicklung benötigt keinen Build-Schritt: einfach
`werkbank_v2.html` lokal öffnen oder einen statischen HTTP-Server (z. B.
`python -m http.server`) im Repo-Root starten.

Status-Endpunkt für Frontend / Smoke: `GET http://localhost:8000/api/status`
(siehe [`docs/server-features.md`](docs/server-features.md)).

### Architekturüberblick (Kurzfassung)

- **Browser** ist autark und enthält den deterministischen Export-/Analyse­
  pfad ([`js/ua.export_v2.js`](js/ua.export_v2.js),
  [`js/ua.report_v2.js`](js/ua.report_v2.js)).
- **`server/ai/`** stellt die optionale KI-Bewertung bereit (Gemini,
  strikte Schema-Validierung, Cache, Reparatur­versuch, Fallback).
  → [`server/ai/README.md`](server/ai/README.md)
- **`server/political-context/`** recherchiert politische Vorgänge in
  Stadt-/Bezirks-Portalen. Funktioniert serverseitig, weil der Browser die
  externen Portale wegen CORS nicht direkt aufrufen kann.
  → [`server/political-context/README.md`](server/political-context/README.md)
- **Server ist optional**, **KI ist optional**, bestehende Kernfunktionen
  bleiben ohne KI nutzbar. Details:
  [`docs/architecture.md`](docs/architecture.md).

### Konfiguration (Auszug)

| Variable | Standard | Wirkung |
|---|---|---|
| `PORT` | `8000` | Port des Express-Servers |
| `GEMINI_API_KEY` | – | aktiviert die KI-Bewertung; ohne Key bleibt der Fallback aktiv |
| `AI_ASSESSMENT_MODEL` | `gemini-2.0-flash` | Gemini-Modell für die Bewertung |
| `AI_ASSESSMENT_TIMEOUT_MS` | `30000` | Timeout pro KI-Request (ms) |
| `AI_ASSESSMENT_MAX_RETRIES` | `2` | Retries bei `429`/`5xx` |
| `PORTAL_SEARCH_TIMEOUT_MS` | `10000` | Timeout pro Portal-Anfrage (ms) der politischen Recherche |
| `AI_CACHE_PATH`, `AI_JOBS_PATH` | – | optionale Persistenz von KI-Cache und Job-Queue |

Vollständige Liste aller Endpunkte, Request-/Response-Beispiele,
Fehlerfälle und Env-Variablen: → [`docs/server-features.md`](docs/server-features.md).
Vor jedem Release laufen die Smoke-Tests aus
[`docs/release-checklist.md`](docs/release-checklist.md).

---

## Datenquelle & Lizenz

| Thema | Details |
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
- [Architektur-Überblick (Browser + Server + KI)](docs/architecture.md)
- [Server-API & Konfiguration](docs/server-features.md)
- [Release-Checklist](docs/release-checklist.md)
- [Architektur, Tests & Entwicklung](ARCHITECTURE.md)
- [SimRa – Beinaheunfälle im Radverkehr](https://urban-digital.de/mit-simra-sicherheit-im-radverkehr-herausfinden-wo-sich-beinaheunfaelle-im-radverkehr-haeufen/)
- [Nature: Bicycle crash data](https://www.nature.com/articles/s43588-022-00318-w)
- [Deutschlandatlas – Pendlerverflechtungen](https://www.deutschlandatlas.bund.de/DE/Karten/Wie-wir-uns-bewegen/100-Pendlerdistanzen-Pendlerverflechtungen.html)
- [Strava Heatmap](https://www.strava.com/heatmap)
- [Radverkehr in Deutschland](https://www.radverkehr-in-deutschland.de/)
- [Fahrradunfälle](https://fahrrad-unfallorte.de/)
