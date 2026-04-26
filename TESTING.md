# Testkonzept-Implementierung für Unfallatlas

## Übersicht

Dieses Dokument beschreibt die Implementierung des Testkonzepts für die Unfallatlas-Anwendung. Die Testsuite stellt die Qualität, Stabilität und Performance der Anwendung sicher.

## Implementierte Komponenten

### 1. Testwerkzeuge

#### Jest (Unit- und Integrationstests)
- **Konfiguration**: `package.json` mit jsdom-Umgebung
- **Verwendung**: Unit-Tests, Integrationstests, Performance-Tests

#### Playwright (End-to-End-Tests)
- **Browser**: Chromium, Firefox-Smoke, WebKit-Smoke (konfigurierbar in `playwright.config.js`)
- **Konfiguration**: `playwright.config.js`

> **Hinweis:** `package.json` ist die einzige Quelle der Wahrheit für Versionsnummern.
> Diese Dokumentation pflegt bewusst keine konkreten Versionsangaben mehr –
> bei Bedarf bitte direkt `package.json` konsultieren.

### 2. GitHub Actions Workflow

**Datei**: `.github/workflows/test.yml`

Der Workflow führt automatisch Tests aus bei:
- Push auf `main` oder `develop` Branches
- Pull Requests auf `main` oder `develop` Branches

**Jobs**:
1. `unit-and-integration-tests`: Führt Unit-, Integrations- und Performance-Tests aus
2. `e2e-tests`: Führt End-to-End-Tests mit Playwright aus

**Artefakte**:
- Coverage-Reports (in `coverage/`)
- Playwright-Reports (in `playwright-report/`)
- Test-Videos bei Fehlern (in `test-results/`)

### 3. Test-Struktur

```
tests/
├── unit/                       # Unit-Tests
│   ├── ua.utils.test.js       # Tests für Utility-Funktionen
│   └── ua.report_v2.test.js   # Tests für Export-Funktionen
├── integration/                # Integrationstests
│   └── export.test.js         # Tests für PDF/Word-Export
├── e2e/                        # End-to-End-Tests
│   └── werkbank.spec.js       # Benutzer-Workflow-Tests
├── performance/                # Performance-Tests
│   └── performance.test.js    # Datenverarbeitungs-Benchmarks
└── fixtures/                   # Test-Fixtures
    ├── test_accidents.geojson # Beispiel-Unfalldaten
    ├── test_pois.geojson      # Beispiel-POI-Daten
    └── test_references.json   # Beispiel-Bezugsdokumente
```

## Test-Schwerpunkte

### Unit-Tests (39 Tests, alle bestanden)

**ua.utils.test.js**:
- ✅ HTML-Escaping (XSS-Prävention)
- ✅ String-Normalisierung für Städtenamen (z.B. "München" → "muenchen")
- ✅ Query-Parameter-Parsing (qGet, qBool, qNum)
- ✅ URL-Manipulation
- ⏭️ Übersprungen: Browser-spezifische History-API-Tests (werden in E2E getestet)

**ua.report_v2.test.js**:
- ✅ Map-Image-Capture mit Fehlerbehandlung
- ✅ PDF-Generation mit pdfMake
- ✅ Word-Dokument-Generation mit docx.js
- ✅ Fehlerbehandlung bei fehlenden Bibliotheken
- ⏭️ Übersprungen: DOM-abhängige UI-Initialisierung (wird in E2E getestet)

### Integrationstests (6 Tests bestanden, 2 erfordern Browser-Umgebung)

**export.test.js**:
- ✅ PDF-Generierung mit Test-Daten
- ✅ Word-Dokument-Generierung mit Test-Daten
- ✅ Export mit POI-Daten
- ✅ Export mit Bezugsdokumenten
- ✅ Vollständiger Export-Flow mit allen Optionen
- ✅ Fehlerbehandlung bei Map-Capture-Fehlern
- ⚠️ Teilweise: Map-Image-Integration (erfordert Canvas-API)

### End-to-End-Tests (Playwright)

**werkbank.spec.js** - Drei Test-Suites:

**Suite 1: User Workflows** (11 Tests)
- Seiten-Laden und Initialisierung
- Stadt-Auswahl aus Dropdown
- Schweregrad-Filter ändern
- Beteiligungsfilter umschalten
- Involvierungsmodus-Buttons (ODER/UND/Alleinunfall)
- Stunden-Range-Slider anpassen
- Darstellungsmodi umschalten (Cluster/Heatmap)
- Legende öffnen/schließen
- Panel einklappen/ausklappen

**Suite 2: Drawing and Export** (3 Tests)
- Zeichenmodus aktivieren
- Zeichnung löschen
- Export-Modal öffnen

**Suite 3: Export Modal Functionality** (6 Tests)
- Export-Optionen anzeigen
- Export-Optionen umschalten
- Word- und PDF-Export-Buttons
- Export-Textbereich anzeigen
- Kopier-Buttons
- Modal schließen

**Suite 4: Accessibility** (2 Tests)
- ARIA-Attribute auf Modal
- ARIA-Labels auf Export-Buttons

### Performance-Tests (7 Tests, alle bestanden)

**performance.test.js**:
- ✅ Verarbeitung großer Datensätze (5000 Punkte in <1000ms)
- ✅ Effizientes Filtern (10000 Punkte in <500ms)
- ✅ POI-Analyse Performance (500 POIs in <300ms)
- ✅ Map-Marker-Vorbereitung (3000 Marker in <500ms)
- ✅ Report-Text-Generierung (1000 Unfälle + 50 POIs in <200ms)
- ✅ Große POI-Listen im Export (200 POIs in <500ms)
- ✅ Memory-Management bei wiederholtem Filtern

## Test-Fixtures

### test_accidents.geojson
Enthält 3 Beispiel-Unfälle mit verschiedenen:
- Unfallschweregraden (UKATEGORIE: 1, 2, 3)
- Beteiligungsarten (Rad, Fuß, PKW)
- Zeitpunkten (verschiedene Stunden, Wochentage)
- Straßenzuständen (trocken, nass, winterglatt)

### test_pois.geojson
Enthält 3 Beispiel-POIs:
- Grundschule
- Kindergarten
- Kita

### test_references.json
Enthält 3 Beispiel-Bezugsdokumente:
- "Die Ideale Kreuzung" (Region Hannover)
- Empfehlungen für Radverkehrsanlagen (ERA)
- Verkehrssicherheitskonzept Hannover 2025

## Ausführung der Tests

### Lokale Entwicklung

```bash
# Alle Abhängigkeiten installieren
npm install

# Unit-Tests ausführen
npm run test:unit

# Integrationstests ausführen
npm run test:integration

# Performance-Tests ausführen
npm run test:performance

# E2E-Tests ausführen (erfordert Python für lokalen Server)
npm run test:e2e

# E2E-Tests im headed Mode (sichtbarer Browser)
npm run test:e2e:headed

# Alle Tests ausführen
npm run test:all

# Tests im Watch-Modus (automatische Wiederholung bei Änderungen)
npm run test:watch

# Coverage-Report generieren
npm run test:coverage
```

### CI/CD Pipeline

Tests werden automatisch ausgeführt durch GitHub Actions:

1. **Bei Pull Requests**: Alle Tests müssen bestehen, bevor der PR gemerged werden kann
2. **Bei Push auf main/develop**: Tests laufen zur Überwachung der Code-Qualität
3. **Artefakte**: Test-Reports und Coverage werden hochgeladen

## Testabdeckung

**Unit-Tests**:
- ✅ Utility-Funktionen: ~95% Coverage
- ✅ Export-Funktionen: ~80% Coverage (DOM-abhängige Teile in E2E)

**Integrationstests**:
- ✅ PDF-Export: Vollständiger Flow getestet
- ✅ Word-Export: Vollständiger Flow getestet
- ✅ POI-Integration: Abgedeckt
- ✅ Referenzdokumente: Abgedeckt

**E2E-Tests**:
- ✅ Alle Hauptfunktionen der Werkbank V2
- ✅ Filter-Interaktionen
- ✅ Export-Modal
- ✅ Accessibility

**Performance-Tests**:
- ✅ Alle kritischen Performance-Szenarien

## Bekannte Einschränkungen

1. **Browser-API-Tests**: Einige Tests, die echte Browser-APIs benötigen (z.B. History API, Canvas), sind übersprungen und werden stattdessen in E2E-Tests abgedeckt.

2. **Map-Image-Capture**: Vollständige Tests für die Kartenbild-Erstellung erfordern eine echte Browser-Umgebung und sind daher hauptsächlich in E2E-Tests implementiert.

3. **Offline-Funktionalität**: Tests setzen voraus, dass externe CDN-Ressourcen (Leaflet, docx.js, pdfMake) erreichbar sind.

## Best Practices

1. **Isolation**: Jeder Test ist unabhängig und beeinflusst andere Tests nicht
2. **Mocking**: Externe Abhängigkeiten werden gemockt
3. **Fehlerbehandlung**: Tests für Error-Cases sind implementiert
4. **Descriptive Names**: Testnamen beschreiben klar, was getestet wird
5. **Performance Benchmarks**: Klare Leistungserwartungen sind definiert

## Nächste Schritte

### Zukünftige Erweiterungen

1. **Visual Regression Testing**: Screenshot-Vergleiche für UI-Änderungen
2. **Accessibility Testing**: Erweiterte A11y-Tests mit axe-core
3. **Mobile Testing**: Tests für responsive Darstellung
4. **Load Testing**: Tests mit sehr großen Datensätzen (>50.000 Punkte)
5. **Cross-Browser Testing**: Tests in Firefox, Safari, Edge

### Wartung

- Tests sollten bei Feature-Änderungen aktualisiert werden
- Neue Features sollten immer mit Tests abgedeckt werden
- Coverage-Reports sollten regelmäßig überprüft werden
- Performance-Benchmarks sollten überwacht werden

## Dokumentation

- **Haupt-README**: [README.md](../README.md) - Enthält Übersicht über Tests
- **Test-README**: [tests/README.md](README.md) - Detaillierte Testdokumentation
- **Dieses Dokument**: [TESTING.md](TESTING.md) - Implementierungsdetails

## Fazit

Die implementierte Testsuite deckt alle wesentlichen Anforderungen des Testkonzepts ab:

✅ Unit-Tests für spezifische Funktionen
✅ Integrationstests für Export-Funktionen
✅ End-to-End-Tests für Benutzer-Workflows
✅ Performance-Tests für große Datenmengen
✅ Automatisierung durch GitHub Actions
✅ Umfassende Dokumentation

Die Tests stellen sicher, dass:
- Neue Features keine Regressionen verursachen
- Performance-Anforderungen eingehalten werden
- Export-Funktionen korrekt arbeiten
- Die Benutzeroberfläche wie erwartet funktioniert
- Der Code wartbar und erweiterbar bleibt
