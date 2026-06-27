# Unfallatlas - Architektur und Entwicklerdokumentation

Diese Datei enthält technische Informationen für Entwickler, die am Unfallatlas-Projekt arbeiten.

---

## Inhaltsverzeichnis

- [Projektstruktur](#projektstruktur)
- [Qualitätssicherung und Tests](#qualitätssicherung-und-tests)
- [Continuous Integration](#continuous-integration)
- [Entwicklungsumgebung einrichten](#entwicklungsumgebung-einrichten)
- [Code-Stil und Konventionen](#code-stil-und-konventionen)
- [Verwendete Technologien](#verwendete-technologien)

---

## Projektstruktur

```
.
├── js/                        # JavaScript-Module
│   ├── ua.core.js            # Kernfunktionalität
│   ├── ua.utils.js           # Hilfsfunktionen
│   ├── ua.state.js           # Zustandsverwaltung
│   ├── ua.ui.js              # UI-Interaktionen
│   ├── ua.data_v2.js         # Datenverwaltung
│   ├── ua.filters.js         # Filterfunktionen
│   ├── ua.map_v2.js          # Kartendarstellung
│   ├── ua.export_v2.js       # Export-Funktionen
│   ├── ua.report_v2.js       # Report-Generierung
│   └── ua.app_v2.js          # Applikations-Initialisierung
├── tests/                     # Test-Suite
│   ├── unit/                 # Unit-Tests
│   ├── integration/          # Integrationstests
│   ├── e2e/                  # End-to-End-Tests
│   ├── performance/          # Performance-Tests
│   └── fixtures/             # Test-Daten
├── templates/                 # Text-Vorlagen
├── out/                       # Generierte Daten (GeoJSON, POI)
├── .github/workflows/         # CI/CD-Workflows
├── werkbank_v2.html          # Hauptanwendung
└── convertAmt2gmaps.sh       # Datenkonverter
```

---

## Datenanreicherung in CI

Höhen-, OSM-Straßen- und Verkehrsmengen-Kontextinformationen werden
**in den GitHub-Actions-Workflows** in die per-Stadt-GeoJSON-Dateien
gebacken (Tier-B). Das statische Frontend konsumiert ausschließlich
fertig vorberechnete Dateien und wartet **nie** auf einen Server.

Die Pipeline besteht aus drei Bausteinen:

* `scripts/enrich_geojson.js` reichert die per-Stadt-GeoJSON
  in-place an, schreibt eine kompakte Begleitdatei
  `out/ways_<city>.json` (per-Way-Attribute, geteilt zwischen vielen
  Unfällen) sowie einen Sidecar `out/output_all_years_<city>.enrichment.meta.json`
  mit der Datensatz-Provenance. Im aktuellen v3-Pfad enthält der
  Sidecar `schemaVersion: 3` plus `tileIndexPath` auf
  `ctxtiles/<slug>/index.json`.
* `scripts/check-enrichment-size.js` ist die CI-Bremsschwelle: er
  vergleicht die *gzip*-Größen jeder Stadt-Datei gegen
  `out/.enrichment-size-baseline.json` und bricht den Workflow ab,
  wenn das dokumentierte Wachstumsbudget überschritten wird.
* `js/ua.context_layers.js` lädt die Begleitdatei und den Sidecar
  **lazy**, erst wenn das Context-Layers-Panel geöffnet wird, und
  sogar dann hinter `requestIdleCallback`.

Die existierenden Hot-Path-Module (`js/ua.data_v2.js`,
`js/ua.filters.js`, `js/ua.map_v2.js`, `js/ua.export_v2.js`,
`js/ua.report_v2.js`) hängen **nicht** von der Anreicherung ab. Alle
neuen Felder sind optional, alle Werte werden bei Abwesenheit der
Quelldaten einfach ausgelassen, der Code im Browser bleibt unverändert
schnell. Vollständige Schemadokumentation: [`docs/enrichment.md`](docs/enrichment.md).

---

## Qualitätssicherung und Tests

Das Projekt verfügt über eine umfassende Testsuite zur Sicherstellung von Qualität, Stabilität und Performance.

### Test-Framework

- **Jest** für Unit-Tests, Integrationstests und Performance-Tests (Version siehe `package.json`)
- **Playwright** für End-to-End-Tests im Browser (Version siehe `package.json`)
- **jsdom** für Browser-API-Simulation in Jest

> Konkrete Versionsnummern werden bewusst nicht in der Doku gepflegt – `package.json` ist die Quelle der Wahrheit.

### Test-Kategorien

#### Unit-Tests (43 Tests)

Testen einzelne Funktionen isoliert:

- **Utility-Funktionen** (`tests/unit/ua.utils.test.js`)
  - HTML-Escaping (XSS-Prävention)
  - String-Normalisierung für Städtenamen (z.B. "München" → "muenchen")
  - Query-Parameter-Parsing
  - URL-Manipulation

- **Export-Funktionen** (`tests/unit/ua.report_v2.test.js`)
  - Kartenbild-Erfassung (`captureMapImage`)
  - PDF-Generierung mit pdfMake
  - Word-Dokument-Generierung mit docx.js
  - Fehlerbehandlung bei fehlenden Bibliotheken

**Status**: 39 Tests bestanden, 4 übersprungen (werden in E2E-Tests abgedeckt)

#### Integrationstests (8 Tests)

Testen komplette Workflows:

- PDF-Generierung mit Test-Daten
- Word-Dokument-Generierung
- Export mit POI-Daten-Integration
- Export mit Bezugsdokumenten
- Fehlerbehandlung und Graceful Degradation

**Status**: 6 Tests bestanden, 2 benötigen vollständige Browser-Umgebung (Canvas-API)

#### End-to-End-Tests (22 Tests)

Simulieren echte Benutzerinteraktionen:

- **Benutzer-Workflows** (11 Tests)
  - Seiten-Laden und Initialisierung
  - Stadt-Auswahl
  - Filter-Interaktionen
  - Darstellungsmodus-Umschaltung
  
- **Zeichnen und Export** (3 Tests)
  - Bereich markieren
  - Export-Modal öffnen

- **Export-Modal** (6 Tests)
  - Export-Optionen
  - PDF/Word-Export-Buttons
  - Modal schließen

- **Barrierefreiheit** (2 Tests)
  - ARIA-Attribute
  - ARIA-Labels

#### Performance-Tests (7 Tests)

Benchmarks für Datenverarbeitung:

- ✅ 5.000 Punkte verarbeitet in < 1000ms
- ✅ 10.000 Punkte gefiltert in < 500ms
- ✅ 500 POIs analysiert in < 300ms
- ✅ 3.000 Marker vorbereitet in < 500ms
- ✅ Report-Text generiert in < 200ms
- ✅ 200 POIs im Export in < 500ms
- ✅ Memory-Leak-Prävention

**Alle Performance-Tests bestanden**

### Tests ausführen

```bash
# Abhängigkeiten installieren
npm install

# Alle Unit-Tests
npm run test:unit

# Integrationstests
npm run test:integration

# End-to-End-Tests (benötigt lokalen HTTP-Server)
npm run test:e2e

# E2E-Tests im sichtbaren Browser
npm run test:e2e:headed

# Performance-Tests
npm run test:performance

# Alle Jest-Tests
npm test

# Watch-Modus (automatische Wiederholung bei Änderungen)
npm run test:watch

# Coverage-Report generieren
npm run test:coverage
```

### Test-Fixtures

Test-Daten befinden sich in `tests/fixtures/`:

- `test_accidents.geojson` - Beispiel-Unfalldaten (3 Unfälle mit verschiedenen Schweregraden)
- `test_pois.geojson` - Beispiel-POI-Daten (Schule, Kindergarten, Kita)
- `test_references.json` - Beispiel-Bezugsdokumente

### Weitere Dokumentation

- **[tests/README.md](tests/README.md)** - Ausführliche Test-Dokumentation
- **[TESTING.md](TESTING.md)** - Implementierungsdetails und Best Practices
- **[FINAL_REPORT.md](FINAL_REPORT.md)** - Test-Ausführungs-Zusammenfassung

---

## Continuous Integration

### GitHub Actions

Tests werden automatisch ausgeführt durch `.github/workflows/test.yml`:

**Trigger:**
- Pull Requests auf `main` oder `develop` Branches
- Push auf `main` oder `develop` Branches

**Jobs:**

1. **unit-and-integration-tests**
   - Führt Unit-Tests aus
   - Führt Integrationstests aus
   - Führt Performance-Tests aus
   - Lädt Coverage-Reports hoch

2. **e2e-tests**
   - Installiert Playwright-Browser (Chromium)
   - Startet Python HTTP-Server
   - Führt End-to-End-Tests aus
   - Lädt Test-Reports und Videos bei Fehlern hoch

**Artefakte:**
- Coverage-Reports verfügbar in GitHub Actions
- Playwright-Reports bei Test-Fehlern
- Test-Videos bei E2E-Fehlern

---

## Entwicklungsumgebung einrichten

### Voraussetzungen

**Für Shell-Skripte:**
- sh, bash
- curl, unzip
- awk, grep, sed
- Python 3 (für lokalen HTTP-Server)

**Für Tests:**
- Node.js (v20 oder höher empfohlen)
- npm (v10 oder höher)

### Setup

```bash
# Repository klonen
git clone https://github.com/carstenartur/Unfallatlas.git
cd Unfallatlas

# Test-Abhängigkeiten installieren
npm install

# Playwright-Browser installieren
npx playwright install --with-deps chromium

# Lokalen Server starten (für E2E-Tests und Entwicklung)
python3 -m http.server 8000

# In anderem Terminal: Tests ausführen
npm test
```

---

## Code-Stil und Konventionen

### JavaScript

Das Projekt verwendet eine modulare Architektur mit IIFE-Pattern:

```javascript
(() => {
  const UA = (window.UA = window.UA || {});
  
  // Funktionen definieren
  UA.myFunction = function() {
    // ...
  };
})();
```

**Konventionen:**
- Keine ES6-Module (Browser-Kompatibilität)
- Globales `UA`-Objekt für alle Module
- Sprechende Funktionsnamen
- Fehlerbehandlung mit try-catch
- Graceful Degradation bei fehlenden Features

### HTML/CSS

- Semantisches HTML5
- CSS-Klassen für Styling (keine Inline-Styles außer dynamisch)
- Responsive Design für mobile Geräte
- Barrierefreiheit (ARIA-Attribute)

### Commit-Messages

Bevorzugtes Format:
```
Kurze Beschreibung (max 50 Zeichen)

Längere Erklärung falls nötig.
- Aufzählungen möglich
- Bezug zu Issues: #123
```

---

## Verwendete Technologien

### Frontend-Bibliotheken (CDN)

- **Leaflet** (v1.9.4) - Interaktive Karten
- **Leaflet.markercluster** (v1.5.3) - Marker-Clustering
- **leaflet.heat** (v0.2.0) - Heatmap-Darstellung
- **Leaflet.draw** (v1.0.4) - Zeichenfunktionen
- **leaflet-image** (v0.4.0) - Karten-Export

### Dokument-Export

- **docx.js** (v9.6.1) - Word-Dokument-Erstellung
- **pdfMake** (v0.3.7) - PDF-Generierung
- **FileSaver.js** (v2.0.5) - Download-Funktionalität

### Kartenkacheln

- **OpenStreetMap** - © OpenStreetMap-Mitwirkende
- Lizenz: [ODbL](https://www.openstreetmap.org/copyright)

### Datenquellen

- **Unfallatlas** - Statistische Ämter des Bundes und der Länder
- **POI-Daten** - OpenStreetMap (via Overpass API)
- Lizenz: Datenlizenz Deutschland – Namensnennung – Version 2.0

---

## Rendering-Architektur (Issue #308)

Die Rendering-Pipeline wurde refaktoriert, um deterministische, debounced Renders zu ermöglichen und Wettlaufbedingungen zwischen asynchronen Ladevorgängen und UI-Events zu vermeiden.

### Datenfluss

```
UI-Event / Viewport-Change / Daten-Load
         |
         ▼
  ctx.store.dispatch(action)        ← ua.map_store.js
         |
         ▼
  RenderScheduler.schedule(fn)      ← ua.render_scheduler.js
  (debounce + epoch-guard)
         |
         ▼
  UA.applyFilters(ctx)              ← ua.filters.js
  UA.applyViewportFilter(ctx)
  UA.renderLayers(ctx)              ← ua.map_v2.js
  UA.saveCityState(ctx)             ← ua.state.js
```

### Schlüssel-Invarianten

- UI-Handler rufen `UA.renderLayers()` **nicht** direkt auf; sie dispatchen eine Action an `ctx.store`.
- Rendering erfolgt ausschließlich durch den `RenderScheduler`.
- Asynchrone Context-Ladevorgänge, die nach einem neueren Render ankommen, werden über den Epoch-Mechanismus verworfen.
- `UA.renderLayers()` selbst ist unverändert — die neue Schicht ist ein reines Routing-Layer davor.

---

## Module-Übersicht

### Kern-Module

**ua.core.js**
- Grundlegende Konstanten und Konfiguration
- Globale Initialisierung

**ua.utils.js**
- Hilfsfunktionen (escapeHtml, normKey, Query-Params)
- URL-Manipulation
- Datum/Zeit-Helpers

**ua.state.js**
- Zentraler Anwendungs-State
- State-Management
- URL-State-Synchronisation

**ua.ui.js**
- UI-Event-Handler
- Element-Referenzen
- UI-Updates
- Layer-Toggle-Handler dispatchen seit Issue #308 über `ctx.store`

### Domain-Modell (Issue #309)

**ua.traffic_situation.js** — `UA.TrafficSituation`
- Erstes First-Class-Domänenobjekt der Unfallwerkbank
- Repräsentiert eine vollständige, serialisierbare Verkehrssituation als einzelnes JSON-Objekt
- Enthält einen unveränderlichen Kern (`core`: Viewport, Filter, Selection, LayerVisibility) und ein optionales Layer-Dictionary
- Jeder Layer (`ACCIDENT`, `POI`, `CONTEXT_ROAD`, `POLITICAL_CONTEXT`, `ENVIRONMENTAL`, `AI_ASSESSMENT`, `RECOMMENDATION`, `EXPORT`, `PRESENTATION`) ist optional, versioniert und unabhängig einsetzbar
- Keine Leaflet-Abhängigkeit
- API:
  - `UA.TrafficSituation.LAYER_TYPES` — alle Layer-Typ-Konstanten
  - `UA.TrafficSituation.create(overrides?)` — Instanz mit Defaults erzeugen
  - `UA.TrafficSituation.fromMapScene(scene, layers?)` — aus MapScene erstellen (Rückwärtskompatibilität)
  - `UA.TrafficSituation.toMapScene(ts)` — zu MapScene konvertieren (für bestehende Rendering-/URL-Module)
  - `UA.TrafficSituation.addLayer(ts, layer)` — Layer hinzufügen (neues Objekt, unveränderlich)
  - `UA.TrafficSituation.removeLayer(ts, layerType)` — Layer entfernen (neues Objekt)
  - `UA.TrafficSituation.getLayer(ts, layerType)` — Layer abrufen oder null
  - `UA.TrafficSituation.serialize(ts)` — tiefer Klon als JSON-sicheres Objekt
  - `UA.TrafficSituation.deserialize(data)` — aus geparster JSON wiederherstellen

```
TrafficSituation
├── version      (Schemaversionsnummer)
├── id           (optionaler stabiler Bezeichner, URL-Referenz)
├── metadata     { city, created, updated, description }
├── core
│    ├── viewport         { center, zoom }
│    ├── selection        { south, west, north, east } | null
│    ├── filters          (Schweregrad, Tagestyp, Beteiligte, …)
│    ├── layerVisibility  { showCluster, showHeatmap, … }
│    └── accidentView     (bySeverity | byType | …)
└── layers       (Objekt, nach Typ indiziert — alle optional)
     ├── accident
     ├── poi
     ├── contextRoad
     ├── politicalContext
     ├── environmental
     ├── aiAssessment
     ├── recommendation
     ├── export
     └── presentation
```

### Architektur-Module (Issue #308)

**ua.map_scene.js** — `UA.MapScene`
- Reines Datenmodell (keine Leaflet-Abhängigkeit)
- Beschreibt eine vollständige Verkehrssituation: Stadt, Viewport, Filter, Layer-Sichtbarkeit, Unfall-Ansicht, Export-Optionen
- `UA.MapScene.create(overrides)` — Instanz mit Defaults erzeugen
- `UA.MapScene.fromCtx(ctx)` — aktuellen ctx in ein MapScene-Snapshot überführen

**ua.render_scheduler.js** — `UA.RenderScheduler`
- Debouncing mit konfigurierbarer Verzögerung
- Epoch-basierte Stale-Erkennung: ältere Render-Aufrufe werden automatisch verworfen
- `schedule(fn, delayMs)` — synchron oder mit Timeout
- `scheduleRaf(fn, delayMs)` — Timeout + requestAnimationFrame (für Viewport-Updates)
- `cancel()` — ausstehenden Render abbrechen
- `isStale(epoch)` — prüft, ob ein Epoch veraltet ist

**ua.map_store.js** — `UA.MapStore`
- Zentraler Action-Dispatcher, gebunden an einen `ctx`
- Unterstützte Actions: `filtersChanged`, `layerToggled`, `viewportChanged`, `cityLoaded`, `selectionChanged`, `exportModeChanged`, `contextLayerLoaded`
- `ctx.store = UA.MapStore.create(ctx)` wird in `ua.app_v2.js` nach vollständiger Initialisierung erstellt

**ua.leaflet_map_adapter.js** — `UA.LeafletMapAdapter`
- Kapselt alle Leaflet-spezifischen Operationen
- `replaceLayer(current, next)` — atomisches Layer-Austauschen
- `removeLayer(layer)` — Layer entfernen, gibt null zurück
- `bringLayerToFront(layer)` — Layer nach vorne bringen (falls unterstützt)
- `setView(center, zoom)` — Viewport setzen
- `fitBounds(bounds, opts)` — auf Bounding-Box zoomen
- `waitUntilStable(opts)` — wartet auf visuell stabilen Map-Zustand

**ua.map_scene_url_codec.js** — `UA.MapSceneUrlCodec`
- Bidirektionale URL ↔ MapScene Serialisierung
- `encode(scene)` — MapScene → Query-String (nur Nicht-Default-Werte)
- `decode(search)` — Query-String → MapScene (mit Defaults für fehlende Parameter)
- Rückwärtskompatibel mit bestehenden URLs

**ua.preview_map_renderer.js** — `UA.PreviewMapRenderer`
- Rendert eine vollständige Verkehrssituation aus einem MapScene in einen DOM-Container
- Ohne Seiteneffekte auf die Live-Karte
- Einsetzbar für Vorschaubilder, Word/PDF-Exporte und zukünftige Server-seitige Renders
- `UA.PreviewMapRenderer.render({ container, scene, pts, onReady, waitOpts })`

### Daten-Module

**ua.data_v2.js**
- GeoJSON-Laden
- POI-Daten-Laden
- Referenzdokumente-Laden
- Cache-Management

**ua.filters.js**
- Filter-Logik
- Daten-Filterung nach Kriterien
- Beteiligungskombinationen

### Karten-Modul

**ua.map_v2.js**
- Leaflet-Karten-Initialisierung
- Layer-Management (Cluster, Heatmap)
- Marker-Erstellung
- POI-Darstellung
- Drawing-Tools

### Export-Module

**ua.export_v2.js**
- Template-Laden
- Report-Text-Generierung
- Statistik-Berechnung
- POI-Analyse

**ua.report_v2.js**
- Kartenbild-Capture
- PDF-Generierung (pdfMake)
- Word-Dokument-Generierung (docx.js)
- Export-UI-Initialisierung

### Applikations-Modul

**ua.app_v2.js**
- Applikations-Start
- Module-Initialisierung
- Event-Binding
- Fehlerbehandlung
- Erstellt `ctx.store = UA.MapStore.create(ctx)` nach vollständiger Initialisierung

---

## Lizenz und Datenquellen

### Code-Lizenz

Siehe [LICENSE](LICENSE) für Details zur Projekt-Lizenz.

### Datenlizenzen

**Unfalldaten:**
- Quelle: Unfallatlas / Open-Data-Downloads
- Lizenz: Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0)
- [Mehr Informationen](https://www.govdata.de/dl-de/by-2-0)

**POI-Daten:**
- Quelle: © OpenStreetMap contributors
- Lizenz: Open Database License (ODbL)
- [Mehr Informationen](https://www.openstreetmap.org/copyright)

**Kartenkacheln:**
- © OpenStreetMap-Mitwirkende
- [Copyright-Informationen](https://www.openstreetmap.org/copyright)

---

## Weiterführende Dokumentation

- **[README.md](README.md)** - Benutzer-Dokumentation
- **[WERKBANK_V2.md](WERKBANK_V2.md)** - Werkbank V2 Features und POI-Integration
- **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** - Implementierungs-Übersicht
- **[usage.md](usage.md)** - Nutzungs-Beispiele

---

**Zuletzt aktualisiert:** 2026-06-27 (TrafficSituation-Domänenmodell ergänzt, Issue #309)
