# QA-Matrix der Unfallwerkbank

Diese Matrix dokumentiert, welche Qualitätsdimensionen automatisiert
abgesichert sind. Sie ist als kompakter Einstieg gedacht — die
detaillierte Test×Browser-Matrix steht in [`qa-matrix.md`](./qa-matrix.md).

Legende: ✅ automatisiert · ⚠️ teilweise · ❌ offen / nur manuell

| Dimension | Status | Test/Quelle |
|---|---|---|
| **Ladezustand** – Stadt-Dropdown füllt sich, keine Dauer-Platzhalter („Quelle: -", „Build: -", „Stadt Lade…") | ✅ | `tests/e2e/qa-hardening.spec.js` → „QA-Härtung – Ladezustand" |
| **Stadtwahl** – Dropdown bedienbar, Wechsel löst Reload mit `?city=` aus | ✅ | `tests/e2e/smoke.spec.js` „Stadt-Dropdown ist sichtbar …" + `tests/e2e/werkbank.spec.js` |
| **Filter** – Schweregrad, Beteiligung, Uhrzeit, Wochentag, Fahrbahnzustand reagieren | ✅ | `tests/e2e/qa-hardening.spec.js` → „Filter sind bedienbar" |
| **Bereich markieren** – Rechteck-Tool aktiviert sich, Markierung löschen funktioniert | ⚠️ | manuell + `tests/e2e/werkbank.spec.js` (Draw-Toolbar) |
| **Analyse / Report** – Analyse/Export-Modal öffnet, Report wird gerendert | ✅ | `tests/e2e/qa-hardening.spec.js` + `tests/integration/export.qaHardening.test.js` |
| **Word/PDF-Export** – DOCX/PDF werden erzeugt, sind nicht leer, keine UI-Footer-Platzhalter im Antrag, keine rohen Debug-Tokens (`[Rad]`, `Schweregrad: all`, …), keine `.undefined`-Mediendateien, eindeutige Bild-IDs, Alt-Texte vorhanden | ✅ | `tests/integration/export.qaHardening.test.js`, `tests/unit/ua.report_v2.docxStructure.test.js`, `tests/integration/export.test.js` |
| **Politische Recherche** – Dialog öffnet, zeigt Mehrwert-Erklärung, hat Lade-/Leer-/Fehler-Slot, Ergebnis-Übernahme bestätigt | ✅ (Öffnen + Slots), ⚠️ (Übernahme-Bestätigung) | `tests/e2e/qa-hardening.spec.js` → „Politische Recherche" |
| **Location Action Brief Golden Cases** – reale Bonn-/Hannover-Daten, Muster/Evidenz/Maßnahmen, Negativfälle, Persistenz und Stadt-Ranking | ✅ Vorlauf, ✅ Testcontainers-Gate | `npm run qa:location-brief-golden`, `npm run test:location-brief-golden:tc`, [`location-brief-golden-qa.md`](location-brief-golden-qa.md) |
| **Tour** – „Tour starten" öffnet Banner mit Vor/Zurück/Stop | ✅ | `tests/e2e/qa-hardening.spec.js` → „Geführte Tour" |
| **Mobile Ansicht** – 390 px Viewport rendert ohne JS-Fehler, Filter erreichbar | ✅ | `tests/e2e/qa-hardening.spec.js` → „Mobile Smoke" |
| **Fehlerzustände** – Stadt-Dropdown markiert Lade-Fehler, `main()`-Fehler zeigt verständliche Stat-Meldung statt rohe Exception | ✅ (UI-Pfad), ⚠️ (CDN-Ausfall der Map-Libs) | `tests/e2e/qa-hardening.spec.js` „Stadt-Dropdown … oder Fehlerzustand"; `js/ua.app_v2.js` `main().catch` |
| **Cross-Browser Smoke** – Chromium / Firefox / WebKit | ✅ Smoke | `tests/e2e/smoke.spec.js` (`firefox-smoke`, `webkit-smoke`) |
| **Accessibility** – Aria-Labels auf primären Aktionen, role=dialog, aria-modal | ✅ | `tests/e2e/werkbank.spec.js` „Accessibility" |

## Lokale Ausführung

```bash
# Unit + Integration (Jest)
./node_modules/.bin/jest --testPathPatterns="tests/(unit|integration)"

# E2E (Playwright, Chromium)
./node_modules/.bin/playwright test --project=chromium

# Nur die QA-Härtungs-Suite
./node_modules/.bin/playwright test tests/e2e/qa-hardening.spec.js --project=chromium

# Location-Brief Golden Cases: schnell / vollständiger Docker-Pfad
npm run qa:location-brief-golden
npm run test:location-brief-golden:tc
```

## Erweiterungs-Ideen

- **CDN-Ausfall**: Leaflet/MarkerCluster/Heat über `tests/e2e/helpers.js`
  blockieren und prüfen, dass eine verständliche Fehlermeldung
  erscheint.
- **PDF-Inhaltsprüfung**: das aktuelle Regressionsskript prüft das DOCX
  strukturell; eine analoge `pdfjs-dist`-basierte Prüfung des PDF-Texts
  würde dieselben Hygiene-Regeln auch für den PDF-Pfad verbindlich
  machen.
- **Politische Recherche Übernahme**: Mock des `/api/political-context`-
  Endpunkts in einem Playwright-Test, um den Übernahme-Pfad inkl.
  Bestätigung zu validieren.
