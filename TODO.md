# TODO — Empfehlungen jenseits des Bielefeld/slope‑Bugs

Stand: nach dem Refokus auf den ursprünglichen Bug
(Bielefeld + `mapLayer=slope` → leere Legende / leerer Tile‑Index).

Diese Datei sammelt Vorschläge, die im Gespräch zu PR #265 aufkamen,
die aber **nicht** direkt zum Bielefeld‑Bug gehören. Sie sollen separat
priorisiert und in eigenen kleinen PRs umgesetzt werden — nicht in
einen Mehrzweck‑PR gepackt werden, der die eigentliche Stoßrichtung
verwässert (siehe Lehre aus PR #265).

## a) Aktueller Fokus — Bielefeld + slope (in dieser Iteration)

- [x] Generischen API‑Smoke‑Test entfernt
      (`tests/integration/apiSmoke.testcontainers.test.js`)
      — siehe Punkt 1 unten falls jemand ihn doch noch will.
- [ ] Fokussierter Reproduktionstest (Bielefeld + slope) wieder
      aktivieren, sobald `ghcr.io/carstenartur/unfallatlas:latest`
      neu gebaut wurde und die re‑enriched Bielefeld‑Daten enthält.
      Ein erster Anlauf
      (`tests/integration/bielefeldSlope.testcontainers.test.js`)
      lief in CI gegen das alte Image grün‑negativ und wurde
      entfernt; die Slope‑Logik ist durch Unit‑Tests
      (`tests/unit/enrichGeojson.*.test.js`,
      `tests/unit/uaContextLayers.test.js`,
      `tests/unit/ua.context_road_layer.test.js`) abgedeckt.
- [x] Build‑Zeit‑Validator `scripts/check-context-datasets.js`
      + `npm run validate:context-datasets`, in `enrich.yml`,
      `enrich-matrix.yml` und `generate-and-commit.yml` als CI‑Gate
      verdrahtet.
- [x] Pipeline‑Härtung in `scripts/enrich_geojson.js`: schlägt
      hart fehl, wenn ein v3‑Envelope mit 0 Tiles oder ohne `dicts`
      geschrieben würde (Unit‑Test in
      `tests/unit/enrichGeojson.tiles.test.js`).

## Browser-Exportbibliotheken und unabhängige Build-Nachweise

Stand 14. November 2026 zu [#406](https://github.com/carstenartur/Unfallatlas/issues/406).
Die [Policy](vendor/provenance-policy.json) führt die Lücken je ausgelieferter Datei.
Das strikte Release-Gate bleibt bei `complete: false`.

- [ ] Releasebezogene vollständige Lizenz-/Copyrighttexte für [Fontkit 2.0.4](https://github.com/foliojs/fontkit/issues/255), [DFA 1.2.0](https://github.com/foliojs/dfa/issues/7) sowie den JavaScript-Anteil von [Brotli 1.3.3](https://github.com/foliojs/brotli.js/issues/57) mit den jeweiligen Originalpaketen verbinden. Die offenen Versionsrückfragen und der nachträglich in Fontkit aufgenommene MIT-Text sind im Herstellerverlauf dokumentiert.
- [ ] Für die fünf in der Policy genannten Assets zwei unabhängige, vom Projekt anerkannte Builder mit öffentlichen Ed25519-Schlüsseln belegen. Beide müssen tatsächlich bauen und die vom Release-Prüfer verlangten Dateien, Eingaben, Ausgaben und Lizenzbelege signieren. Die npm-SLSA-Belege für DOCX 9.15.3, pdfmake 0.3.14 und Leaflet.heat 1.0.1 nennen einen GitHub-gehosteten Builder und das jeweilige npm-Paket als Gegenstand.
- [ ] Die unabhängige Prüfung der Codezuordnung in DOCX und des transitiven Code- und Datengraphen im PDF-Exporter mit den Herstellerunterlagen abgleichen. Dazu gehören die Brotli-JavaScript-Eigenanteile und der Wörterbuch-Browserwrapper, die einzelnen Quellen von zusammengesetzten Fontkit-Ressourcen und die von PDFKit als Inkscape-svgtopdf bezeichnete Bogenumwandlung. Für Letztere fehlt eine genaue Originalrevision mit zugehörigem Lizenznachweis. Der [Buildvertrag](docs/vendor-build-lock.md) nennt die bereits reproduzierten Module, Grammatiken und Daten. Anschließend die vollständigen Beziehungen in CycloneDX und die strikte Freigabe für die konkreten Ausgabehashes prüfen.

## 1. Generische API‑Smoke‑Tests (`/api/health`, `/api/ai-assessment-available`, `/api/political-context/supported`)

**Status:** ausgeklammert.
**Begründung:** Der ursprüngliche Aufhänger zum Thema „Testcontainers"
war Reproduktion des Slope/Tile‑Bugs in Bielefeld — nicht das
generische Absichern öffentlicher API‑Endpunkte. Die Smoke‑Tests aus
PR #265 haben den eigentlichen Bug nicht berührt und sollten — wenn
gewünscht — in einem eigenen, klar als „API‑Smoke" gekennzeichneten PR
landen. Vor einem solchen PR bitte zuerst klären:

- Welche konkrete Regression soll der Smoke‑Test fangen, die nicht
  bereits durch die bestehenden Unit‑/Integrationstests abgedeckt ist?
- Lohnen sich +60 s CI‑Laufzeit pro Endpunkt, oder reicht ein einziger
  Health‑Probe‑Aufruf am Anfang der bestehenden
  `videoExport.testcontainers.test.js`?

Erst nach „ja" auf eine der beiden Fragen sinnvoll.

## 2. `docker-compose.yml` evaluieren / abschaffen

**Anregung des Maintainers:** „Aus meiner Sicht brauche ich docker
compose nicht. Alles könnte in ein docker image."

**Status:** offen, eigener PR.
**Vorschlag für die Umsetzung:**

- Prüfen, was `docker-compose.yml` heute zusätzlich zum reinen
  `Dockerfile` startet (ggf. nur `analysis-service/`?). Wenn der
  Mehrwert ausschließlich Convenience ist (`docker compose up` statt
  `docker run`), kann die Datei ersatzlos entfernt werden.
- Das `npm run start:docker`‑Skript dann entweder löschen oder auf
  `docker run -p 8000:8000 unfallatlas` umstellen.
- README/`TESTING.md` nach Erwähnungen von `docker compose` durchsuchen
  und konsolidieren.
- Falls der Analysis‑Service (Spring Boot) zwingend separat laufen
  muss, das in der README dokumentieren statt es in compose zu
  verstecken.

**Wichtig:** Diese Aufräumarbeit ist **unabhängig** vom Bielefeld‑Bug
und sollte einen eigenen, kleinen PR bekommen.

## 3. Frontend‑Resilienz für leere/kaputte Tile‑Indizes

Selbst mit dem neuen Build‑Gate kann ein Browser auf einem alten
Deployment landen. Optionen:

- In `js/ua.context_layers.js` `load()` einen sichtbaren UI‑Hinweis
  zeigen, wenn der `tileIndexUrl`‑Fetch 404/500 oder leeres `tiles`
  liefert (z.B. „Kontextdaten konnten nicht geladen werden — bitte
  Seite neu laden").
- Heute fällt der Loader still auf „kein Layer" zurück, was zu der
  gleichen leeren Legende führt, die wir gerade gefixt haben.

Eigener kleiner PR, sobald jemand Zeit hat.

## 4. Erweiterte Bielefeld‑Asserts im Reproduktionstest

Wenn der jetzige Test in CI stabil läuft, kann man ihn ausbauen um:

- Snapshot der gerenderten Legenden‑Farben (catch CSS‑Regressions).
- Click auf einen Slope‑Polyline‑Pfad → Popup mit `slope_class`.
- Wechsel `mapLayer=slope` ↔ `mapLayer=traffic` ohne Reload.

Aktuell bewusst nicht gemacht, um den Test fokussiert auf den Bug zu
halten.
