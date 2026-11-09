# Ratsatlas-orientierter Kartenarbeitsbereich Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Eine zusammenhängende, mobile und teilbare Recherche für Ratsdokumente aus mehreren Quellenebenen liefern.

**Architecture:** Bestehende Recherche-Seitenleiste, RisDetails und RisRecordView teilen Auswahl und URL-Zustand. Bestehender begrenzter Katalogzugriff bleibt zuständig für Daten und Nachweise; ein kleiner gemeinsamer Quellenhelfer benennt Ebenen und Herausgeber.

**Tech Stack:** Frameworkfreies JavaScript, Leaflet, CSS, Jest und Playwright.

**Spec:** `docs/superpowers/specs/2026-11-09-ris-ratsatlas-workspace-design.md`

## Global Constraints

- Quellenebenen: `city`, `region`, `state`, `federal`, `eu`; keine neuen Datenanbieter.
- Vorhandene URL-Schlüssel, Snapshotprüfung, Speicher-/Seitenlimits und Quellenwahrheit erhalten.
- Renderer bleibt `UA.RisRecordView.create`; Kartenaktion bleibt `UA.RisLayer.showLocation`.
- Mindestens 44px hohe Bedienelemente; keine horizontale Überbreite bei 390px.
- Gemeinsames Verfahren für Bonn und Hannover, keine erfundenen Beziehungen oder Statuswerte.

## Review Focus

- Filterwechsel während einer laufenden Suchseite: alte Ergebnisse dürfen nicht erscheinen.
- Quellenübergreifender Verweis ohne bekannte Zielebene: keine falsche Stadtkennzeichnung.
- Geteilte spätere Suchseite nach Datenwechsel: sichtbarer Fehler und erneute erste Suche.
- Mobile Navigation zur Liste und zurück: Suchtext, Filter und Auswahl bleiben erhalten.
- Nicht verorteter Vorgang: Details und Quellen funktionieren ohne Kartenbewegung.

### Task 1: Gemeinsame Quellenebenen und gefilterter Katalog

**Files:** `js/ua.ris-sources.js`, `js/ua.ris-partitions.js`, `js/ua.ris-catalogue.js`, politische JSON-Schemas und vorhandene Serversuche; gezielte Tests.

**Interfaces:** `UA.RisSources.levels`, `levelOf(record)`, `sourceLabel(record)`, `normalizeLevels(array)`; Suche erhält optional `sourceLevels`.

- [x] Tests für zusätzliche Ebenen, Filter vor Pagination und quellenübergreifende Verweise hinzufügen und fehlschlagen sehen.
- [x] Gemeinsame Quellenmetadaten und Validierung implementieren; Suchfilter in Cursorbindung und bestehende Suchpfade übernehmen.
- [x] Gezielte Daten-/Suchtests ausführen und Änderungen prüfen.

### Task 2: Zusammenhängende Trefferliste, Dokument und URL-Zustand

**Files:** `js/ua.political-context.js`, `js/ua.ris-details.js`, `js/ua.ris_view_state.js`, `js/ua.state.js`, `js/ua.app_v2.js`, `werkbank_v2.html`, `css/ris-record-view.css`; Zustands-/GUI-Tests.

**Interfaces:** `PoliticalContext.refreshPanel(ctx)`, `returnToResults(ctx)` und `selectRecord(ctx,id)` koordinieren vorhandene Oberflächen. `risView` ergänzt `listOpen`, `listCollapsed`, `query`, `sourceLevels`, `searchCursor`, `searchGeneration`.

- [x] Tests für die neue URL-Grenze, nichtmodale Suche und Rückkehr zur Liste hinzufügen.
- [x] Seitenleiste, kompakte Treffer, getrennte Exportauswahl, Suchseiten und Rückkehrnavigation implementieren.
- [x] URL-Wiederherstellung, Abbruch bei Quellen-/Filterwechsel und bestehende Regressionstests ausführen.

### Task 3: Quellenbewusste Prozesslinie und Verbindungen

**Files:** `js/ua.ris-record-view.js`, zugehörige CSS-Regeln und Renderer-Tests.

**Interfaces:** Bestehender Renderer und Datenlader unverändert; Quellenhelfer aus Task 1 optional defensiv nutzen.

- [x] Tests für sichtbare Ebenen, kompakte Ereignisse mit aufklappbaren Belegen und ehrliche Zielkennzeichnung ergänzen.
- [x] Prozesslinie und Beziehungskarten mit klarer Ausgangs-/Zielkennzeichnung gestalten.
- [x] Bestehende Paginierungs-, Fokus- und Async-Regressionen prüfen.

### Task 4: Visuelle Abnahme und Integration

**Files:** Browserregressionen, Projektdokumentation und Screenshots nach vorhandener Medienrichtlinie.

- [x] Desktop- und Mobilabläufe sowie geteilte URLs in Playwright prüfen; Screenshots ansehen und Layoutmängel beheben.
- [x] Relevante Tests und statischen Build ausführen; unabhängigen Review einholen.
- [ ] Änderungen als zusammenhängenden PR veröffentlichen, erforderliche CI prüfen und nach bereits erteiltem Integrationsauftrag zusammenführen.

## Lokale Verifikation

- Vollständiger Jest-Lauf: 390 Suites und 4.921 Tests bestanden; 11 Tests übersprungen.
- Kanonischer statischer Build mit gesperrten Browser-Abhängigkeiten erfolgreich.
- Neun gezielte Chromium-Szenarien bestanden: Desktop, 390px/820px, geteilte Suchseite, Barrierefreiheit, Ortswechsel und Berichtsauswahl.
- Unabhängiger Review abgeschlossen; gefundene Fokus-/Scrollkorrektur beim Seitenwechsel umgesetzt und geprüft.
- GitHub-CI und Integration sind der verbleibende Abschluss.
