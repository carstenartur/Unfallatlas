# Architektur – Unfallatlas / Unfallwerkbank

Dieses Dokument gibt einen Überblick über die wichtigsten Bausteine der
Unfallwerkbank, mit besonderem Fokus auf die seit den Features
**„KI-Export-Bewertung"** und **„Politische Kontextrecherche"** vorhandene
Server-Schicht.

> Tiefergehende Entwickler­informationen (Tests, CI, Code-Stil): siehe
> [`ARCHITECTURE.md`](../ARCHITECTURE.md).
> Detaillierte API- und Konfigurations­referenz: siehe
> [`docs/server-features.md`](server-features.md).

---

## 1. Schichtenmodell

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (GitHub Pages oder lokal über den kanonischen _site-Build)   │
│                                                                      │
│  werkbank_v2.html                                                    │
│   ├── js/ua.core.js, ua.state.js, ua.ui.js, ua.map_v2.js             │
│   ├── js/ua.filters.js, ua.data_v2.js                                │
│   ├── js/ua.export_v2.js   ← deterministischer Export-/Analysepfad   │
│   ├── js/ua.report_v2.js   ← PDF-/Word-Renderer (pdfMake / docx)     │
│   ├── js/ua.tour.js        ← Tour-Player & Recorder                  │
│   └── js/ua.political-context.js  ← Frontend für Polit-Recherche     │
└──────────────────────────────────────────────────────────────────────┘
              │ optionale HTTP-Aufrufe (nur wenn Server vorhanden)
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Express-Server (server/index.js, optional, z. B. via Docker)        │
│                                                                      │
│  ├── /api/export-video                 → server/video-export.js      │
│  ├── /api/ai/export-assessment[/v2]    → server/ai/                  │
│  ├── /api/ai/jobs[/:id]                → server/ai/jobs/             │
│  ├── /api/political-context/search     → server/political-context/   │
│  ├── /api/political-context/supported  → server/political-context/   │
│  ├── /api/ai-assessment-available      (Feature-Flag)                │
│  └── /api/video-export-available       (Feature-Flag)                │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼ optional, nur wenn GEMINI_API_KEY gesetzt
┌──────────────────────────────────────────────────────────────────────┐
│  Externer KI-Anbieter (Google Gemini REST-API)                       │
└──────────────────────────────────────────────────────────────────────┘
```

Wichtige Eigenschaften:

- **Browser ist autark.** Karte, Filter, Cluster, Heatmap, Hotspots, POI,
  CSV/GeoJSON/KML und der vollständige PDF-/Word-Export funktionieren
  ohne Server.
- **Server ist optional.** Er liefert nur die Werkbank-Dateien aus und stellt
  optionale Server-Endpunkte bereit (Video-Export, KI-Bewertung,
  politische Recherche).
- **KI ist optional.** Ohne `GEMINI_API_KEY` bleiben alle Kernfunktionen
  nutzbar; KI-Endpunkte antworten entweder mit Fallback (deterministisch)
  oder `503`.
- **Politische Recherche ist serverseitig.** Die Provider rufen externe
  Stadt-/Bezirks-Portale ab; aus dem Browser ist das wegen CORS nicht
  möglich. Ohne Server steht diese Funktion nicht zur Verfügung.

### 1.1 Anreicherungs-Pipeline (Kontextdaten)

Neben den amtlichen Unfalldaten erzeugt der Workflow
[`.github/workflows/enrich.yml`](../.github/workflows/enrich.yml)
**optional Kontextdaten** (Topographie, OSM-Straßenattribute,
Verkehrsklasse-Proxy). Diese werden im Browser **lazy** nachgeladen,
ändern den Hot-Path (`UA.loadCityData`) nicht und sind in jeder Schicht
strikt **„Kontext, nicht Ursache"**.

```
┌──────────────────────────────────────────────────────────────────────┐
│  GitHub Actions (.github/workflows/enrich.yml)                       │
│                                                                      │
│  scripts/producers/                                                  │
│   ├── osm_producer.js      → Overpass-API → osm_<slug>.json          │
│   ├── dem_producer.js      → SRTM 30 m / Open-Meteo → dem_<slug>.json│
│   └── traffic_producer.js  → osm_<slug>.json → traffic_<slug>.json   │
│                              (projekteigener OSM-highway-Proxy,      │
│                              keine Zähldaten)                        │
│  ▼                                                                   │
│  scripts/enrich_geojson.js  (Tier-B Anreicherung)                    │
│  ▼                                                                   │
│  out/output_all_years_<city>.geojson  (per-feature Felder)           │
│  out/ways_<city>.json                 (per-way Attribute)            │
│  out/output_all_years_<city>.enrichment.meta.json  (Sidecar)         │
└──────────────────────────────────────────────────────────────────────┘
              │ statisch ausgeliefert (GitHub Pages oder lokal)
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend (Browser)                                                  │
│                                                                      │
│  ua.data_v2.loadCityData                                             │
│   ├── lädt out/output_all_years_<city>.geojson (Hot-Path)            │
│   ├── UA.contextLayers.detect → ctx.contextCapabilities              │
│   │   {hasElevation, hasSlope, hasOsmContext, hasTrafficProxy,       │
│   │    hasAny}                                                       │
│   └── UA.contextLayers.loadAtIdle → ctx.contextLayerState            │
│       (lazy fetch von ways_<city>.json + meta-Sidecar via            │
│        requestIdleCallback)                                          │
│                                                                      │
│  ua.popup_context.composeAccidentPopupHtml                           │
│   └── hydratisiert Way-Attribute aus ctx.contextLayerState           │
│       (per-feature gewinnt; Race-tolerant: state=null → Popup        │
│        nutzt nur Per-Feature-Daten, keine Spinner)                   │
│                                                                      │
│  ua.ui.refreshContextFilterVisibility                                │
│   └── blendet die UI-Sektion „Kontext (neu)" pro Capability ein/aus  │
│       und setzt veraltete Chip-Filter zurück                         │
│                                                                      │
│  ua.filters.matchesContextFilters                                    │
│   └── konsultiert pro Filter-Zeile ctx.contextCapabilities;          │
│       fehlende Capability → defensives No-Op statt versteckter       │
│       Ergebnis-Reduktion                                             │
└──────────────────────────────────────────────────────────────────────┘
```

Wichtige Eigenschaften:

- **CI macht die Anreicherung, das Frontend zeigt sie nur an.** Die
  Producer laufen offline in GitHub Actions; der Browser sieht nur die
  fertigen `out/*.geojson` + `out/ways_<slug>.json`-Artefakte.
- **`ways_<city>.json` ist optional und lazy.** Der Hauptdaten-Hot-Path
  bleibt unverändert; `ways_<city>.json` wird per
  `requestIdleCallback` geholt und nur zur Popup-Hydration verwendet.
  Schlägt der Fetch fehl (404, Netzwerkfehler), bleiben Popups mit den
  Per-Feature-Werten funktionsfähig und Filter behandeln die Capability
  als abwesend.
- **Capability-Gating überall.** UI-Sektion, Filter-Pruning und
  Export-Quellenhinweis lesen alle aus derselben Quelle
  (`UA.contextLayers.capabilitiesFromDetection`), sodass Frontend und
  Filter nie auseinanderlaufen.
- **„Kontext nicht Ursache"** – als verpflichtender Disclaimer in
  Popup, Filter-Hinweistext und Export-Quellenblock.
- **Kontext als Karten-Layer (first class).** `ways_<city>.json` ist
  ab Producer 1.2.0 / `schemaVersion: 3` ein dünner Envelope, der auf
  `out/ctxtiles/<slug>/<x>/<y>.json` (Slippy-Tiles, Z=13) verweist.
  `js/ua.context_road_layer.js` baut daraus zwei Canvas-gerenderte
  Leaflet-Layer („Straßensteigung" + „Verkehrsbelastung"), die per
  Karten-Layer-Control (oben links) ein-/ausgeschaltet werden können.
  Die Overlays zeichnen **das vollständige OSM-Straßennetz im
  Stadt-BBox** (viewport-lazy via `loadTilesForBbox`). Mit
  `dem_producer.js` ≥ 1.1.0 trägt **jeder** Weg im v3-Kontextnetz
  eine Slope-Klasse aus dem Median seiner Segment-Steigungen
  (lokale SRTM-Tiles); die Verkehrs-Klasse basiert auf dem DTV-Proxy. Vollständige
  Beschreibung (kanonisch) siehe
  [`docs/enrichment.md` → „Datenausschnitt der Karten-Layer (Straßennetz vs. matched-only Signal)"](enrichment.md#matched-only-disclaimer).
  Ältere v1/v2-Caches bleiben kompatibel und zeichnen weiterhin nur die
  gematchten Wege, bis CI sie nach dem Producer-Bump ersetzt. Die
  gemeinsame Canvas-Pipeline kodiert gleichzeitig aktive Layer redundant:
  Steigung als breite, durchgezogene Grundlinie und Verkehr als schmale,
  gestrichelte Innenlinie. Ein geteilter Renderer hält die Zeichenreihenfolge
  bei URL-Hydration, Toggle und Viewport-Rebuild deterministisch. Der
  awaitbare Port `UA.ensureContextOverlaysReady(ctx)` lädt v3-Tiles und baut
  aktive Layer für den aktuellen Kartenausschnitt neu.
  Der closure-eigene App-Kontext wird für Exportintegrationen ausschließlich
  über den nicht überschreibbaren Getter `UA.getRuntimeContext()` bereitgestellt;
  ein paralleler, veränderlicher `UA.ctx`-Alias existiert bewusst nicht. Die
  Chip-Filter (`#ctxFilterSection`)
  bleiben erhalten als „Detailanalyse"-Sekundärwerkzeug; URL-Keys
  (`ctxSlope`, `ctxTraffic`, `ctxOnlyMatched`) sind unverändert. Neuer
  URL-Key: `mapLayer=slope,traffic`.

Detaillierte Datenmodellbeschreibung, Cache-Schlüssel, Slope-Klassifikation
und Größengarantien siehe [`docs/enrichment.md`](enrichment.md).

---

## 2. AccidentProvider – Datenanbieter-Abstraktion (Issue #312)

Quelle: [`js/ua.accident_provider.js`](../js/ua.accident_provider.js).

`UA.AccidentProvider` ist die Zugriffsschicht für Unfalldaten.  Sie entkoppelt
alle Lade­aufrufe vom konkreten Dateipfad und ermöglicht sowohl vollständige
GeoJSON-Dateien als auch kachelbasiertes Laden — ohne dass Renderer oder
Analyse-Plugins den Unterschied kennen.

### Zielbild

```
ProviderRegistry
├── StaticGeoJsonAccidentProvider   (out/output_all_years_<slug>.geojson)
└── TiledAccidentProvider           (out/accidenttiles/<slug>/index.json
                                     out/accidenttiles/<slug>/<z>/<x>/<y>.json)
```

### Provider-Schnittstelle

Jeder Provider muss drei Pflichtmethoden implementieren; `canProvideForCity` ist optional (Standardwert: `true`):

| Methode | Beschreibung |
|---|---|
| `fetchForCity(cityRaw)` | Alle Unfalldaten der Stadt als GeoJSON FeatureCollection |
| `fetchForBbox(cityRaw, bounds, zoom?)` | Nur die Daten im angegebenen Bbox-Bereich |
| `getCapabilities(cityRaw)` | `{ supportsFullCity, supportsTiles, tileZoom?, totalCount? }` |
| `canProvideForCity(cityRaw)` | `boolean \| Promise<boolean>` — Provider verfügbar? |

### StaticGeoJsonAccidentProvider

Lädt `out/output_all_years_<slug>.geojson` in einem Request — entspricht dem
bisherigen `UA.loadCityData`-Verhalten.  `fetchForBbox` fällt auf den
Volllade­pfad zurück; der Aufrufer muss selbst viewport-filtern.

```javascript
UA.AccidentProvider.createStaticProvider({
  fetch:       window.fetch,          // injectable (Tests, Node.js)
  baseUrl:     '',                    // optionaler URL-Präfix (CDN)
  filePattern: 'out/output_all_years_{slug}.geojson',
})
```

### TiledAccidentProvider

Lädt Kacheln aus einer Kachelpyramide analog zum Kontext-Layer-Ansatz in
`ua.context_layers.js`.

Kachelstruktur:
```
out/accidenttiles/<slug>/index.json           ← Manifest
out/accidenttiles/<slug>/<z>/<x>/<y>.json     ← GeoJSON-Kachel
```

Manifest-Format (schemaVersion: 1):
```json
{
  "schemaVersion": 1,
  "city":          "<slug>",
  "z":             13,
  "tiles":         [{ "x": 4200, "y": 2750, "count": 42 }],
  "totalCount":    12345,
  "generatedAt":   "2026-01-01T00:00:00Z"
}
```

`fetchForBbox` berechnet die Slippy-Tile-Koordinaten für die gegebene
Bounding Box und lädt nur die Kacheln, die der Manifest kennt — unbekannte
Kacheln werden nie angefragt.

```javascript
UA.AccidentProvider.createTiledProvider({
  fetch:    window.fetch,
  tileRoot: 'out/accidenttiles',
})
```

### ProviderRegistry

Ein einfaches, sortierbares Registry für benannte Provider:

```javascript
const R = UA.AccidentProvider.ProviderRegistry;
R.register('static', UA.AccidentProvider.createStaticProvider());
R.register('tiled',  UA.AccidentProvider.createTiledProvider());

// Synchrone Auflösung (bevorzugt Tiled, wenn canProvideForCity === true)
const p = R.resolve('hannover');

// Asynchrone Auflösung (wartet auf async canProvideForCity)
const p = await R.resolveAsync('hannover');
```

### Rückwärtskompatibilität

`UA.buildDataUrl` und `UA.loadCityData` in `ua.data_v2.js` bleiben unverändert.
Der bestehende `werkbank_v2.html`-Workflow funktioniert weiterhin.
Neuer Code kann progressiv auf den Provider migrieren, ohne dass ein
Flag-Day nötig ist.

---

## 3. TrafficSituation – Domänenmodell (Issue #309)

Quelle: [`js/ua.traffic_situation.js`](../js/ua.traffic_situation.js).

`UA.TrafficSituation` ist das erste First-Class-Domänenobjekt der Unfallwerkbank.
Es repräsentiert eine vollständige, serialisierbare Verkehrssituation als
einzelnes JSON-kompatibles Objekt und ist die Grundlage für Analyse,
Export, Vorschau und zukünftige Clients.

```
TrafficSituation
├── version      (Schemaversion)
├── id           (optionaler stabiler Bezeichner – URLs können darauf verweisen)
├── metadata     { city, created, updated, description }
├── core
│    ├── viewport         { center: {lat, lon}|null, zoom: number|null }
│    ├── selection        { south, west, north, east } | null
│    ├── filters          (Schweregrad, Tagestyp, Beteiligte, Kontext-Filter, …)
│    ├── layerVisibility  { showCluster, showHeatmap, showSchools, … }
│    └── accidentView     (bySeverity | byType | …)
└── layers       (Objekt, nach Typ indiziert – alle optional und versioniert)
     ├── accident          GeoJSON-Unfalldaten
     ├── poi               Points of Interest (Schulen, Spielplätze, …)
     ├── contextRoad       Straßenkontext-Anreicherung (Steigung, Verkehr)
     ├── politicalContext  Politikdokumente / Parlamentsanfragen
     ├── environmental     Wetter, Lichtverhältnisse, Straßenzustand
     ├── aiAssessment      KI-generierte Situationsbewertung
     ├── recommendation    Abgeleitete Sicherheitsmaßnahmen
     ├── export            Export-spezifische Optionen und Artefakte
     └── presentation      Rendering-Hinweise (Farben, Zoom, Layout)
```

### Architektonische Prinzipien

- **Leaflet-unabhängig.** Alle Felder sind plain JSON-Werte.
- **Unveränderlich.** `addLayer`, `removeLayer` geben neue Objekte zurück und mutieren das Original nicht.
- **Vollständig serialisierbar.** `UA.TrafficSituation.serialize(ts)` erzeugt einen tiefen Klon, der per `JSON.stringify` sicher übertragen werden kann.
- **Rückwärtskompatibel.** `fromMapScene` / `toMapScene` ermöglichen die schrittweise Migration bestehenden MapScene-basierten Codes.
- **URL-als-Referenz.** Das `id`-Feld erlaubt es, URLs auf eine konkrete TrafficSituation zu verweisen statt auf UI-State.

### Öffentliche API

| Funktion | Beschreibung |
|---|---|
| `UA.TrafficSituation.LAYER_TYPES` | Konstanten für alle Layer-Typen |
| `UA.TrafficSituation.create(overrides?)` | Neue Instanz mit Defaults |
| `UA.TrafficSituation.fromMapScene(scene, layers?)` | Aus MapScene erstellen |
| `UA.TrafficSituation.toMapScene(ts)` | Zu MapScene konvertieren |
| `UA.TrafficSituation.addLayer(ts, layer)` | Layer hinzufügen (unveränderlich) |
| `UA.TrafficSituation.removeLayer(ts, layerType)` | Layer entfernen (unveränderlich) |
| `UA.TrafficSituation.getLayer(ts, layerType)` | Layer abrufen oder null |
| `UA.TrafficSituation.serialize(ts)` | JSON-sicherer tiefer Klon |
| `UA.TrafficSituation.deserialize(data)` | Aus JSON wiederherstellen |

---

## 4. Analyse-Plugin-Pipeline (Issue #311)

Quelle: [`js/ua.analysis_pipeline.js`](../js/ua.analysis_pipeline.js).

Die Analyse-Pipeline entkoppelt Datenverfügbarkeit, Plugin-Auswahl und
Artefakt-Erzeugung. Statt Export-, KI- oder Antragslogik direkt an globale
UI-Zustände zu koppeln, erhalten Plugins ausschließlich einen
**AnalysisContext** mit read-only Zugriff auf:

- `trafficSituation`
- `dataRegistry`
- `capabilityRegistry`
- bereits vorhandene `resultMap`/Artefakte

### Zentrale Bausteine

```
TrafficSituation
   │
   ▼
UA.AnalysisPipeline.fromTrafficSituation(...)
   │
   ▼
UA.AnalysisPipeline.deriveCapabilities(...)
   │
   ▼
UA.AnalysisPipeline.createPluginRegistry(...)
   │
   ▼
UA.AnalysisPipeline.runPipeline(...)
   │
   ├── PluginResult(status=complete|partial|skipped|failed)
   └── producedArtifacts → zurück ins DataRegistry
```

### DataRegistry

Das Registry hält rohe und abgeleitete Daten unter stabilen Schlüsseln
(`accidents`, `pois`, `roadContext`, `politicalReferences`,
`environmentalData`, `trafficCounts`, `aiFindings`, `recommendations`,
`sceneGraph`, `exports`, `viewport`, …). Jeder Eintrag trägt optional
`provenance`, `updatedAt` und `sourcePlugin`.

### CapabilityRegistry

Capabilities beschreiben, **welche Analysefähigkeiten aktuell wirklich
verfügbar sind**, unabhängig davon, ob die Daten aus GeoJSON, OSM,
AI-Layern oder bereits erzeugten Artefakten stammen.

Beispiele:

- `hasAccidentData`
- `hasPoiData`
- `hasRoadContext`
- `hasSlopeData`
- `hasSurfaceData`
- `hasRailData`
- `hasPoliticalReferences`
- `hasTrafficCounts`
- `has3dCityModel`
- `hasAiAssessment`
- `hasRecommendations`

### Plugin-Vertrag

Ein Plugin wird über `UA.AnalysisPipeline.createPlugin(...)` registriert und
deklariert explizit:

- `requiredData` / `optionalData`
- `requiredCapabilities` / `optionalCapabilities`
- `producedArtifacts`
- `dependsOn`
- `supportsPartialData`
- `supports(context)`
- `run(context)`

`run(context)` liefert ein strukturiertes `PluginResult` zurück:

```text
PluginResult
├── status
├── producedArtifacts
├── missingOptionalData / missingOptionalCapabilities
├── missingRequiredData / missingRequiredCapabilities
├── warnings
├── confidence
├── completeness
└── provenance
```

### Graceful Degradation / inkrementelle Migration

- Fehlende **optionale** Daten werden im Resultat gemeldet und führen bei
  `supportsPartialData: true` zu `status: "partial"` statt zu einem Fehler.
- Fehlende **required** Daten/Capabilities führen zu `status: "skipped"`
  mit expliziter Begründung.
- Erzeugte Artefakte werden wieder ins `DataRegistry` geschrieben; nachfolgende
  Plugins können sie über `dependsOn` und `requiredData` weiterverwenden.
- Bestehende Logik wie `computeExportReport`, KI-Bewertung oder
  Antragsentwürfe kann dadurch Schritt für Schritt in Plugins gekapselt werden,
  ohne dass sofort alle Datenquellen gleichzeitig verfügbar sein müssen.

---

## 5. Renderer-unabhängige Visualisierungsarchitektur (Issue #310)

Quellen:
- [`js/ua.scene_graph.js`](../js/ua.scene_graph.js) — Scene Graph
- [`js/ua.renderer.js`](../js/ua.renderer.js) — Renderer-Schnittstelle
- [`js/ua.leaflet_renderer.js`](../js/ua.leaflet_renderer.js) — Leaflet-Implementierung

### Ziel

Die Visualisierungsschicht soll von Leaflet und der konkreten Unfallquelle
entkoppelt werden.  Alle zukünftigen Clients — Leaflet, MapLibre, Cesium,
RealityKit/ARKit, WebXR, Word/PDF, statische Vorschaubilder — konsumieren
denselben **Scene Graph** und müssen keine Analyse-Logik duplizieren.

### Rendering-Pipeline

```
TrafficSituation
       │
       ▼
  Analysis Pipeline
       │
       ▼
  Semantic Scene
       │
       ▼
  SceneGraph  ← UA.SceneGraph.fromTrafficSituation(ts)
       │
  ┌────┼─────────────┐
  │    │             │
  ▼    ▼             ▼
Leaflet Cesium   RealityKit
  2D    3D          AR
```

### 3.1 SceneGraph — `UA.SceneGraph`

Ein SceneGraph ist ein Baum von `SceneNode`-Objekten.
Jeder Knoten ist ein plain, serialisierbares Objekt:

```
SceneNode
├── id          (eindeutig im Graph)
├── type        NODE_TYPE (point | polyline | polygon | mesh | billboard |
│               label | heatField | cluster | arrow | highlight | camera | light)
├── geometry    (renderer-unabhängige Geometriebeschreibung)
├── style       (Farbe, Größe, Deckkraft, …)
├── semantic    (Bedeutung: kind, label, severity, year, …)
├── interaction (selectable, hoverable, data)
├── lod         (minLevel, maxLevel, overrides — Level-of-Detail-Regeln)
└── children    (Sub-Knoten, z. B. Cluster → einzelne Punkte)
```

**Level-of-Detail (LOD):** `DISTANT → CITY → STREET → INTERSECTION → PEDESTRIAN`

Jeder Renderer entscheidet selbst, wie er das angeforderte LOD umsetzt.

**Öffentliche API:**

| Funktion | Beschreibung |
|---|---|
| `UA.SceneGraph.NODE_TYPES` | Alle Knoten-Typ-Konstanten |
| `UA.SceneGraph.LOD_LEVELS` | Alle LOD-Level-Konstanten |
| `UA.SceneGraph.INTERACTION_EVENTS` | Alle Interaktions-Event-Konstanten |
| `UA.SceneGraph.create(overrides?)` | Leeres Scene-Graph erstellen |
| `UA.SceneGraph.createNode(type, opts?)` | Typisierten Knoten erstellen |
| `UA.SceneGraph.addNode(graph, node)` | Knoten hinzufügen (unveränderlich) |
| `UA.SceneGraph.removeNode(graph, nodeId)` | Knoten entfernen (unveränderlich) |
| `UA.SceneGraph.getNode(graph, nodeId)` | Knoten suchen (rekursiv) |
| `UA.SceneGraph.fromTrafficSituation(ts)` | Scene-Graph aus TrafficSituation bauen |

### 3.2 Renderer-Schnittstelle — `UA.Renderer`

Jeder Renderer implementiert exakt diese vier Methoden:

```
renderer.render(sceneGraph)     → void | Promise<void>
renderer.update(sceneGraph)     → void | Promise<void>
renderer.dispose()              → void
renderer.captureSnapshot()      → Promise<string>  (data-URL)
```

**Capability-Flags:** `RENDER_2D`, `RENDER_3D`, `RENDER_AR`, `SNAPSHOT`, `STREAMING`, `EXPORT`

**Öffentliche API:**

| Funktion | Beschreibung |
|---|---|
| `UA.Renderer.CAPABILITIES` | Alle Capability-Konstanten |
| `UA.Renderer.create(name, impl, caps?)` | Renderer aus Impl-Objekt erstellen |
| `UA.Renderer.createNoop()` | No-Op-Renderer für Tests |
| `UA.Renderer.assertInterface(r)` | Schnittstellenprüfung (wirft bei fehlenden Methoden) |

**Geplante Implementierungen:**
`LeafletRenderer` · `MapLibreRenderer` · `CesiumRenderer` · `RealityKitRenderer` · `HtmlRenderer` · `WordRenderer` · `PdfRenderer` · `ImageRenderer`

### 3.3 LeafletRenderer — `UA.LeafletRenderer`

Leaflet-Implementierung mit Capabilities `RENDER_2D` und `SNAPSHOT`.

Mapping `SceneNode.type → Leaflet`:

| SceneNode-Typ | Leaflet-Objekt |
|---|---|
| `point` | `L.circleMarker` |
| `polyline` | `L.polyline` |
| `polygon` | `L.polygon` |
| `billboard` | `L.marker` (DivIcon) |
| `label` | `L.marker` (DivIcon, Text) |
| `arrow` | `L.polyline` |
| `highlight` | `L.rectangle` / `L.polygon` |
| `heatField`, `cluster` | an bestehende Pipeline delegiert |
| `camera`, `light`, `mesh` | No-Op (3D/AR-only) |

---

## 6. Deterministischer Export-/Analysepfad

Quelle: [`js/ua.export_v2.js`](../js/ua.export_v2.js),
[`js/ua.report_v2.js`](../js/ua.report_v2.js).

`computeExportReport()` erzeugt aus dem aktuellen Datensatz und Filterzustand
ein Objekt `{ text, html, structured }`.  `structured` enthält u. a.:

- `meta` – Stadt, Filter, Zeitraum, `activeFilterMask`, `involvementMode`,
  Gremiums­treffer
- Kennzahlen (Gesamtzahl, KSI-Anteile, Beteiligungs­anteile)
- Kreuztabellen (Beteiligung × Schwere, Stunde × Wochentag …)
- Hotspot- / Cluster-Daten
- POI-Treffer in der Auswahl (Schulen, Kitas)

Dieser Pfad ist **vollständig deterministisch** und unabhängig von KI:

- gleiche Eingaben (Filter + URL-State) → gleiche Ausgaben
- gleiche `structured` → gleicher PDF-/Word-Export
- alle Tabellen und Zahlen stammen ausschließlich aus den amtlichen
  Unfallatlas-Daten

Die PDF-/Word-Renderer in `ua.report_v2.js` lesen nur aus `structured` und
fügen optional KI-Bausteine ein, wenn der Nutzer sie zuvor explizit angefordert
und übernommen hat.

---

## 4. `server/ai/` – Optionale KI-Bewertung

Detaillierter Modul-Überblick: [`server/ai/README.md`](../server/ai/README.md).

Verantwortlichkeiten:

| Modul | Aufgabe |
|---|---|
| `aiAssessmentService.js` (v1) | Bestand, Endpunkt `/api/ai/export-assessment` |
| `aiAssessmentServiceV2.js`    | Orchestrierung v2 (Features → Maßnahmen → Prompt → Provider → Validierung → Cache) |
| `features/`                   | `deriveFeatures` (KSI, Trends, Cluster), `conflictPatterns` |
| `catalog/`                    | Maßnahmenbibliothek (allgemein + stadtspezifisch) |
| `scoring/preselectMeasures.js`| Deterministische Vorauswahl plausibler Maßnahmen |
| `prompts/`                    | System- und Nutzer-Prompt für beide Modi |
| `providers/geminiProvider.js`, `providers/geminiStructuredProvider.js` | HTTPS-Aufruf an Gemini, Retry/Backoff, Timeout |
| `schema/*.json`               | Strenges JSON-Schema für Antwortvalidierung |
| `cache/aiAssessmentCache.js`  | sha256-Cache (TTL 1 h), schont Free-Tier |
| `jobs/aiJobQueue.js`          | Concurrency-Queue + asynchroner Job-Endpunkt |

Wichtige Garantien:

- **KI ist optional.**  `isAvailable()` prüft `GEMINI_API_KEY`.
- **Fallback statt Fehler.**  v2-Endpunkt antwortet bei fehlendem Key oder
  Provider-Fehler (sofern `withFallback !== false`) mit
  `source: "fallback"` und einem deterministisch erzeugten, schemakonformen
  Output.
- **Kein KI-Aufruf aus dem Browser.**  Die UI ruft nur den eigenen
  Server an; der Schlüssel verlässt den Server nie.
- **KI verändert nie die Zahlen.**  Tabellen, KSI-Anteile usw. stammen
  weiterhin aus `structured`; die KI ergänzt nur Bewertung, Hypothesen,
  Maßnahmenvorschläge und Formulierungs­bausteine.

---

## 5. `server/political-context/` – Politische Recherche

Detaillierter Modul-Überblick:
[`server/political-context/README.md`](../server/political-context/README.md).

Verantwortlichkeiten:

| Modul | Aufgabe |
|---|---|
| `registry/cityPortalRegistry.js` | Stadt → Provider-Mapping (Hannover, Berlin, Bonn, Hamburg) |
| `providers/*Provider.js`         | Adapter für die jeweiligen Stadt-/Bezirks-Portale (SIM, Allris, Pardok) |
| `providers/_portalUtils.js`      | Geteilte HTTP-/HTML-/Heuristik-Helfer (Timeout, Sanitisierung) |
| `services/portalSearchService.js`| Orchestrierung der Suche (inkl. Variantenexpansion, Verkehrsklassifikation und KI-Gating-Anreicherung) |
| `services/searchVariantBuilder.js` | Erzeugt Suchvarianten aus Karten-/Exportkontext (Straße + Radverkehr, Straße + Gremium, Stadtbezirk + Straße, Thema + Stadtteil …) |
| `services/portalNormalizationService.js` | Einheitliches Datenmodell `PoliticalReference` |
| `services/portalRelevanceService.js`     | Relevanzbewertung & Sortierung |
| `services/trafficRelevanceService.js`    | Verkehrsfachliche Klassifikation (`trafficCategory`, `trafficRelevanceScore`, `trafficSubtopics`, `isTrafficRelevant`, `trafficReason`) – deterministisch, keine KI |
| `services/aiGatingService.js`            | Zentrale KI-Zulassungslogik (`shouldAllowForAiEvaluation`) – die Suche darf breit liefern, die KI-Auswahl ist eng |
| `schemas/*.json`                 | JSON-Schema für Anfrage-/Antwort-Validierung |

Wichtige Garantien:

- **Serverseitig**, weil Browser die externen Portale nicht direkt aufrufen
  können (CORS, Cookies, teils HTML-Scraping).
- **Provider-URLs sind hartkodiert.**  Es findet keine URL-Konstruktion aus
  Nutzereingaben statt → keine SSRF-Angriffsfläche.
- **Timeout pro Portal-Anfrage** über `PORTAL_SEARCH_TIMEOUT_MS`
  (Standard 10 s).  Bei Timeout/Fehler wird ein leeres Treffer-Array
  zurückgegeben, statt den Aufruf mit `500` scheitern zu lassen.
- **Rate-Limit** (20 Requests/Minute/IP) auf dem Endpunkt.
- **Übernahme in den Export erfolgt explizit** durch den Nutzer; nichts
  fließt automatisch in den Bezirksratsantrag.

---

## 6. Zusammenspiel der Schichten

| Funktion                           | Browser allein | Server ohne KI | Server mit KI |
|---|:---:|:---:|:---:|
| Karte, Filter, Cluster, Heatmap    | ✅ | ✅ | ✅ |
| POI (Schulen/Kitas)                | ✅ | ✅ | ✅ |
| CSV / GeoJSON / KML                | ✅ | ✅ | ✅ |
| PDF-/Word-Export (deterministisch) | ✅ | ✅ | ✅ |
| Geführte Tour, URL-State           | ✅ | ✅ | ✅ |
| Video-Export (`.gif`)              | ❌ | ✅ | ✅ |
| Politische Recherche               | ❌ | ✅ | ✅ |
| KI-Bewertung (v1)                  | ❌ | ❌ (503) | ✅ |
| KI-Bewertung v2 mit Fallback       | ❌ | ✅ Fallback | ✅ KI |
| KI-Bewertung v2 ohne Fallback      | ❌ | ❌ (503) | ✅ |

Die kompakte Einordnung für Endnutzer:innen findet sich in der
[README](../README.md). Die folgende Matrix enthält die ausführliche
Betreiber-/Technik-Sicht.

### 5.1 Betriebsarten / Betriebs-Matrix (ausführlich)

| Funktion | Browser-only<br>(GitHub Pages) | Lokaler Server<br>**ohne** `GEMINI_API_KEY` | Lokaler Server<br>**mit** `GEMINI_API_KEY` | Docker |
|---|:---:|:---:|:---:|:---:|
| Karte, Filter, Cluster, Heatmap, Hotspots | ✅ | ✅ | ✅ | ✅ |
| POI-Overlay (Schulen, Kitas)              | ✅ | ✅ | ✅ | ✅ |
| Bereichsauswahl, geteilte URLs            | ✅ | ✅ | ✅ | ✅ |
| CSV / GeoJSON / KML-Export                | ✅ | ✅ | ✅ | ✅ |
| **Deterministischer PDF-/Word-Export**    | ✅ | ✅ | ✅ | ✅ |
| Geführte Tour & Recorder                  | ✅ | ✅ | ✅ | ✅ |
| **Politische Recherche** (Hannover, Berlin, Bonn, Hamburg) | ❌ | ✅ | ✅ | ✅ |
| **KI-Bewertung v2** (mit Fallback)        | ❌ | ✅ Fallback¹ | ✅ KI | ✅ (KI nur mit Key) |
| **KI-Bewertung v1** (`/api/ai/export-assessment`) | ❌ | ❌ (`503`) | ✅ | ✅ (nur mit Key) |
| **Video-Export** (`.gif`)                 | ❌ | ✅ | ✅ | ✅ |
| Konfiguration nötig                       | – | Node 24.x und npm 11 installieren, `npm run start:server` | zusätzlich `GEMINI_API_KEY` setzen | nur `docker run …` (optional `-e GEMINI_API_KEY=…`) |

¹ Ohne `GEMINI_API_KEY` antwortet `POST /api/ai/export-assessment/v2`
mit `200 OK` und `source: "fallback"` (deterministischer, datengestützter
Output ohne KI-Texte). Wer das nicht will, setzt `withFallback: false` im
Body und erhält dann `503`.

### 5.2 NPM-Skripte (Kurzreferenz)

| Skript | Zweck |
|---|---|
| `npm start` / `npm run start:server` | Lokalen Express-Server auf `:8000` starten (`node server/index.js`) |
| `npm run start:docker` | Docker-Image bauen und starten (`docker compose up --build`) |
| `npm test` | Unit- und Integrationstests (Jest) |
| `npm run test:e2e` | End-to-End-Tests im Chromium-Browser (Playwright) |
| `npm run test:coverage` | Jest mit Coverage-Report unter `coverage/` |
| `npm run smoke` | Smoke-Tests gegen einen laufenden Server (`scripts/smoke.sh`) |
| `npm run demo` | Erzeugt ein Demo-Video (Playwright `demo`-Projekt) |

Browser-Entwicklung und Produktion verwenden denselben kanonischen Einstieg:
`npm ci && npm run serve:site`. `npm run build:site` erzeugt `_site`, kopiert
die exakt gelockten Browser-Abhängigkeiten nach `_site/vendor` und schreibt ein
Build-/Daten-Fingerprint-Manifest. Direktes `file://` oder ein Server im
Repo-Root wird nicht unterstützt; Details: [`site-build.md`](site-build.md).

Status-Endpunkt für Frontend / Smoke: `GET http://localhost:8000/api/status`
(siehe [`docs/server-features.md`](server-features.md)).

### 5.3 Konfiguration (Auszug)

| Variable | Standard | Wirkung |
|---|---|---|
| `PORT` | `8000` | Port des Express-Servers |
| `GEMINI_API_KEY` | – | aktiviert die KI-Bewertung; ohne Key bleibt der Fallback aktiv |
| `AI_ASSESSMENT_MODEL` | `gemini-2.0-flash` | Gemini-Modell für die Bewertung |
| `AI_ASSESSMENT_TIMEOUT_MS` | `30000` | Timeout pro KI-Request (ms) |
| `AI_ASSESSMENT_MAX_RETRIES` | `2` | Retries bei `429`/`5xx` |
| `PORTAL_SEARCH_TIMEOUT_MS` | `10000` | Timeout pro Portal-Anfrage (ms) der politischen Recherche |
| `AI_CACHE_PATH`, `AI_JOBS_PATH` | – | optionale Persistenz von KI-Cache und Job-Queue |

Vollständige Liste aller Endpunkte, Request-/Response-Beispiele,
Fehlerfälle und Env-Variablen: [`docs/server-features.md`](server-features.md).

> **Testabdeckung Video-Export.** Da `server/video-export.js` zur
> Laufzeit Chromium und das `ffmpeg`-Binary aus dem Dockerfile aufruft,
> würde ein in-process Unit-Test diese Abhängigkeiten nie erfassen. Die volle
> Pipeline (Express → Playwright → PDF → ffmpeg → GIF/WebP/APNG) wird stattdessen über
> den Testcontainers-Test
> [`tests/integration/videoExport.testcontainers.test.js`](../tests/integration/videoExport.testcontainers.test.js)
> verifiziert. Im normalen lokalen/CI-Modus baut er das produktive Dockerfile
> mit einer deterministischen Test-Fixture; ist `UNFALLATLAS_IMAGE` gesetzt
> oder `CONTEXT_E2E_REQUIRE_SHIPPED=1`, prüft er stattdessen bewusst das
> angegebene ausgelieferte Image. Danach POSTet er die im Testbody dokumentierte
> Kontext-URL und prüft Signatur, Formatbudget, Zustands-/Build-/Datenhash,
> positive Unfallzahlen, PDF-Abschluss sowie decodierte Unfall-, Steigungs-
> und Verkehrspixel. Der Container-Log muss frei von
> `[export-video] Fehler` bleiben. Lokal: per
> `npm run test:integration:tc`; in CI als eigener Job
> `video-export-integration` in
> [`.github/workflows/test.yml`](../.github/workflows/test.yml). Der
> Test wird automatisch übersprungen, wenn kein Docker-Socket
> erreichbar ist. Der normale lokale/CI-Test setzt die deterministische
> Bonn-Fixture bereits **vor** `npm run build:site` per Docker-Build-Arg ein;
> dadurch belegen `_site/build-manifest.json` und die Exportheader exakt die
> tatsächlich gerenderten Fixture-Bytes. Mit
> `CONTEXT_E2E_REQUIRE_SHIPPED=1` entfällt diese Fixture und derselbe Vertrag
> wird bewusst gegen die ausgelieferten Kontextdaten geprüft.

---

## 7. Drei Ebenen der Auswertung

Über die einzelnen Module hinweg kennt das Repository heute **drei
fachlich unterscheidbare Ebenen**.  Sie unterscheiden sich darin, wie
weit ein Ergebnis getragen werden soll: vom einmaligen Blick auf eine
Stelle bis zur stadtweiten Priorisierung.  Die Ebenen bauen aufeinander
auf, jede höhere Ebene ist *additiv* – die niedrigeren bleiben ohne
sie funktionsfähig.

| Ebene | Ziel                                                | Wo realisiert (heute)                                                                                       | Persistenz?         | Betriebsmodus            |
|------:|------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|---------------------|--------------------------|
| 1     | **Interaktive Einzelauswertung**                    | Browser (`werkbank_v2.html`, `js/ua.export_v2.js`, `js/ua.report_v2.js`); optional `POST /api/location-brief` für eine Stelle | nein                | Browser-only / Node      |
| 2     | **Persistierte Wiederverwendung** einer Stelle      | Node-App + Analysis Service: `POST /api/location-brief` mit `persist:true`, `GET /api/location-briefs/by-location/:key`, `useStored:true` | ja (versioniert)    | Node + Analysis Service  |
| 3     | **Stadtweite Priorisierung / Ranking**              | Analysis Service: `prioritization_profile_score`, `GET /api/location-briefs/top?city=&profile=`, `POST /api/batch/jobs/city-prioritization` | ja                  | Node + Analysis Service  |

### Ebene 1 – Interaktive Einzelauswertung

- **Was passiert?** Nutzer öffnen die Werkbank, wählen Stadt und
  Filter, zeichnen optional einen Bereich.  `computeExportReport()`
  erzeugt deterministisch das `structured`-Objekt, daraus entsteht der
  PDF-/Word-Bezirksrats­antrag.  Optional liefert
  `POST /api/location-brief` zusätzlich einen Maßnahmen-Steckbrief
  (Konfliktmuster, Kandidaten­maßnahmen, Profil-Score) – ohne
  Persistenz, ohne Datenbank.
- **Eigenschaften:** vollständig in der Session, gleiche Eingaben →
  gleiches Ergebnis, teilbar über deterministische URL.
- **Aktueller Stand:** produktiv und stabil; Default-Pfad für die
  meisten Nutzer.

### Ebene 2 – Persistierte Wiederverwendung

- **Was passiert?** Mit gesetztem `ANALYSIS_SERVICE_BASE_URL` und
  `persist: true` wird der berechnete Brief versioniert in den
  Analysis Service geschrieben (`location_action_brief` +
  Detail-Tabellen).  Idempotent über
  `(locationKey, profileKey, sourceFingerprint)`: derselbe Brief
  erzeugt keinen doppelten Eintrag.  Über
  `useStored: true` kann ein bereits gespeicherter Brief vor der
  Berechnung gelesen werden (Antwort
  `persistence.status: "loaded_from_store"`).
- **Eigenschaften:** Briefs sind reproduzierbar (Source-Fingerprint +
  Regelversionen), Historie pro Stelle ist abrufbar
  (`/by-location/:key`, neueste zuerst).  Fällt der Service aus,
  liefert die Node-App den Brief weiter aus
  (`persistence.status: "persist_skipped"`).
- **Aktueller Stand:** produktiv (Spring Boot 4, Hibernate ORM 7,
  Flyway-Migrationen V1–V2, PostgreSQL in Prod / H2 im
  PostgreSQL-Mode in Dev).
- **Direkt nächster Ausbaupfad:** Hibernate-Search-Backend für
  Volltextsuche über `political_reference_summary` und
  `conflict_pattern_assessment` (Marker an den Entitäten sind
  vorhanden, das Backend ist noch nicht eingebunden).

### Ebene 3 – Stadtweite Priorisierung / Ranking

- **Was passiert?** Pro persistiertem Brief liegen profilspezifische
  Sub-Scores und ein Gesamt-Score (`prioritization_profile_score.total`)
  vor.  `GET /api/location-briefs/top?city=&profile=&limit=` liefert
  daraus die **Top-N Stellen einer Stadt je Profil** – die Antwort auf
  „Welche Stellen sollten wir zuerst angehen?".  Der Spring-Batch-Lauf
  `city-prioritization-job` lädt Kandidaten, validiert/aktualisiert
  die Scores und schreibt eine kompakte Top-N-Summary in
  `analysis_job.summary`.  Anstoß und Beobachtung erfolgen über die
  Forwarder `POST /api/batch/jobs/city-prioritization` und
  `GET /api/batch/jobs/{executionId}[/summary]`.
- **Eigenschaften:** stadt- und profilbezogen; sauber getrennte
  Steps (`loadCandidatesStep` → `computeBriefsStep` →
  `scoreProfilesStep` → `persistResultsStep` → `buildRankingStep`),
  jeweils restartbar.  Identifying-Parameter (`city`, `profile`,
  `recomputeExisting`, `runTimestamp`) verhindern Doppel­ausführungen
  derselben Instance.
- **Aktueller Stand:** Erste produktive Spring-Batch-Anbindung für
  einen Job (`city-prioritization-job`) inkl. Anstoß-/Status-API.
- **Direkt nächster Ausbaupfad:** Multi-City-Orchestrierung
  (mehrere Städte parallel, Locking, verteilter Betrieb) und eine
  Scheduler-Landschaft für zeitgesteuertes Re-Ranking.  Beides ist
  bewusst Folge-PR und in
  [`analysis-service/README.md`](../analysis-service/README.md#was-ist-explizit-folge-pr)
  unter *Was ist explizit Folge-PR?* aufgeführt.
