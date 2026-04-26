# Agent Work Packages

Kurzbeschreibung der Module und Verzeichnisse, damit KI-Agenten (Copilot, Claude u. a.)
gezielt auf einzelne Bereiche scopen können und unnötigen Kontext vermeiden.

---

## UI / Browser-App

**Beschreibung:** Interaktive Karten-Werkbank im Browser (kein Build-Schritt, pure ES-Module per CDN).

- **Pfade:**
  - `js/ua.app_v2.js` – Haupt-Einstiegspunkt (Werkbank V2)
  - `js/ua.core.js` – globales Namensraumobjekt `UA`, Hilfsfunktionen (`normKey`, URL-Utils)
  - `js/ua.ui.js` – DOM-Initialisierung, Event-Handler, Panel-Logik
  - `js/ua.map_v2.js` – Leaflet-Kartenlogik, Marker, Heatmap, Cluster
  - `js/ua.data_v2.js` – Datenladen (Unfallatlas-Rohdaten), Caching
  - `js/ua.filters.js` – Filter-State-Management
  - `js/ua.state.js` – URL-State (Deep-Links, History-API)
  - `js/ua.political-context.js` – Anbindung politischer Kontext-API
  - `js/ua.priorities.js` – Anbindung Prioritäten-API
  - `js/ua.tour.js` – Geführte Touren
  - `js/ua.video-export.js` – Frontend-Auslöser für Video-Export
  - `js/ua.app.js` – Altanwendung V1 (deprecated, hat Deprecation-Banner)
  - `js/ua.map.js` / `js/ua.data.js` – V1-Karte / -Daten (deprecated)
  - `css/` – alle Stylesheets
- **Einstiegspunkte:**
  - `werkbank_v2.html` – Hauptseite (Werkbank V2, empfohlen)
  - `werkbank.html` – V1 (deprecated, zeigt Weiterleitungs-Banner)
  - `index.html`, `combi.html`, `showcase.html` – sonstige Ansichten
- **Tests:** `tests/e2e/werkbank.spec.js`, `tests/e2e/smoke.spec.js`, `tests/e2e/accessibility.spec.js`

---

## Export (PDF / Word / CSV / GeoJSON / KML)

**Beschreibung:** Exportlogik läuft vollständig im Browser; PDF via pdfMake, Word via docx, CSV/GeoJSON/KML als Datei-Download.

- **Pfade:**
  - `js/ua.export_v2.js` – Export-Modal, Datenaufbereitung, Download-Trigger
  - `js/ua.report_v2.js` – PDF- und Word-Dokument-Generierung
  - `js/ua.accident_views.js` – Strategie-Registry für die Einzelunfall-Tabelle (`bySeverity`, `byInvolvement`, `flat`)
  - `js/ua.export.js` – V1-Export (deprecated)
- **Externe Libs (CDN / node_modules):**
  - `pdfmake@0.3.7`
  - `docx@9.6.1`
  - `file-saver@2.0.5`
- **Tests:**
  - `tests/integration/export.test.js`
  - `tests/unit/ua.report_v2.test.js`
  - `tests/unit/ua.export_v2.accidentDetailTable.test.js`
  - `tests/unit/ua.accident_views.test.js`
  - E2E-Export-Modal: `tests/e2e/werkbank.spec.js` (Suite „Drawing and Export")

---

## Node-Server

**Beschreibung:** Express 5-Server – liefert API-Endpunkte für Städte, politischen Kontext, Prioritäten und KI-Bewertung. Kein Datenbankzugang; nutzt lokale JSON-Kataloge und externe APIs.

- **Pfade:**
  - `server/index.js` – Haupt-Einstiegspunkt, Route-Registrierung
  - `server/cities/` – Städtekatalog (`cityCatalogData.json`, `cityRegistry.js`, `supportLevels.js`)
  - `server/political-context/` – Portal-Adapter-Architektur (Hannover SIM, SessionNet-Generic, Allris)
  - `server/priorities/` – Decision-Card-Normalisierung, Top-N-Endpunkte
  - `server/ai/` – Optionaler KI-Bewertungs-Service (Gemini)
  - `server/lib/` – Shared Utilities (`correlationId.js`, `capabilities.js`, `errors.js`)
  - `server/location-brief/` – Standort-Kurzberichte
  - `server/video-export.js` – Video-Export-Job
  - `server/analysis-service/` – Client für Spring-Boot-Analysis-Service
- **Einstiegspunkte:** `npm run start` → `node server/index.js`
- **Tests:** `tests/integration/` (teilweise), Unit-Tests in `tests/unit/` für Utility-Funktionen

---

## Spring-Boot Analysis-Service

**Beschreibung:** Optionaler Java-Batch-Service für die Stadtpriorisierung. Benötigt eine Datenbank (Flyway-Migrationen). Kann via Docker gestartet werden.

- **Pfade:**
  - `analysis-service/src/` – Java-Quellcode
  - `analysis-service/src/main/java/de/unfallatlas/analysis/` – Haupt-Package
  - `analysis-service/src/main/resources/db/migration/` – Flyway SQL-Migrationen
  - `analysis-service/pom.xml` – Maven-Build
  - `analysis-service/Dockerfile`
  - `analysis-service/README.md`
- **Einstiegspunkte:** `docker compose up --build` oder direkt via Maven

---

## Skripte / Tooling

**Beschreibung:** Hilfsskripte für Daten-Download, POI-Abruf und Diagnose.

- **Pfade:**
  - `scripts/check-city-rollout.js` – Diagnose-Skript für Städtekatalog-Rollout (read-only, `--json`-Option)
  - `scripts/smoke.sh` – Einfacher Shell-Smoke-Test
  - `fetch_poi_osm.sh` – POI-Daten von OpenStreetMap herunterladen
  - `convertAmt2gmaps.sh` / `convertAmt2gmaps.ps1` – Datenkonvertierung
  - `geojson_to_kml_icons.sh` – GeoJSON → KML mit Icons

---

## Tests

**Beschreibung:** Vollständige Test-Suite mit Unit, Integration, Performance und E2E.

- **Pfade:**
  - `tests/unit/` – Jest-Unit-Tests (`ua.utils.test.js`, `ua.report_v2.test.js`, …)
  - `tests/integration/` – Jest-Integrationstests (`export.test.js`, …)
  - `tests/performance/` – Performance-Benchmarks (`performance.test.js`)
  - `tests/e2e/` – Playwright-E2E (`werkbank.spec.js`, `smoke.spec.js`, `accessibility.spec.js`, `screenshots.spec.js`, `demo.spec.js`)
  - `tests/fixtures/` – Test-Fixtures (`test_accidents.geojson`, `test_pois.geojson`, `test_references.json`)
  - `tests/setup.js` – globale Jest-Setup-Datei
  - `playwright.config.js` – Playwright-Konfiguration (Projekte: chromium, demo, firefox-smoke, webkit-smoke)
- **Befehle:**
  - `npm run test:unit` · `npm run test:integration` · `npm run test:performance` · `npm run test:e2e`

---

## Doku

**Beschreibung:** Projektdokumentation in Markdown.

- **Pfade:**
  - `README.md` – Haupt-README (Funktionen, Schnellstart, Architektur-Übersicht)
  - `TESTING.md` – Test-Konzept und implementierte Komponenten
  - `WERKBANK_V2.md` – Feature-Doku Werkbank V2
  - `ARCHITECTURE.md` – Architektur-Übersicht
  - `docs/qa-matrix.md` – QA-Status-Matrix (Browser, Export, A11y, …)
  - `docs/agent-work-packages.md` – diese Datei
  - `docs/CITY_CATALOG.md` – Städtekatalog und Rollout-Pfad
  - `docs/DOKUMENTATION.md` – Allgemeine Projektdoku
  - `docs/architecture.md` – Detaillierte Architektur
  - `docs/server-features.md` – Server-Feature-Beschreibung
  - `docs/RELEASING.md` – Release-Prozess
  - `docs/release-checklist.md` – Release-Checkliste
  - `docs/screenshots/` – Automatisch generierte Dokumentations-Screenshots

---

## CI / GitHub Actions

- **Pfade:**
  - `.github/workflows/test.yml` – Unit/Integration/Performance/E2E (Chromium) + Firefox/WebKit-Smoke-Jobs
  - `.github/workflows/generate-screenshots.yml` – Screenshots bei Änderungen an Hauptdateien
  - `.github/workflows/visual-check.yml` – PR-Screenshots als Artefakt
  - `.github/workflows/pages-smoke.yml` – Täglicher Smoke-Test gegen GitHub Pages
  - `.github/workflows/deploy-release.yml` – Release-Deployment
  - `.github/workflows/docker-publish.yml` – Docker-Image-Publish
  - `.github/dependabot.yml` – Automatische Dependency-Updates (npm, GitHub Actions, Maven, Docker)
