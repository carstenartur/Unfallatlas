# Screenshots — Aufnahme-Hinweise

Dieses Verzeichnis enthält die in `README.md` und `docs/DOKUMENTATION.md`
referenzierten PNG-Screenshots der Unfallwerkbank V2.

## Konvention

| Nummer | Datei | Beschreibung |
|---|---|---|
| 01 | `01-startansicht.png` | Startansicht der Werkbank V2 |
| 02 | `02-stadtauswahl.png` | Stadtauswahl-Dropdown |
| 03 | `03-filter.png` | Filter-Panel (Beteiligung, Schwere, Zeit, …) |
| 04 | `04-cluster-ansicht.png` | Cluster-Ansicht |
| 05 | `05-heatmap-ansicht.png` | Heatmap-Ansicht |
| 06 | `06-legende.png` | Legende |
| 07 | `07-export-modal.png` | Export-Modal |
| 08 | `08-stundenfilter.png` | Stundenfilter |
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

## Slope-Diagnose (PR-berlin-slope-qa)

| Datei | Beschreibung |
|---|---|
| `slope-berlin.png` | Berlin Mitte (z=16) mit aktivem `mapLayer=slope` — die Plausibilitätsprüfung verlangt überwiegend `flat`/`gentle`. |
| `slope-berlin-debug.png` | Wie oben, mit `?debugSlope=1` — pro Polyline wird `road_slope_percent` als permanenter Tooltip eingeblendet. |
| `slope-bielefeld.png` | Bielefeld (z=15) mit aktivem `mapLayer=slope` als Vergleichsstadt mit gemischterer Verteilung. |
| `slope-bielefeld-debug.png` | Bielefeld mit Debug-Overlay (`?debugSlope=1`). |

Die Debug-Variante ist hinter einer Query-Param geschaltet (`debugSlope=1`,
optional `debugSlopeSamples=1`) und wirkt sich nie auf die Produktion aus.
Sie dient ausschließlich der Sichtprüfung: Wenn die On-Screen-Farbe und
der numerische Tooltip widersprechen, ist das ein klarer Hinweis auf
Encoding-Drift in der Renderer- oder Producer-Pipeline.

Vorher/Nachher-Erzeugung: Die „Vorher"-Bilder werden nicht eingecheckt
(sie würden mit dem Fix sofort obsolet); siehe
`docs/enrichment.md` → *Slope-Diagnose* für die exakte Reproduktions-
befehlskette.



Alle map-haltigen Screenshots werden in den E2E-Tests erst nach einem
Leaflet-Tile-Stabilitäts-Check erstellt (`waitForMapTiles`: keine
`leaflet-tile-loading` mehr, mindestens ein `leaflet-tile-loaded`), plus
kurzer Paint-Pause und defensivem `document.fonts.ready`. Dadurch sind die
Bilder über CI-Re-Runs reproduzierbar.

## Hinweise zu unvermeidbaren Provider-Unterschieden

Für die Map-Mode-Screenshots (`21`–`25`) werden OSM-, Orthofoto- und
Hybrid-Label-Tiles im Test deterministisch gemockt. Dadurch bleiben die
Artefakte stabil, auch wenn externe Tile-Dienste zeitweise abweichende
Farbbalance, Kachelgrenzen oder Ausfälle zeigen. Screenshot `25` dokumentiert
den erwarteten Fallback-Fall explizit statt eines unklaren App-Start-Fehlers.

## TODO – Kontextdaten-Screenshots (PR #260)

Mit der Einführung der Kontextdaten (PR #260, „Kontext (neu)") sind
drei zusätzliche Screenshots vorgesehen. Sie werden **automatisch**
durch das Regen-Skript erzeugt (siehe unten) und müssen nicht von Hand
aufgenommen werden:

| Nummer | Datei | Beschreibung |
|---|---|---|
| 17 | `17-kontext-filter.png` | Filter-Panel mit aufgeklappter Sektion **Kontext (neu)** (Hangneigung, Verkehrsklasse-DTV-Proxy, „nur auf gematchten Straßen") |
| 18 | `18-popup-kontextdaten.png` | Marker-Popup mit Standard-Unfalldetails plus zusätzlichem Block **Kontextdaten** (Topographie, Straßenkontext, Verkehrsexposition mit „proxy"-Badge) |
| 19 | `19-kontext-traffic-proxy.png` | Karte mit aktiven Verkehrsklasse-DTV-Proxy-Filterchips (Bestätigung, dass die Verkehrsexposition projekteigene OSM-`highway`-Schätzung ist) |

Beide Screenshots sollen die explizite **Proxy/Schätzung**-Kennzeichnung
sichtbar enthalten — der Verkehrsklassen-Wert ist ein
*projekteigener OSM-`highway`-Proxy*, **keine gemessene
Verkehrsdichte**.

### Aufnahme-Anleitung — `npm run regen:context-assets`

Das Skript [`scripts/regen-context-assets.js`](../../scripts/regen-context-assets.js)
startet **denselben** `unfallatlas`-Container, gegen den auch der
[Testcontainers-Integrationstest](../../tests/integration/videoExport.testcontainers.test.js)
läuft (Image-Quelle: `UNFALLATLAS_IMAGE` env oder lokaler `docker build`).
Test- und Doku-Asset teilen sich damit *eine* URL und *eine* Quelle:

```bash
# einmalig — das im docker-publish.yml gebaute Image bevorzugen, sonst lokal bauen
export UNFALLATLAS_IMAGE=ghcr.io/carstenartur/unfallatlas:latest

npm run regen:context-assets
```

Erzeugt:

- `docs/demo-context.gif` (über `POST /api/export-video` mit
  `ctxSlope=steep,very_steep&ctxTraffic=high,very_high&ctxOnlyMatched=1`),
- die drei oben gelisteten PNGs in diesem Verzeichnis.

Der aufgezeichnete Viewport zeigt nur die GitHub-Pages-konforme URL
(kein `localhost:8000` im Ribbon — die Werkbank ist dieselbe statische
HTML-Datei, lokal über den Container ausgeliefert).

Voraussetzungen:

- Docker läuft (`docker version` zeigt einen Server),
- `npm ci` wurde ausgeführt (Playwright wird von `@playwright/test`
  bereitgestellt, ist bereits Dev-Dependency).

Datei-Größen-Budget (im Skript geprüft, sonst Exit-Code ≠ 0):
GIF ≤ 10 MB, PNG ≤ 600 KB.

Analog regeneriert `npm run regen:demo` das in der README eingebettete
`docs/demo.gif` über denselben Container-Helper
([`scripts/regen-readme-demo.js`](../../scripts/regen-readme-demo.js)).

Die Platzhalter-Hinweise in `docs/DOKUMENTATION.md` (Abschnitt
„Kontext (neu)") werden mit dem ersten erfolgreichen Lauf des Skripts
gegen die fertigen PNG-Pfade ausgetauscht.
