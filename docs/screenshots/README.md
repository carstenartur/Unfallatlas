# Screenshots — Aufnahme-Hinweise

Dieses Verzeichnis enthält die in `README.md` und `docs/DOKUMENTATION.md`
referenzierten PNG-Screenshots der Unfallwerkbank V2.

Der maschinenlesbare Vertrag liegt in [`../media-manifest.json`](../media-manifest.json).
`npm run validate:media` prüft Soll-Abmessungen, das 1,5-MiB-Einzelbudget für
statische Kartenmedien, das 30-MiB-Gesamtbudget und alle lokalen
Markdown-Referenzen. Das Gesamtbudget umfasst neben den realen Karten auch das
kanonische Demo-GIF und die gerenderte PDF-Vorschau. Neue Vollbild-Kandidaten
werden mit 1280×640 erzeugt; Workflows veröffentlichen sie zusammen mit ihrem
Evidence-Sidecar, Evidence-Gesamtbericht, Live-Kartografie-Bericht und dem
exakten Buildmanifest ausschließlich als Review-Artefakt. `npm run
validate:screenshot-evidence` verlangt dabei eine 1:1-Zuordnung und verifiziert
Bild-SHA-256, Buildmanifest-SHA-256 sowie Build-, Anwendungs- und
Datenfingerprint erneut vor dem Upload. Der zusätzliche
Live-Kartografie-Validator verlangt für jedes kartenhaltige Bild mindestens
eine zum Szenario passende, erfolgreiche HTTPS-Rasterantwort eines explizit
erlaubten Grundkartenanbieters.

Für neu erzeugte, noch nicht übernommene Bilder rufen die
Dokumentationsmedien-Workflows `validate:screenshot-evidence`,
`validate-live-cartography-evidence` und danach `validate:media --
--candidate-screenshots` auf. Dieser explizite Kandidatenmodus prüft die in
diesem Lauf erzeugten Screenshot- und Dokumentvorschau-Dateien vollständig auf
Maße, Format, Budget, Referenzen, aktuelle Lifecycle-Evidence und reale
Kartografie. Nicht neu erzeugte Medien – insbesondere die separat regenerierte
Demo-Animation – werden im Report ausdrücklich als `deferred` ausgewiesen und
erst im normalen `validate:media`-Lauf zusammen mit der dauerhaft archivierten
Evidence streng gebunden. Format-, Pfad-, Referenz- und Budgetregeln des
Manifests gelten auch für zurückgestellte Einträge unverändert.

Für die separat prüfbare Tooling-Grenze steht zusätzlich `npm run
validate:media:policy` zur Verfügung. Dieser Modus validiert ausschließlich
Manifeststruktur, Pfadsicherheit, Referenzen, Budgets und Ausnahmeregeln und
kennzeichnet seinen Report ausdrücklich mit `mediaValidated: false` und
`evidenceValidated: false`. Er ersetzt niemals die strikte Prüfung: Sobald die
reviewten Bilddateien und der Provenienz-Ledger gemeinsam übernommen werden,
muss der CI-Workflow wieder `npm run validate:media` ausführen.

Die am 19. Juli 2026 übernommene, semantische Unfall- und Render-Evidence sowie
ihre damaligen Vorher-/Nachher-Größen sind im
[`Medien-QA-Bericht`](../media-qa-2026-07-19.md) dokumentiert. Diese erste
Promotion belegte jedoch noch keine realen Grundkartenantworten. Die
Live-Kartografie-Evidence und der dazugehörige neue Bildsatz werden deshalb in
einem eigenen Review-Schritt ersetzt und dauerhaft unter
[`qa/screenshot-evidence`](../../qa/screenshot-evidence/) gebunden.

## Konvention

Bedienfeldorientierte Screenshots bleiben Vollbilder der Werkbank: Das relevante
Steuerelement muss zusammen mit Karte und sichtbarem Unfall-Layer erscheinen.
Reine `#panel`-Ausschnitte sind kein ausreichender Funktionsnachweis, weil sie
die räumliche Wirkung der gezeigten Auswahl oder Filterung ausblenden.

| Nummer | Datei | Beschreibung |
|---|---|---|
| 01 | `01-startansicht.png` | Startansicht der Werkbank V2 |
| 02 | `02-stadtauswahl.png` | Stadtauswahl mit sichtbarer Karte und Unfalldaten |
| 03 | `03-filter.png` | Filter-Panel mit sichtbarer Ergebnis-Karte |
| 04 | `04-cluster-ansicht.png` | Cluster-Ansicht |
| 05 | `05-heatmap-ansicht.png` | Heatmap-Ansicht |
| 06 | `06-legende.png` | Legende |
| 07 | `07-export-modal.png` | Export-Modal |
| 08 | `08-stundenfilter.png` | Stundenfilter mit sichtbarer räumlicher Wirkung |
| 09 | `09-bereich-markieren.png` | Bereich markieren |
| 10 | `10-auto-fahrrad-und.png` | Auto+Fahrrad UND-Modus |
| 11 | `11-fahrrad-alleinunfaelle.png` | Fahrrad-Alleinunfälle |
| 12 | `12-poi-schulen-kitas.png` | POI: Schulen + Kitas |
| 13 | `13-bonn-hbf-radunfaelle.png` | Bonn Hbf Rad+Auto-Unfälle |
| 14 | `14-export-filterkontext.png` | Export mit Filterkontext |
| 15 | `15-export-pdf-rendered.png` | Gerenderter PDF-Export |
| 16 | `16-antrag-inhalt.png` | Antrag-Inhalt |
| 21 | `21-mapmode-standard.png` | Kartenmodus `standard` mit real geladener OSM-Grundkarte |
| 22 | `22-mapmode-orthophoto.png` | Kartenmodus `orthophoto` mit realer WMS-/Rasterantwort |
| 23 | `23-mapmode-hybrid.png` | Kartenmodus `hybrid` mit realem Orthofoto und Label-Overlay |
| 24 | `24-mapmode-analysis.png` | Kartenmodus `analysis` mit Unfall-Heatmap auf realem Orthofoto |
| 25 | `25-mapmode-orthophoto-fallback.png` | Erzwungener Orthofoto-Ausfall mit real geladener Standardkarte als Fallback |

## Ausgesetzte Slope-Diagnose (QA #400)

Die früheren Dateien `slope-berlin*.png` und `slope-bielefeld*.png` waren
kein belastbarer Nachweis: Die Szenarien warteten ausschließlich auf die
Unfall-Layer, nicht auf Context-Geometrie. Die aktuellen Stadtdateien stellen
für diese Viewports keine nachweisbare Slope-Geometrie bereit; entsprechend
zeigten alle vier Bilder den Empty State. Das Berliner Normal-/Debug-Paar war
zusätzlich byte-identisch.

Die Bilder und ihre Generator-Szenarien sind daher entfernt. Eine spätere
Reaktivierung muss fail-closed mindestens aktive Controls, eine sichtbare
Legende, tatsächlich gezeichnete Overlay-Pixel und in der Debug-Variante
numerische Slope-Tooltips nachweisen. Tracking:
[QA #400](https://github.com/carstenartur/Unfallatlas/issues/400).

Alle kartenhaltigen Screenshots werden erst nach einem öffentlichen
Lifecycle-Vertrag und einem fail-closed Leaflet-Tile-Stabilitäts-Check erstellt
(`waitForMapTiles`: Helper-Erfolg, keine ladenden Tiles, mindestens ein
decodiertes Tile), plus defensivem `document.fonts.ready`. Der
Lifecycle-Snapshot wird unmittelbar vor und nach dem Pixel-Capture verglichen;
eine dazwischenliegende Daten- oder Renderrevision verwirft den Kandidaten.

## Getrennte Kartenstrategien für Test und Dokumentation

Die normale E2E- und PDF-Regression bleibt vollständig hermetisch: OSM-,
Orthofoto- und Hybrid-Label-Anfragen werden dort auf die versionierten
SVG-Fixtures unter `tests/e2e/fixtures/map-tiles/` geroutet. Diese Tests prüfen
reproduzierbar UI-Zustand, Layer-Lifecycle, Unfallzahlen und Fehlerpfade. Ihre
Bilder sind **keine** veröffentlichbaren Dokumentationsmedien.

Reviewbare und kanonische Dokumentations-Screenshots entstehen ausschließlich
über `node scripts/run-live-documentation-screenshots.cjs`. Dieser Runner
fängt sämtliche externen HTTP-/HTTPS-Anfragen ab, erlaubt nur exakte
HTTPS-Tile-/WMS-Pfade aus dem Karten-Layer-Register und verlangt je Szenario
erfolgreiche 2xx-Antworten mit PNG-, JPEG- oder WebP-MIME-Typ. Nominatim- und
Overpass-Antworten bleiben deterministisch; unbekannte externe Anfragen werden
abgebrochen und als Fehler ausgegeben. Screenshot `25` erzwingt den
Orthofoto-Ausfall, akzeptiert den Kandidaten aber erst nach einer erfolgreichen
realen Standardkartenantwort.

## Review-Kandidaten für Kontextdaten-Screenshots (QA #408)

Mit der Einführung der Kontextdaten (PR #260, „Kontext (neu)") sind
drei zusätzliche Screenshots vorgesehen. Sie sind noch nicht Bestandteil
dieses Verzeichnisses und werden daher weder im Manifest noch in der
Nutzerdoku als vorhandene Bilder ausgegeben. Das Regen-Skript erzeugt
ausschließlich unveröffentlichte Review-Kandidaten unter `.build/`:

| Nummer | Datei | Beschreibung |
|---|---|---|
| 17 | `17-kontext-filter.png` | Filter-Panel mit aufgeklappter Sektion **Kontext (neu)** (Hangneigung, Verkehrsklasse-DTV-Proxy, „nur auf gematchten Straßen") |
| 18 | `18-popup-kontextdaten.png` | Marker-Popup mit Standard-Unfalldetails plus zusätzlichem Block **Kontextdaten** (Topographie, Straßenkontext, Verkehrsexposition mit „proxy"-Badge) |
| 19 | `19-kontext-traffic-proxy.png` | Karte mit aktiven Verkehrsklasse-DTV-Proxy-Filterchips (Bestätigung, dass die Verkehrsexposition projekteigene OSM-`highway`-Schätzung ist) |

Die Kandidaten sollen die explizite **Proxy/Schätzung**-Kennzeichnung
sichtbar enthalten — der Verkehrsklassen-Wert ist ein
*projekteigener OSM-`highway`-Proxy*, **keine gemessene
Verkehrsdichte**.

### Aufnahme-Anleitung — `npm run regen:context-assets`

Das Skript [`scripts/regen-context-assets.js`](../../scripts/regen-context-assets.js)
startet **denselben** `unfallatlas`-Container, gegen den auch der
[Testcontainers-Integrationstest](../../tests/integration/videoExport.testcontainers.test.js)
läuft (Image-Quelle: `UNFALLATLAS_IMAGE` env oder lokaler `docker build`).
Test und Kandidatengenerierung teilen sich damit *eine* URL und *eine* Quelle:

```bash
# einmalig — das im docker-publish.yml gebaute Image bevorzugen, sonst lokal bauen
export UNFALLATLAS_IMAGE=ghcr.io/carstenartur/unfallatlas:latest

npm run regen:context-assets
```

Ein erfolgreicher Lauf erzeugt einen neuen, zeitgestempelten Ordner
`.build/doc-media/context/run-<Zeitstempel>/` mit:

- `demo-context.gif` (über `POST /api/export-video` mit
  `ctxSlope=steep,very_steep&ctxTraffic=high,very_high&ctxOnlyMatched=1`),
- den drei oben gelisteten PNG-Namen unter `screenshots/`, jeweils exakt
  1280×640,
- `candidate-report.json` mit Lifecycle-Snapshot, aktivem Filterzustand,
  gewählter Marker-ID, SHA-256-Werten, Maßen und Budgets.

Der Lauf bricht ab und veröffentlicht keinen neuen Kandidatenordner, wenn
Unfalldaten oder Render-Layer nicht semantisch bereit sind, die Kontextsektion
oder angeforderten Chips fehlen, kein geclusterter Unfallmarker mit
Kontextdaten-Popup geöffnet werden kann, Browserfehler auftreten oder ein
Maß-/Dateigrößenbudget verletzt ist. Eine bloße Warnung oder ein ausgelassenes
Bild gilt nicht als Erfolg.

Voraussetzungen:

- Docker läuft (`docker version` zeigt einen Server),
- `npm ci` wurde ausgeführt (Playwright wird von `@playwright/test`
  bereitgestellt, ist bereits Dev-Dependency).

Datei-Größen-Budget (im Skript geprüft, sonst Exit-Code ≠ 0):
GIF ≤ 10 MiB, PNG ≤ 600 KiB.

Die Übernahme nach `docs/` ist absichtlich **kein** Teil des Skripts. Sie
erfordert eine fachliche Bildprüfung sowie eine gemeinsame Änderung an
`docs/media-manifest.json`, den tatsächlichen Dateien und allen
Markdown-Referenzen. Danach muss `npm run validate:media` erfolgreich sein.

Analog regeneriert `npm run regen:demo` das in der README eingebettete
`docs/demo.gif` über denselben Container-Helper
([`scripts/regen-readme-demo.js`](../../scripts/regen-readme-demo.js)).
Der Helper kürzt ausschließlich die Frame-Zeiten auf höchstens 60 Sekunden;
alle Frames und Bilddaten bleiben erhalten. Der Validator erzwingt zusätzlich
das explizite 9-MiB-Animationsbudget.
