# Unfallwerkbank V2 - POI und Bezugsdokumente

## Überblick

Die Unfallwerkbank V2 (`werkbank_v2.html`) erweitert die ursprüngliche Unfallwerkbank um zwei neue Funktionen:

1. **POI-Integration (Points of Interest)**: Schulen, Kindergärten und Kitas
2. **Bezugsdokumente**: Verweise auf relevante Dokumente und Konzepte

Die ursprüngliche `werkbank.html` bleibt unverändert und voll funktionsfähig.

## Architektur

### Parallele Versionierung

- **werkbank.html**: Original-Version, nutzt `ua.export.js`
- **werkbank_v2.html**: Neue Version, nutzt `ua.export_v2.js`

Beide Versionen teilen sich die gleichen Basis-Module:
- `ua.core.js`
- `ua.utils.js`
- `ua.state.js`
- `ua.ui.js`
- `ua.data.js`
- `ua.filters.js`
- `ua.map.js`
- `ua.app.js`

Die V2-Version verwendet zusätzlich folgende Module:
- `ua.export_v2.js` – Erweiterte Exportlogik mit Kreuztabelle, Einzelunfall-Tabelle, POI-Analyse, Gremien-Matching
- `ua.report_v2.js` – Word- und PDF-Export mit dynamischem Titel, Rahmendaten, Filterblock, Anlagenblock
- `ua.tour.js` – Tour-System (Player + Recorder) für interaktive Analyse-Demonstrationen
- `ua.video-export.js` – Client-seitiger Video-Export (Parameter-Sammlung für Docker-basierte GIF-Erzeugung)
- `ua.app_v2.js` – V2-spezifische App-Logik (dynamischer Modal-Titel, Tour-Integration)
- `ua.map_v2.js` – V2-Kartenlogik (Detailkarte, erweiterte Heatmap-Steuerung)
- `ua.context_road_layer.js` – First-class Karten-Layer für Straßenkontext
  („Straßensteigung" / „Verkehrsbelastung", siehe unten)

## Karten-Layer: Straßensteigung / Verkehrsbelastung

Wenn die Stadt mit Slope- bzw. DTV-Daten angereichert wurde, blendet
die Karte oben links ein **Karten-Layer-Control** ein (Checkboxen
„Straßensteigung" und „Verkehrsbelastung"). Beim Aktivieren werden die
betroffenen Straßenabschnitte direkt auf der Karte farbig eingefärbt
(Canvas-Rendering, Klassen-Rampe siehe Legende unten links). Beide
Overlays sind defaultmäßig **aus** und merken sich ihren Zustand in
der URL (`?mapLayer=slope,traffic`) — geteilte Links bringen die
Layer-Sichtbarkeit also mit.

> **Hinweis — Datenabdeckung:** Mit Producer 1.2.0 / `schemaVersion: 3`
> zeigen die Karten-Layer das **vollständige OSM-Straßennetz im
> Stadt-BBox** (ausgeliefert als Slippy-Tiles, viewport-lazy). Die
> Tile-Manifest-URL kommt aus dem Sidecar
> `output_all_years_<slug>.enrichment.meta.json` (`tileIndexPath`).
> 
> 
> *Slope-Farbe* deckt mit `dem_producer.js` ≥ 1.1.0 das **gesamte**
> v3-Kontextnetz ab (Median der Segment-Steigungen aus lokalen
> SRTM-Tiles); die *Verkehrs-Klasse* basiert auf dem DTV-Proxy.
> Vollständige Beschreibung (kanonisch) in
> [`docs/enrichment.md` → „Datenausschnitt der Karten-Layer (Straßennetz vs. matched-only Signal)"](docs/enrichment.md#matched-only-disclaimer).

Die bestehenden Chip-Filter („Kontext-Filter (Detailanalyse)") bleiben
als Sekundärwerkzeug erhalten und blenden Unfallpunkte unabhängig von
den Map-Layern aus. URL-Keys (`ctxSlope`, `ctxTraffic`,
`ctxOnlyMatched`) sind unverändert.

> Screenshot-Platzhalter: *Karten-Layer Straßensteigung / Verkehrsbelastung*


## POI-Integration

### Datenformat

POI-Daten werden als GeoJSON im Verzeichnis `out/` erwartet:

```
out/poi_<stadtslug>.geojson
```

Beispiel: `out/poi_hannover.geojson`

### GeoJSON-Struktur

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [9.7320, 52.3759]
      },
      "properties": {
        "id": "osm:node:123456",
        "type": "school",
        "name": "Beispiel-Grundschule",
        "source": "OpenStreetMap/Overpass"
      }
    }
  ]
}
```

### Unterstützte POI-Typen

- `school` (Schulen)
- `kindergarten` (Kindergärten)
- `childcare` (Kitas)

### POI-Daten erzeugen

Das mitgelieferte Script `fetch_poi_osm.sh` lädt POI-Daten von OpenStreetMap:

```bash
./fetch_poi_osm.sh "Hannover"
```

Dies erzeugt automatisch die Datei `out/poi_hannover.geojson`.

**GitHub Workflow**: Ein automatisierter GitHub Actions Workflow (`generate-and-commit.yml`) erzeugt POI-Daten für alle Städte in `cities.txt`. Der Workflow kann manuell ausgelöst werden und committet die erzeugten Dateien automatisch.

### POI-Analyse im Export

Die V2-Exportfunktion analysiert automatisch:

1. **POIs im Ausschnitt**: Direkt innerhalb des markierten/angezeigten Bereichs
2. **POIs in der Nähe**: Innerhalb von 200m vom Ausschnitt

Die Analyse wird sowohl im Text-Export als auch im HTML-Report dargestellt.

### Fail-Safe-Verhalten

- Fehlende POI-Daten führen **nicht** zu Fehlern
- Der Export funktioniert normal weiter
- Es wird lediglich keine POI-Sektion angezeigt
- Warnungen werden in der Browser-Konsole ausgegeben

## Bezugsdokumente

### Datenformat

Bezugsdokumente werden als JSON im Verzeichnis `templates/` erwartet:

```
templates/references_<stadtslug>.json
```

Beispiel: `templates/references_hannover.json`

Diese Struktur ermöglicht die zentrale Verwaltung von Bezugsdokumenten zusammen mit anderen Templates.

### JSON-Struktur

```json
{
  "documents": [
    {
      "title": "Die Ideale Kreuzung – Leitfaden für sichere Knotenpunkte",
      "author": "Region Hannover",
      "date": "2023",
      "url": "https://www.hannover.de/...",
      "description": "Planerischer Leitfaden zur Gestaltung sicherer Kreuzungen mit Fokus auf vulnerable Verkehrsteilnehmer. Beschreibt konkrete Gestaltungskriterien zur Vermeidung typischer Unfallmuster."
    }
  ]
}
```

**Wichtig**: Bezugsdokumente sollten fachlich relevante, planerisch anschlussfähige Quellen sein:
- Planerische Leitfäden und Standards (z.B. ERA, RASt, "Die Ideale Kreuzung")
- Empirische Verkehrsforschung zu spezifischen Unfallmustern
- Regionale Verkehrssicherheitskonzepte und Mobilitätspläne
- Regelwerke und Best Practices zur Knotenpunktgestaltung

Keine beliebigen Link-Sammlungen, sondern kontextualisierte Referenzen mit klarer Begründung ihrer Relevanz für die konkrete Unfallhäufung.

### Felder

- `title` (erforderlich): Titel des Dokuments
- `author` (optional): Autor/Organisation
- `date` (optional): Datum (Format beliebig, z.B. "YYYY-MM-DD")
- `url` (optional): Link zum Dokument
- `description` (optional): Kurzbeschreibung

### Darstellung im Export

Bezugsdokumente werden in beiden Export-Formaten dargestellt:

- **Text-Export**: Als Liste mit allen Details
- **HTML-Report**: Als formatierte Liste mit anklickbaren Links

### Fail-Safe-Verhalten

- Fehlende Bezugsdokumente führen **nicht** zu Fehlern
- Der Export funktioniert normal weiter
- Es wird lediglich keine Bezugsdokumente-Sektion angezeigt
- Warnungen werden in der Browser-Konsole ausgegeben

## Verwendung

### Werkbank V2 öffnen

Öffnen Sie `werkbank_v2.html` im Browser oder verwenden Sie die GitHub Pages URL:

```
https://carstenartur.github.io/Unfallatlas/werkbank_v2.html
```

### POI-Daten für eine Stadt hinzufügen

1. POI-Daten abrufen:
   ```bash
   ./fetch_poi_osm.sh "Berlin"
   ```

2. Datei wird erstellt: `out/poi_berlin.geojson`

3. Bei Verwendung mit GitHub Pages: Datei committen und pushen

Alternativ: GitHub Actions Workflow auslösen, der automatisch POIs für alle Städte in `cities.txt` generiert.

### Bezugsdokumente für eine Stadt hinzufügen

1. JSON-Datei erstellen: `templates/references_<stadtslug>.json`

2. Dokumente nach dem obigen Format eintragen (fachlich relevante Quellen)

3. Bei Verwendung mit GitHub Pages: Datei committen und pushen

## Stadt-Slug-Konvention

Der Stadt-Slug wird aus dem Stadtnamen abgeleitet:

- Kleinbuchstaben
- Umlaute normalisiert (ä→ae, ö→oe, ü→ue, ß→ss)
- Leerzeichen und Sonderzeichen → Unterstrich
- Mehrfache Unterstriche → ein Unterstrich

Beispiele:
- "Hannover" → `hannover`
- "Frankfurt am Main" → `frankfurt_am_main`
- "Köln" → `koeln`
- "München" → `muenchen`

Die Funktion `UA.normKey()` aus `ua.utils.js` wird dafür verwendet.

## Templates

Die V2-Version nutzt die gleichen Text-Templates wie die Original-Version:

```
templates/intro.txt
templates/sachverhalt.txt
templates/beschluss.txt
templates/hinweis.txt
templates/lizenz.txt
```

Zusätzlich können stadtspezifische Bezugsdokumente definiert werden:

```
templates/references_<stadtslug>.json
```

Die Templates können angepasst werden. Falls eine Datei fehlt, werden Standardtexte verwendet.

## Koexistenz beider Versionen

Beide Versionen können parallel betrieben werden:

- `werkbank.html`: Bewährte Version ohne POI/Bezugsdokumente
- `werkbank_v2.html`: Neue Version mit erweiterten Features

Die Wahl der Version erfolgt durch die URL. Alle weiteren Funktionen (Filter, Darstellung, Analyse) sind identisch.

## Technische Details

### Verzeichnisstruktur

```
.
├── werkbank.html              # Original-Version (deprecated – Link zu V2)
├── werkbank_v2.html           # V2 mit POI-Support
├── showcase.html              # Showcase-Seite (iframe-basiert)
├── js/
│   ├── ua.export.js          # Original Export-Modul
│   ├── ua.export_v2.js       # V2 Export-Modul mit POI/Ref-Docs/Kreuztabelle
│   ├── ua.report_v2.js       # Word/PDF-Export (dynamischer Titel, Metadaten, Anlagen)
│   ├── ua.tour.js            # Tour-System (Player + Recorder)
│   ├── ua.video-export.js    # Video-Export Client-Modul
│   ├── ua.app_v2.js          # V2 App-Logik
│   ├── ua.map_v2.js          # V2 Kartenlogik
│   ├── ua.accident_views.js  # Strategie-Registry für Einzelunfall-Tabelle
│   │                          (bySeverity / byInvolvement / flat / byTimePattern)
│   ├── ua.time_clusters.js   # Verkehrszeit-Cluster (Loader + Default-Definition)
│   ├── ua.costs.js           # Volkswirtschaftliche Kosten (BASt-Größenordnungen)
│   ├── ua.measures.js        # Maßnahmenkatalog + Empfehlungs-Engine
│   │                          (filtert via OSM-Kontext-Voraussetzungen)
│   ├── ua.osm_context.js     # OSM-Kontext-Anreicherung (Overpass-API)
│   ├── ua.trend.js           # Mehrjahres-Trendlinie (lineare Regression)
│   ├── ua.heatmap.js         # Stunde × Wochentag-Heatmap
│   ├── ua.ai_proposal.js     # KI-Antragsentwurf (Brücke zur Server-API)
│   └── ...                   # Gemeinsame Module
├── out/
│   ├── poi_hannover.geojson  # POI-Daten (GeoJSON)
│   ├── poi_berlin.geojson
│   ├── output_all_years_*.geojson  # Unfalldaten
│   └── ...
├── tours/                    # Tour-Dateien (JSON)
│   └── demo.json
└── templates/                # Text-Templates + Referenzdokumente + Gremien
    ├── intro.txt
    ├── sachverhalt.txt
    ├── ...
    ├── gremien_hannover.json
    ├── gremien_berlin.json
    ├── references_hannover.json
    ├── references_berlin.json
    └── ...
```

### Spatial Analysis

Die POI-Analyse nutzt:

1. **Leaflet Bounds**: `bounds.contains([lat, lon])` für "innerhalb"
2. **Distanzberechnung**: Leaflet's `distanceTo()` für "in der Nähe"
3. **Buffer**: 200 Meter Standardpuffer um den Ausschnitt

### Fehlerbehandlung

Alle neuen Features sind mit Try-Catch-Blöcken geschützt:

```javascript
try {
  const poiData = await loadPOIData(citySlug);
  if (poiData) {
    poiAnalysis = analyzePOIs(poiData, bounds);
  }
} catch (e) {
  console.warn("POI analysis failed:", e);
}
```

Dadurch wird sichergestellt, dass Fehler beim Laden oder Verarbeiten von POI/Bezugsdokumenten den Export nicht blockieren.

## Zukünftige Erweiterungen

Mögliche Erweiterungen der V2-Funktionalität:

1. **Erweiterte POI-Typen**: Bushaltestellen, Seniorenheime, etc.
2. **POI-Overlay auf Karte**: POIs direkt auf der Karte darstellen
3. **Interaktive POI-Filter**: POI-Typen ein-/ausblenden
4. **Bezugsdokumente-Metadaten**: Tags, Kategorien, Relevanz-Scores
5. **Automatische Bezugsdokument-Zuordnung**: Basierend auf Unfallmuster

## Word/PDF Export (NEU)

### Überblick

Ab Version V2 können Berichte direkt als **Word-Dokument (.docx)** oder **PDF** exportiert werden. Diese Dokumente sind speziell für politische/administrative Dokumente (z.B. Bezirksratsanträge) formatiert.

### Funktionen

#### Export-Formate

- **Word (.docx)**: Vollständig editierbares Dokument für weitere Bearbeitung
- **PDF**: Druckfertiges Dokument zur direkten Verwendung

#### Dokumentstruktur

Die exportierten Dokumente enthalten folgende Abschnitte:

1. **Deckblatt**
   - Stadt / Gebiet
   - Datum
   - Betreff (Verbesserung der Verkehrssicherheit)

2. **SACHVERHALT**
   - Anzahl der Unfälle im betrachteten Gebiet
   - Verteilung nach Unfallschwere
   - Zeitliche und räumliche Einordnung

3. **KARTENAUSSCHNITT** (optional)
   - Hochauflösende Karte des Unfallbereichs
   - Programmatisch erzeugt (kein Screenshot)
   - Unfallpunkte farblich nach Schweregrad markiert
   - Legende integriert

4. **SENSIBLE EINRICHTUNGEN** (optional, wenn POI-Daten verfügbar)
   - Auflistung betroffener Schulen/Kitas im Umkreis
   - Distanzangaben
   - Sicherheitshinweise

5. **BESCHLUSSVORSCHLAG**
   - Standardtext mit Empfehlungen
   - Sofortmaßnahmen
   - Infrastrukturmaßnahmen
   - Monitoring-Vorschläge

6. **FACHLICHE BEZÜGE** (optional, wenn Referenzdokumente verfügbar)
   - Links zu relevanten Leitfäden
   - Fachpapiere und Konzepte
   - Planerische Bezüge

7. **DATENQUELLE**
   - Lizenzhinweise
   - Quellenangaben

#### Export-Optionen

Im Export-Dialog können folgende Optionen ausgewählt werden:

- ☑ **Kartenausschnitt**: Fügt eine Karte des Unfallbereichs ein
- ☑ **POIs (Schulen/Kitas)**: Integriert POI-Analyse
- ☑ **Referenzdokumente**: Fügt fachliche Bezüge hinzu

### Technische Details

#### Verwendete Bibliotheken

- **docx.js** (v9.7.1): Word-Dokument-Erstellung
- **pdfMake** (v0.3.11): PDF-Dokument-Erstellung
- **leaflet-image** (v0.4.0): Programmatische Kartenerstellung
- **FileSaver.js** (v2.0.5): Download-Funktionalität

Alle Browser-Bibliotheken werden aus den exakt gelockten npm-Versionen durch
`npm run build:site` nach `_site/vendor/` kopiert. Laufzeit-CDN-Fallbacks sind
bewusst ausgeschlossen; siehe [`docs/site-build.md`](docs/site-build.md).

#### Kartenexport

Die Karten werden **programmatisch** erzeugt (nicht als Screenshot):

- Verwendet `leaflet-image` zur Konvertierung der Leaflet-Karte
- Erzeugt hochauflösende PNG-Bilder
- Reproduzierbare Ergebnisse
- Maßstab und Zoomstufe entsprechen der aktuellen Kartenansicht

#### Clientseitige Verarbeitung

Die gesamte Export-Funktionalität läuft **rein clientseitig**:

- Keine Server-Anfragen notwendig
- Datenschutzfreundlich
- Funktioniert auch offline (nach initialem Laden)
- Schnelle Verarbeitung

### Verwendung

1. **Bereich markieren** (optional)
   - Klicke auf "Bereich markieren"
   - Ziehe ein Rechteck über den zu analysierenden Bereich
   - Oder nutze den aktuellen Viewport

2. **Analyse/Export öffnen**
   - Klicke auf "Analyse/Export öffnen"
   - Der Text-Report wird automatisch erzeugt
   - Review die Analyse im Modal

3. **Export-Optionen wählen**
   - Wähle gewünschte Optionen (Karte, POIs, Referenzen)
   - Standardmäßig sind alle Optionen aktiviert

4. **Export starten**
   - Klicke auf "📄 Word (.docx)" für Word-Export
   - Oder klicke auf "📑 PDF" für PDF-Export
   - Das Dokument wird automatisch heruntergeladen

### Dateinamenskonvention

Exportierte Dateien folgen diesem Schema:

```
[Dokumenttitel]_[Stadt]_[Datum].docx
[Dokumenttitel]_[Stadt]_[Datum].pdf
```

Der Dokumenttitel wird dynamisch aus dem Gremientyp abgeleitet:
- **Hannover**: `Bezirksratsantrag_Hannover_01-01-2026.docx`
- **Berlin**: `BVV-Antrag_Berlin_01-01-2026.docx`
- **Andere Städte**: `Antrag-zur-Verkehrssicherheit_Stadt_01-01-2026.docx`

### Browser-Kompatibilität

Die Export-Funktionalität ist kompatibel mit:

- Chrome/Edge (empfohlen)
- Firefox
- Safari (eingeschränkt bei Kartenexport)

**Hinweis**: Moderne Browser erforderlich (ES6+ Support)

### Fehlerbehandlung

Bei Problemen:

1. **Kartenexport fehlgeschlagen**: Der Bericht wird ohne Karte erstellt
2. **Bibliothek nicht geladen**: Überprüfe Internetverbindung
3. **Download blockiert**: Erlaube Downloads für diese Seite

Fehler werden in der Browser-Konsole protokolliert.

### Best Practices

1. **Kartenausschnitt vorbereiten**
   - Zoome auf den relevanten Bereich
   - Stelle sicher, dass alle wichtigen Unfälle sichtbar sind
   - Nutze "Bereich markieren" für präzise Auswahl

2. **POI-Daten**
   - POI-Daten müssen für die Stadt verfügbar sein
   - Siehe Abschnitt "POI-Integration" für Details

3. **Nachbearbeitung**
   - Word-Dokumente können nach Export weiter bearbeitet werden
   - Passe Formulierungen an lokale Gegebenheiten an
   - Ergänze spezifische Details und Kontextinformationen

4. **Qualitätssicherung**
   - Prüfe generierte Texte auf Plausibilität
   - Vergleiche mit Ortskenntnis
   - Ziehe bei Bedarf Unfallkommission hinzu

## Lizenz und Datenquellen

- **POI-Daten**: © OpenStreetMap contributors, ODbL
- **Unfalldaten**: Unfallatlas, Datenlizenz Deutschland – Namensnennung – Version 2.0
- **Code**: Siehe LICENSE-Datei des Projekts
