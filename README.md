# Unfallwerkbank – Interaktive Unfallanalyse für deutsche Städte

> **Wo passieren Fahrradunfälle? Wo sind Schulwege gefährlich? Wo braucht es bessere Radinfrastruktur?**
>
> Die Unfallwerkbank macht amtliche Verkehrsunfalldaten (2016–2024) für ausgewählte deutsche Großstädte als interaktive Karte zugänglich – direkt im Browser, ohne Installation.

[![CI](https://github.com/carstenartur/Unfallatlas/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/carstenartur/Unfallatlas/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/carstenartur/Unfallatlas?sort=semver&label=Release)](https://github.com/carstenartur/Unfallatlas/releases/latest)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io%2Fcarstenartur%2Funfallatlas-blue?logo=docker)](https://github.com/carstenartur/Unfallatlas/pkgs/container/unfallatlas)
[![License](https://img.shields.io/github/license/carstenartur/Unfallatlas)](LICENSE)
[![SBOM](https://img.shields.io/badge/SBOM-CycloneDX-informational?logo=owasp)](https://github.com/carstenartur/Unfallatlas/dependency-graph/sbom)
https://doi.org/10.5281/zenodo.20936471

![Startansicht des vollständigen Unfallwerkbank-Builds](docs/screenshots/01-startansicht.png)

[→ Öffentliche Kernvorschau öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Hannover&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&maxPoints=100000&viewportPaddingPct=20&heatRadius=25&includeCyclist=1&includePedestrian=1&includeCar=1&includeMotorcycle=0&includeGkfz=0&includeSonstig=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&showSchools=1&showKindergartens=1&showArgumentation=1&mapMode=standard&orthophotoOpacity=92&centerLat=52.3759&centerLon=9.7320&zoom=12)

---

## Was ist das?

Die Unfallwerkbank ist ein interaktives Kartenwerkzeug für kommunale
Sicherheitsanalysen mit Unfallatlas-Open-Data.
Nutzer:innen wählen eine Stadt, setzen Filter und sehen sofort, wo sich
Unfälle räumlich und zeitlich häufen.
Die Ergebnisse lassen sich als reproduzierbarer Link teilen und als CSV,
GeoJSON oder KML exportieren. Der vollständige lokale beziehungsweise
Docker-Build erzeugt zusätzlich PDF- und Word-Antragsentwürfe mit Karten-
und Tabellenkontext.
Die Oberfläche ist auf schnelle Exploration ausgelegt:
wenige Klicks von der Stadtwahl bis zur exportierbaren Auswertung.
So lassen sich Analysen im Team transparent diskutieren und reproduzieren.
Die gleiche URL liefert dabei immer denselben Startzustand der Analyse
und reduziert Missverständnisse bei Übergaben oder Präsentationen.

---

## 🚀 Live-Demo

- **Öffentliche Kernvorschau:** https://carstenartur.github.io/Unfallatlas/werkbank_v2.html
- **Showcase:** https://carstenartur.github.io/Unfallatlas/showcase.html

> **Funktionsumfang der öffentlichen Vorschau:** Kartenanalyse, Filter, Cluster
> sowie CSV-, GeoJSON- und KML-Export. Word/PDF, Heatmap und freie
> Rechteckzeichnung sind dort aus Gründen der sicheren Vendor- und
> Lizenzprovenienz vorübergehend deaktiviert. Der vollständige Funktionsumfang
> steht im lokalen beziehungsweise Docker-Build zur Verfügung.

Lokale, vollständige Ausführung:

```bash
npm ci
npm run serve:site
# http://127.0.0.1:8000/werkbank_v2.html
```

Der kanonische Build lädt keine Browser-Bibliotheken zur Laufzeit von einem
CDN. Details zu Dependency-Versionen, Build-Manifest und Offline-Grenzen:
[`docs/site-build.md`](docs/site-build.md).

---

## ⏱️ In 60 Sekunden zur ersten Analyse

1. **[Öffentliche Vorschau öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html)** – läuft direkt im Browser.
2. **Stadt wählen** – z. B. Bonn, Hannover, Berlin oder Hamburg.
3. **Filtern** – Unfallschwere, Beteiligung (Rad, Fuß, PKW, Motorrad, Lkw, Sonstige), Uhrzeit.
4. **Analysieren** – Cluster und verfügbare Kontextansichten prüfen.
5. **Exportieren** – öffentlich als CSV/GeoJSON/KML; im vollständigen Build zusätzlich als PDF/Word.

> Alle Filter werden in der URL gespeichert: gleiche URL → gleiche Analyse.

---

## 🎬 Demo-Video

![Demo-Ablauf der Unfallwerkbank V2](docs/demo.gif)

Kontextdaten-Medien (17–19) werden derzeit bewusst nur als Review-Kandidaten
unter `.build/doc-media/context/` erzeugt. Erst ein gesonderter Review darf sie
zusammen mit Manifest und Doku-Referenzen nach `docs/` übernehmen; die
[Nutzerdoku](docs/DOKUMENTATION.md#kontext-neu) behauptet daher keine bereits
veröffentlichten Kontextaufnahmen.
Die Regeneration des README-GIFs ist in `docs/docker.md` beschrieben.

---

## 🔑 Wichtigste Funktionen

| Funktion | Beschreibung |
|---|---|
| **Filterkombinationen** | Schwere, Beteiligung (ODER / UND / Alleinunfall), Uhrzeit, Wochentag, Fahrbahnzustand |
| **Cluster, Heatmap, Hotspots** | Mehrere Perspektiven auf Unfallschwerpunkte; Heatmap im vollständigen Build |
| **Kontextfilter (neu)** | Hangneigung, Verkehrsklasse-DTV-Proxy und „nur auf gematchten Straßen" (bei vorhandenen Kontextdaten) |
| **Bereichsauswahl** | Geteilte Auswahlgrenzen in der URL; freie Rechteckzeichnung im vollständigen Build |
| **POI-Overlay** | Schulen und Kitas (ab Zoom 15) zur Schulwegsicherheitsbewertung |
| **Export & Datenexport** | Öffentlich CSV, GeoJSON und KML; vollständig zusätzlich PDF und Word |

Typische Fragestellungen, die sich damit schnell beantworten lassen:

- Wo häufen sich Kollisionen zwischen Rad- und Kfz-Verkehr?
- Welche Orte fallen in den Spitzenzeiten (z. B. 6–9 Uhr, 15–18 Uhr) auf?
- Wie verändert sich das Bild zwischen Cluster-Darstellung und Heatmap?
- Welche Schulen/Kitas liegen im unmittelbaren Umfeld auffälliger Stellen?
- Welche Beteiligungskombinationen sind im markierten Bereich überrepräsentiert?

---

## 🗺️ Städte-/Regionen-Katalog

Der bundesweite Städte-/Regionen-Katalog zeigt transparent, welche
Funktionen pro Ort bereits verfügbar sind (Stufen A/B/C).
Die vollständige Capability-Matrix, Rollout-Hinweise und API-Details sind
in [`docs/CITY_CATALOG.md`](docs/CITY_CATALOG.md) dokumentiert.

---

## 📌 Konkrete Anwendungsbeispiele

### Beispiel 1: Auto-Fahrrad-Kollisionen am Bonner Hauptbahnhof

Rad + PKW im **UND-Modus**:

- zeigt räumliche Häufungen von Rad-PKW-Kollisionen,
- eignet sich für die Priorisierung von Kreuzungen/Knoten.

[→ Bonn-Hbf-Analyse in der öffentlichen Vorschau öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&showSchools=0&showKindergartens=0&showArgumentation=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010)

Der folgende Screenshot dokumentiert die zusätzliche **Heatmap des vollständigen
Builds** und ist deshalb bewusst nicht als identische Pages-Ansicht verlinkt:

![Bonn Hbf – Rad+Auto-Heatmap im vollständigen Build](docs/screenshots/13-bonn-hbf-radunfaelle.png)

### Beispiel 2: Fahrrad-Alleinunfälle (Infrastrukturmängel erkennen)

Nur Rad im **Alleinunfall-Modus**:

- deckt Hinweise auf Belag-, Bordstein- oder Trassierungsprobleme auf,
- blendet Fremdbeteiligung aus und fokussiert auf lokale Infrastruktur.

[→ Live in der Werkbank öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=0&includeMotorcycle=0&involvementMode=solo&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7350&centerLon=7.1000&zoom=13)

### Beispiel 3: Schulwegsicherheit – Unfälle neben Schulen und Kitas

Rad + Fuß im **ODER-Modus**, ganztägig (0–23 Uhr), Zoom 16:

- macht POIs (Schulen/Kitas) in der Karte sichtbar,
- hilft bei der Vorbereitung kommunaler Schulweg-Diskussionen.

[→ Live in der Werkbank öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7350&centerLon=7.0950&zoom=16)

[![POI-Ansicht mit Schulen und Kitas](docs/screenshots/12-poi-schulen-kitas.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.7350&centerLon=7.0950&zoom=16)

---

## 🎯 Für wen ist das?

| Zielgruppe | Nutzen |
|---|---|
| **Bezirksräte / Kommunalpolitik** | Datenbasierte Anträge zur Verkehrssicherheit erstellen |
| **Radverkehrsbeauftragte** | Unfallschwerpunkte identifizieren und Maßnahmen priorisieren |
| **Verkehrsplaner / Ingenieurbüros** | Open-Data-Analyse mit reproduzierbaren, teilbaren Links |
| **ADFC / Bürgerinitiativen** | Argumentationsgrundlage für Verbesserungen vor Ort |
| **Forschung / Journalismus** | Explorative Unfallanalyse mit amtlichen Daten |

---

## 📸 Screenshots

| Startansicht (Voll-Build) | Cluster (öffentliche Vorschau) |
|---|---|
| ![Start](docs/screenshots/01-startansicht.png) | [![Cluster](docs/screenshots/04-cluster-ansicht.png)](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Hannover&showCluster=1&showHeatmap=0&showSchools=0&showKindergartens=0&showArgumentation=0) |

[→ Öffentliche Exportansicht öffnen](https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?export=1)
– dort stehen CSV, GeoJSON und KML zur Verfügung. Der Voll-Build-Screenshot mit
Word/PDF ist in der [Nutzerdokumentation](docs/DOKUMENTATION.md#export-und-bezirksratsantrag)
erklärt und wird nicht als identische Pages-Ansicht ausgegeben.

Weitere Screenshots und Erklärungen:
[`docs/DOKUMENTATION.md`](docs/DOKUMENTATION.md).

Kontextdaten-Screenshots (Filter-Panel, Popup, Verkehrsproxy) und die
kontextspezifische Demo sind dort ebenfalls verlinkt.

---

## 📖 Mehr erfahren

### Nutzer:innen

- [Vollständige Nutzerdokumentation](docs/DOKUMENTATION.md)
- [Bundesweiter Städte-/Regionen-Katalog](docs/CITY_CATALOG.md)
- [Maßnahmen-Steckbriefe](docs/LOCATION_BRIEF.md)
- [Tour & Showcase](docs/tour-and-showcase.md)

Diese Links sind auf Bedienung, Beispiele und einordnende Methodik
ausgerichtet.

### Betreiber:innen / Self-Hoster

- [Docker-Betrieb & Video-Export](docs/docker.md)
- [Server-Features & API](docs/server-features.md)
- [Release-Checklist](docs/release-checklist.md)
- [Analysis Service (Persistenz/Ranking)](analysis-service/README.md)

Dieser Bereich bündelt Betrieb, Konfiguration, Release-Checks und
optionale Persistenz-/Batch-Bausteine.

### Entwickler:innen

- [Entwickler-Architektur & Conventions](ARCHITECTURE.md)
- [Architektur (Browser + Server + Analysis Service)](docs/architecture.md)
- [Werkbank-V2-Feature-Referenz](WERKBANK_V2.md)
- [Export-QA / Render-Gate](docs/export-qa.md)
- [Golden-Case-QA für Maßnahmen-Steckbriefe](docs/location-brief-golden-qa.md)
- [Test-Dokumentation](tests/README.md)
- [CI-/Videoexport-Guardrails](docs/ci-video-export-hardening.md)

### Weitere Themen

- [CLI-Datenkonvertierung (Shell + PowerShell)](usage.md)
- [Projekt-Credits, Bibliotheken und weiterführende Links](docs/credits.md)

Für den Pitch reicht die README; die vertiefenden Zielgruppen-Seiten sind
hier bewusst getrennt verlinkt.

---

## Datenquelle & Lizenz

| Thema | Details |
|---|---|
| **Unfallatlas** | [unfallatlas.statistikportal.de](https://unfallatlas.statistikportal.de/) |
| **Open-Data-Downloads** | [opengeodata.nrw.de/…/unfallatlas](https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/) |
| **Datenlizenz** | [Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0) |
| **Koordinatensystem** | WGS84 (EPSG:4326, exportiert aus EPSG:25832) |
