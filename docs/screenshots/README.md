# Screenshots — Aufnahme-Hinweise

Dieses Verzeichnis enthält die in `README.md` und `docs/DOKUMENTATION.md`
referenzierten PNG-Screenshots der Unfallwerkbank V2.

Der maschinenlesbare Vertrag liegt in [`../media-manifest.json`](../media-manifest.json).
`npm run validate:media` prüft Soll-Abmessungen, das ausnahmslose
1-MiB-Standardbudget für statische Medien, das 15-MiB-Gesamtbudget und alle
lokalen Markdown-Referenzen. Neue
Vollbild-Kandidaten werden mit 1280×640 erzeugt; Workflows veröffentlichen sie
zusammen mit ihrem Evidence-Sidecar, Evidence-Gesamtbericht und dem exakten
Buildmanifest ausschließlich als Review-Artefakt. `npm run
validate:screenshot-evidence` verlangt dabei eine 1:1-Zuordnung und verifiziert
Bild-SHA-256, Buildmanifest-SHA-256 sowie Build-, Anwendungs- und
Datenfingerprint erneut vor dem Upload.

Für neu erzeugte, noch nicht übernommene Bilder rufen diese Workflows erst
`validate:screenshot-evidence` und danach `validate:media
-- --candidate-screenshots` auf. Dieser explizite Kandidatenmodus überspringt
nur die Bindung an die bereits akzeptierte Evidence; Maße, Formate, Budgets,
Referenzen und die vorgelagerte aktuelle Lifecycle-Evidence bleiben zwingend.
Der normale `validate:media`-Lauf bindet dagegen stets die eingecheckten Bilder
an die dauerhaft archivierte Evidence.

Für die separat prüfbare Tooling-Grenze steht zusätzlich `npm run
validate:media:policy` zur Verfügung. Dieser Modus validiert ausschließlich
Manifeststruktur, Pfadsicherheit, Referenzen, Budgets und Ausnahmeregeln und
kennzeichnet seinen Report ausdrücklich mit `mediaValidated: false` und
`evidenceValidated: false`. Er ersetzt niemals die strikte Prüfung: Sobald die
reviewten Bilddateien und der Provenienz-Ledger gemeinsam übernommen werden,
muss der CI-Workflow wieder `npm run validate:media` ausführen.

Die am 19. Juli 2026 übernommenen, semantisch belegten Kandidaten und ihre
Vorher-/Nachher-Größen sind im
[`Medien-QA-Bericht`](../media-qa-2026-07-19.md) dokumentiert. Statische
Legacy-Ausnahmen sind seit dieser Übernahme nicht mehr zulässig. Die dauerhaft
gebundene Original-Evidence liegt unter
[`qa/screenshot-evidence`](../../qa/screenshot-evidence/).

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
| 21 | `21-mapmode-standard.png` | Kartenmodus `standard` (deterministische Tile-Mocks) |
| 22 | `22-mapmode-orthophoto.png` | Kartenmodus `orthophoto` (deterministische Orthofoto-Tiles) |
| 23 | `23-mapmode-hybrid.png` | Kartenmodus `hybrid` (Orthofoto + Label-Overlay) |
| 24 | `24-mapmode-analysis.png` | Kartenmodus `analysis` (Heatmap/Analyse-Overlay auf Orthofoto) |
| 25 | `25-mapmode-orthophoto-fallback.png` | Orthofoto-Ausfall: erwarteter Fallback auf Standardkarte inkl. Hinweistext |

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



Alle map-haltigen Screenshots werden in den E2E-Tests erst nach einem
öffentlichen Lifecycle-Vertrag und einem fail-closed
Leaflet-Tile-Stabilitäts-Check erstellt (`waitForMapTiles`: Helper-Erfolg,
keine ladenden Tiles, mindestens ein decodiertes Tile), plus defensivem
`document.fonts.ready`. Der Lifecycle-Snapshot wird unmittelbar vor und nach
dem Pixel-Capture verglichen; eine dazwischenliegende Daten- oder
Renderrevision verwirft den Kandidaten.

## Deterministische Grundkarte

Für sämtliche kanonischen Screenshots (`01`–`16` und `21`–`25`) werden OSM-,
Orthofoto- und Hybrid-Label-Anfragen vor dem ersten Seitenaufruf auf die
versionierten SVG-Fixtures unter `tests/e2e/fixtures/map-tiles/` geroutet.
Damit hängen die Review-Artefakte nicht von Live-Tiles, Provider-Verfügbarkeit,
Farbbalance oder Kacheländerungen ab. Screenshot `25` verwendet dieselbe lokale
Fixture-Schicht und dokumentiert den Orthofoto-Fehlerpfad explizit.

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
