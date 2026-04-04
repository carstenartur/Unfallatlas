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

## Qualitätssicherung und Tests

Das Projekt verfügt über eine umfassende Testsuite zur Sicherstellung von Qualität, Stabilität und Performance.

### Test-Framework

- **Jest** (v29.7.0) für Unit-Tests, Integrationstests und Performance-Tests
- **Playwright** (v1.48.0) für End-to-End-Tests im Browser
- **jsdom** für Browser-API-Simulation in Jest

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
- **pdfMake** (v0.2.10) - PDF-Generierung
- **FileSaver.js** (v2.0.5) - Download-Funktionalität

### Kartenkacheln

- **OpenStreetMap** - © OpenStreetMap-Mitwirkende
- Lizenz: [ODbL](https://www.openstreetmap.org/copyright)

### Datenquellen

- **Unfallatlas** - Statistische Ämter des Bundes und der Länder
- **POI-Daten** - OpenStreetMap (via Overpass API)
- Lizenz: Datenlizenz Deutschland – Namensnennung – Version 2.0

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

**Zuletzt aktualisiert:** 2026-01-02
