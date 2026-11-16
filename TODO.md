# TODO — Empfehlungen jenseits des Bielefeld/slope‑Bugs

Stand: nach dem Refokus auf den ursprünglichen Bug
(Bielefeld + `mapLayer=slope` → leere Legende / leerer Tile‑Index).

Diese Datei sammelt Vorschläge, die im Gespräch zu PR #265 aufkamen,
die aber **nicht** direkt zum Bielefeld‑Bug gehören. Sie sollen separat
priorisiert und in eigenen kleinen PRs umgesetzt werden — nicht in
einen Mehrzweck‑PR gepackt werden, der die eigentliche Stoßrichtung
verwässert (siehe Lehre aus PR #265).

<a id="ris-ortsbelege-offen"></a>

## RIS-Ortszuordnung – externe Belege und fachliche Abnahme (Stand 16.11.2026)

Die [festgeschriebenen R1–R7-Kontrollen](docs/qa/2026-11-14-ris-stichproben.md) sind **keine** abgeschlossene Nullstichprobe; die [140 Ausschluss-IDs](docs/qa/2026-11-14-ris-stichproben-ids.json) bleiben unverändert. Die [Bonner Lesebilanz](docs/qa/2026-11-15-bonn-lesestapel.md) führt 98 individuell gesichtete Vorgänge, aber auch Teilprüfungen und zehn ungelesene Positionen 91–100. Die Dokumentation eines Ortskandidaten erlaubt **weder** eine präzisere Geometrie als die Quelle **noch** die Behauptung, eine angekündigte Maßnahme sei ausgeführt worden. Folgende fehlende Primärbelege bzw. externe Fachabnahmen bleiben ausdrücklich **offen**, bis die jeweils genannten Kriterien erfüllt sind. Die hier verlinkten Originalpfade sind Quellenverweise, keine Aufforderung zum erneuten Abruf; vorhandene Quellcaches und Sperr-/Tagesbudgets haben Vorrang. Keine Kontaktaufnahme mit externen Stellen ohne eigenen Auftrag.

- [ ] **Schulhof GS Groß-Buchholzer Kirchweg (R7/3):** Eine datierte amtliche Lageanlage zur tatsächlich 2011/12 zur Nutzung freigegebenen Schulhoffläche, einschließlich Zugängen und Gültigkeitszeitraum, belegen und mit dem [Beschlussprotokoll vom 12.01.2012](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/TO/20120112_STBR04_P) sowie [15-2138/2011](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2138-2011) abgleichen. **Abnahme:** begrenzte, datierte Fläche aus amtlicher Anlage oder gleichwertig nachprüfbarem Plan; keine bloße Schulanschrift, keine heutige Gebäudekontur als historische Hofgrenze; Lizenz und Quellenversion erfasst.
- [ ] **Südliche Lister Meile (R7/10):** Den exakten Experimentierabschnitt aus Antrag, Antwort und zugehöriger amtlicher Karte/Anlage identifizieren. Quellen: [15-0897/2025](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0897-2025), [15-0897/2025 F1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0897-2025F1). **Abnahme:** Anfang und Ende eindeutig, gültiger Zeitraum 28.04.–31.10.2025 gekennzeichnet, befristeter Versuch von dauerhaftem Beschluss getrennt; weder die ganze Lister Meile noch vermutete Tischstandorte werden übernommen.
- [ ] **Am Bahndamm (R7/12):** Den tatsächlichen Beschluss und die historische Maßnahmenanlage für die Kanaldeckel zwischen Ziegelstraße und Wunstorfer Landstraße prüfen. Quellen: [15-0617/2009](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0617-2009), [15-0617/2009 S1](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0617-2009S1). **Abnahme:** entweder belegte Einzelpunkte mit Datierung oder lediglich der präzise Straßenabschnitt als *Orientierung*; die anders abgegrenzte [15-0208/2009](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0208-2009) nicht vermischen; keine Ausführungsbehauptung ohne Vollzugsbeleg.
- [ ] **Alte Döhrener Straße / Devrientstraße / Nestroyweg (R7/17):** Das in der Vorlage erwähnte historische Foto bzw. einen datierten amtlichen Lageplan sowie gegebenenfalls den eigenständigen Ausführungsnachweis beschaffen und den Punkt des westseitigen Bordsteins am Zebrastreifen verifizieren. Quellen: [15-2180/2015](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2180-2015), [S1-Entscheidung](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2180-2015S1). **Abnahme:** Geometrie westliche Straßenseite und ca. 3-m-Maßnahme räumlich nachgewiesen; bestehende Orientierungsachse wird nicht als exakte Bordsteinkante deklariert; Ankündigung Frühjahr 2016 strikt vom Nachweis der Fertigstellung getrennt.
- [ ] **Hildesheimer Straße 9–15, ungerade (Hannover 0001/2018):** Die maßgebliche **Anlage 1**, Planfassung und amtliche Geltungsbereichsgeometrie gegen die vier vorhandenen Adressregisterpunkte und den tatsächlichen Grundstücksumgriff prüfen. **Abnahme:** amtlich belegte Planversions-/Datumszuordnung, vier Hausnummern eindeutig zugeordnet, historisch gültige und lizenzrechtlich verwendbare Geometrie nachgewiesen; bis dahin **keine** Veröffentlichung als fertiges Planpolygon.
- [ ] **Region Hannover und Bonn, nicht zugängliche Originale/Bildanlagen:** Für jeden offenen Vorgang nur bereits lokal vorhandene Originale/Sammeldokumente oder später rechtmäßig verfügbare, versionsgebundene Quellen auswerten; bei 403/Zugangsprüfung keine alternative Umgehung oder wiederholte Abfrage des gesperrten Pfads. Die [R7-Einzelfälle](docs/qa/2026-11-14-ris-stichproben.md) und [Bonner Einzelvermerke](docs/qa/2026-11-15-bonn-lesestapel-001.json) benennen den jeweiligen Prüfstand. **Abnahme je Vorgang:** Paper-/Vorgangs-ID und Dokument-URI, Versionskennung und eigener Text-Hash, tatsächlich geprüfte Anlagen/Seiten, Maßnahme und zeitliche Gültigkeit, Quellenlizenz sowie nachgewiesene Ortsgeometrie; Unerreichbares bleibt *offen* und ist niemals ein negativer Befund. Die 2.546 Bonner Ratsatlas-Treffer bleiben Prüfkandidaten, keine Kartierungsfreigaben.

**Interne Fortsetzungsvoraussetzung (kein externer Nachweis):** Vor der festen R8-Ziehung muss außerdem die Erststapel-Bilanz aus `RIS-Lesestapel-001.zip` mit den 51 protokollierten Fällen, Quell-URLs und Status wieder verfügbar oder äquivalent **aus nachprüfbaren bestehenden Protokollen** rekonstruiert sein. Reine Textextraktion ist noch keine semantische Prüfung. Ein fehlender Privatcache rechtfertigt weder kommunale Wiederholungsabrufe noch eine geänderte Stichprobenselektion. Nach verifizierter öffentlicher Generation, leerem GitHub-Backlog und vollständigen Ausschlüssen ist R8 ausschließlich nach dem [festen SHA-256-Verfahren](docs/qa/2026-11-14-ris-stichproben.md) zu ziehen; nur eine wirklich bearbeitete trefferfreie Runde **und** 0 offene Issues/PRs erlauben das Beenden.

<a id="hannover-fahrbahnabnahme"></a>

## Hannover – externe Nachweise für die fachliche Abnahme der Straßenprofile

Die öffentliche Werkbank verwendet das städtische DGM1 und kennzeichnet unsichere sowie durch Bauwerke beeinflusste Profile. Der [Prüfstand mit den untersuchten Primärquellen](docs/qa/hannover-dgm1-qgis-city.md) und [Issue #412](https://github.com/carstenartur/Unfallatlas/issues/412) dokumentieren die technische Umsetzung und die bisherigen Gelände- und Oberflächenvergleiche. Die fachliche Kalibrierung ist offen.

- [ ] Vom [Servicecenter Geoinformation der Landeshauptstadt Hannover](https://www.hannover.de/content/download/641402/file/Produktblatt_DGM.pdf) eine datierte, auf die **veröffentlichte DGM1-XYZ-Ausgabe der Befliegung 2010** bezogene Auskunft bzw. Produktdokumentation beibringen. Höhenstatus, Einheit und gegebenenfalls Transformation zwischen Vermessung und Ausgabe festhalten. Bis zur eindeutigen Zuordnung bleibt der vertikale Bezug im Provider offen.
- [ ] Datierte Bestandsaufmaße der **Fahrbahnoberfläche** für die Kalibrierung beschaffen. Bei kommunalen Wegen beim zuständigen Fachbereich nach Lage und Höhe der Fahrbahnpunkte, Messdatum, Höhenbezug und Messgenauigkeit fragen. Für den B-6-Brückenübergang kann das [Fernstraßen-Bundesamt](https://fba.bund.de/a-z-suche/zeb) mit Abschnitt 560, Netzknoten 3624058 → 3624057, ca. Station 249–256 m, nach Fahrstreifen, Messrichtung und räumlicher Auflösung suchen. Weitere Prüffälle sind der kurze Abschnitt Am Lindener Berge (24855098), der Einschnitt (31308114) und die Brücken.
- [ ] Nach Eingang der Unterlagen mindestens drei Referenzfälle (flach, klare Steigung, Bauwerk) fachlich prüfen. Die Messpunkte bzw. Fahrstreifen an die OSM-Geometrie binden, Datum und Genauigkeit berücksichtigen, Fenster von ±20 und ±50 m soweit durch die vorhandene Geometrie gedeckt vergleichen. Abweichungen, Richtungsbezug und Ausschlüsse dokumentieren und die Ergebnisse an die vorhandenen Regressionstests binden. Die bDOM- und QGIS-Stichproben bleiben als getrennte Vergleichsdaten erhalten.

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
- [ ] Für die fünf in der Policy genannten Assets zwei unabhängige, vom Projekt anerkannte Builder mit öffentlichen Ed25519-Schlüsseln belegen. Beide müssen tatsächlich bauen und die vom Release-Prüfer verlangten Dateien, Eingaben, Ausgaben und Lizenzbelege signieren. Die npm-SLSA-Belege für [DOCX 9.15.4](https://registry.npmjs.org/-/npm/v1/attestations/docx@9.15.4), pdfmake 0.3.14 und Leaflet.heat 1.0.1 nennen einen GitHub-gehosteten Builder und das jeweilige npm-Paket als Gegenstand.
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
