# QA-Matrix – Unfallatlas / Werkbank V2

Diese Matrix zeigt den aktuellen Teststatus für alle relevanten Qualitätsdimensionen.  
Legende: ✅ getestet · ⚠️ teilweise · ❌ offen

---

## Browser × Form-Faktor

| Browser      | Desktop   | Mobile      |
|-------------|-----------|-------------|
| Chromium    | ✅        | ✅ 320/390 px, Keyboard + Touch |
| Firefox     | ⚠️ Smoke  | ❌ offen    |
| WebKit      | ⚠️ Smoke  | ❌ offen    |

> Smoke-Tests via `tests/e2e/smoke.spec.js`, Projekte `firefox-smoke` / `webkit-smoke` in `playwright.config.js`.  
> Responsive Task-Fläche: `tests/e2e/task-surface.spec.js` prüft 320/390 px,
> horizontales Overflow, 44-px-Touchziele, Dialog-Bottom-Sheet und einen
> vollständigen Keyboard-/Touch-Weg bis zum Exportdialog.

---

## Export-Formate

| Format  | Unit/Integration  | E2E (Chromium) | Status    |
|---------|-------------------|----------------|-----------|
| PDF     | ✅                | ✅             | ✅        |
| Word    | ✅                | ✅             | ✅        |
| CSV     | ❌                | ⚠️ Modal geöffnet | ⚠️     |
| GeoJSON | ❌                | ⚠️ Modal geöffnet | ⚠️     |
| KML     | ❌                | ⚠️ Modal geöffnet | ⚠️     |

> Tests: `tests/integration/export.test.js`, `tests/e2e/werkbank.spec.js`

---

## URL-Reproduzierbarkeit (Deep-Links)

| Szenario                            | Status    |
|-------------------------------------|-----------|
| Stadt-Parameter im URL (`?city=…`)  | ⚠️ manuell geprüft |
| Filter-State im URL                 | ⚠️ manuell geprüft |
| Automatisierter Deep-Link-Test      | ❌ offen  |

---

## Offline / CDN-Ausfall

| Szenario                              | Status    |
|---------------------------------------|-----------|
| Gelockte Browser-Libs lokal in `_site/vendor` | ✅ `npm run build:site` |
| Laufzeit-CDN-Zugriff                  | ✅ ausgeschlossen / im E2E blockiert |
| Build-/Datenfingerprints              | ✅ `_site/build-manifest.json` |
| Service-Worker / Offline-Fallback     | ❌ nicht implementiert |

---

## Accessibility (axe-core)

| Seite / Komponente    | Tool        | Schweregradschwelle     | Status    |
|-----------------------|-------------|-------------------------|-----------|
| Hauptseite            | axe-core    | serious/critical        | ✅ `tests/e2e/accessibility.spec.js` |
| Vier Arbeitsdialoge (Export, Recherche, Prioritäten, Recorder) | axe-core | serious/critical | ✅ `tests/e2e/accessibility.spec.js` |
| Fokusfalle / `inert` / Fokus-Rückgabe | Playwright + Jest | Tastaturvertrag | ✅ `task-surface.spec.js`, `ua.modalController.test.js` |
| Mobile-Screen-Reader  | –           | –                       | ❌ offen  |

---

## Performance (Datensatzgrößen)

| Szenario                        | Schwellenwert | Status    |
|---------------------------------|---------------|-----------|
| 5 000 Punkte verarbeiten        | < 1 000 ms    | ✅        |
| 10 000 Punkte filtern           | < 500 ms      | ✅        |
| 500 POIs analysieren            | < 300 ms      | ✅        |
| 3 000 Marker vorbereiten        | < 500 ms      | ✅        |
| Report-Text (1 000 Unfälle)     | < 200 ms      | ✅        |
| Load-Test > 50 000 Punkte       | –             | ❌ offen  |

> Tests: `tests/performance/performance.test.js`

---

## Datenqualität (Fixtures / Edge Cases)

| Szenario                         | Status    |
|----------------------------------|-----------|
| Normalfall-Fixture (3 Unfälle)   | ✅ `tests/fixtures/test_accidents.geojson` |
| POI-Fixture (3 POIs)             | ✅ `tests/fixtures/test_pois.geojson` |
| Referenz-Fixture (3 Dokumente)   | ✅ `tests/fixtures/test_references.json` |
| Leere Datenmenge                 | ⚠️ teilweise (Unit-Tests) |
| Ungültige Koordinaten            | ❌ offen  |
| Sehr große Datenmenge (> 50k)    | ❌ offen  |
| Sonderzeichen in Stadtnamen      | ✅ `tests/unit/ua.utils.test.js` |

---

## Live-Demo (GitHub Pages)

| Szenario                     | Status    |
|------------------------------|-----------|
| Seite lädt (HTTP 200, kein JS-Error) | ✅ `pages-smoke.yml` (täglich) |
| Stadt-Dropdown vorhanden     | ✅ `pages-smoke.yml` |
| Schweregrad-Filter           | ✅ `pages-smoke.yml` |
| Export-Modal öffnet          | ✅ `pages-smoke.yml` |

---

*Stand: manuell gepflegt auf Basis des aktuellen Repository-Stands – bitte bei neuen Testzugängen aktualisieren.*
