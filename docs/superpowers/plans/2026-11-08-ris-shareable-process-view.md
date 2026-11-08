# Umsetzung: Teilbare Ratsvorgänge und Prozessansicht

Spec: `docs/superpowers/specs/2026-11-08-ris-shareable-process-view-design.md`

## Global Constraints

- Gemeinsamer kanonischer URL-Zustand; explizite Links haben Vorrang vor lokalem Zustand.
- Bestehende Unfall-, Straßenebenen-, Karten-, Auswahl- und Exportfunktionen erhalten.
- Eine gemeinsame Detailansicht für Karte, Recherche und direkten Link; keine behaupteten Verfahrensphasen ohne Quellenbeleg.
- Bounded, snapshot-bound catalogue requests; stale responses cannot alter the current view.
- Telefon: schließbar, einklappbar, 44-Pixel-Bedienelemente, keine horizontale Überbreite.
- Bestehende Maven/Site-Buildkette verwenden. Kein zusätzlicher Build oder Daten-Crawl für die UI.

## Task 1 — URL, Szenen und Speicherung

Implementiere den reinen Zustand `UA.RisViewState` in `js/ua.ris_view_state.js` gemäß Spec. Integriere ihn in URL-Whitelist, Hauptserialisierung, MapScene/Codec, Startup-Hydration, lokale Speicherung, Stadtwechsel und Tour-Reset. Ergänze RIS zur CSV-Serialisierung ohne Erweiterung der Straßenlader. Rufe `UA.RisDetails?.refresh(ctx)` nach abgeschlossener Hydration auf. Bearbeite nicht `ua.ris-layer.js`, `ua.political-context.js`, HTML oder Renderer. Sinnvolle Regressionen zuerst: Roundtrip aller Optionen, URL-Vorrang, alte Links, getrennte Straßenlader, Stadtwechsel. Keine eigenen Git-Commits oder Unteragenten; Änderungen im zugewiesenen gemeinsamen Feature-Worktree.

## Task 2 — Gemeinsamer Prozessrenderer

Erstelle `js/ua.ris-record-view.js`, `css/ris-record-view.css` und passende Unit-Tests. Exakte API und Felder stehen in der Spec. Eigenständige Kopfzeile mit Titel, Quelle, Dokumentart, Original/PDF und Berichtübernahme; drei zugängliche Bereiche. Prozesslinie nach Ratsatlas-Inspiration mit Datum/Gremium/Ergebnis/Beleg, klare Datenlücken. Direkte Querverweise und indirekt verbundene Dokumente unterscheidbar, navigierbar; Orte mit vorhandener Geometrie aufrufbar. Seitenweise Navigation mit `eventsPage`, `relationsPage`, `relatedPage`, `locationsPage`; keine kumulative URL-Replay-Schleife. CSS darf den Controllerrahmen `.ris-details`, `.ris-details__toolbar`, `.ris-details__body`, `.ris-details--collapsed` und `.ris-details__status` mitgestalten. Native Controls, Fokus nach Seitenwechsel sinnvoll erhalten; Requests bei `destroy` oder veraltetem Zustand entkräften. Keine Bearbeitung anderer Produktionsdateien, keine Git-Commits, keine Unteragenten.

## Task 3 — Controller, Einstiegspunkte und reale Abnahme

Root implementiert `ua.ris-details.js`, bindet den kanonischen Zustand in `ua.ris-layer.js` ein, ersetzt Popup-Verlauf durch Einstieg in den gemeinsamen Renderer und ergänzt Sucheinstiege. Behebt irreführende Verwandtschaftsbeschriftungen. Integriert Assets samt Versionen, Dokumentation und Ratsatlas-Attribution. Regressionen für Controller-Races und URL-Synchronisierung sowie Browserabnahme mit echten Katalogfixtures, frischem Kontext und Telefon/Tablet. Danach gezielter und vollständiger Testlauf, kanonischer Build, unabhängige Review, PR, regulärer Merge und Prüfung der Bereitstellung.
