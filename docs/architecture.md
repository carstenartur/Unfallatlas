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
│  Browser (statisch, GitHub Pages oder lokal über file://)            │
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
- **Kontext als Karten-Layer (first class).** `ways_<city>.json` enthält
  in Schema v2 zusätzlich einen `geometries`-Block (per-Way generalisierte
  Polylinien). `js/ua.context_road_layer.js` baut daraus zwei
  Canvas-gerenderte Leaflet-Layer („Straßensteigung" + „Verkehrsbelastung"),
  die per Karten-Layer-Control (oben links) ein-/ausgeschaltet werden
  können. Die Overlays zeichnen **ausschließlich die im Enrichment-Lauf
  gematchten OSM-Wege** — sie sind kein vollständiges Straßennetz-Modell;
  vollständige Beschreibung (kanonisch) siehe
  [`docs/enrichment.md` → „Datenausschnitt: matched-only, kein vollständiges Straßennetz"](enrichment.md#matched-only-disclaimer).
  Die Chip-Filter (`#ctxFilterSection`)
  bleiben erhalten als „Detailanalyse"-Sekundärwerkzeug; URL-Keys
  (`ctxSlope`, `ctxTraffic`, `ctxOnlyMatched`) sind unverändert. Neuer
  URL-Key: `mapLayer=slope,traffic`.

Detaillierte Datenmodellbeschreibung, Cache-Schlüssel, Slope-Klassifikation
und Größengarantien siehe [`docs/enrichment.md`](enrichment.md).

---

## 2. Deterministischer Export-/Analysepfad

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

## 3. `server/ai/` – Optionale KI-Bewertung

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

## 4. `server/political-context/` – Politische Recherche

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

## 5. Zusammenspiel der Schichten

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

Die Betriebs-Matrix mit Konfigurations­hinweisen findet sich im
[README](../README.md#%EF%B8%8F-betriebsarten--betriebs-matrix).

> **Testabdeckung Video-Export.** Da `server/video-export.js` zur
> Laufzeit das `ffmpeg`-Binary aus dem Dockerfile aufruft, würde ein
> in-process Unit-Test diese Abhängigkeit nie erfassen. Die volle
> Pipeline (Express → Playwright → ffmpeg → GIF) wird stattdessen über
> den Testcontainers-Test
> [`tests/integration/videoExport.testcontainers.test.js`](../tests/integration/videoExport.testcontainers.test.js)
> verifiziert. Er startet das produktive Image (bevorzugt
> `ghcr.io/carstenartur/unfallatlas:latest` aus
> [`docker-publish.yml`](../.github/workflows/docker-publish.yml),
> sonst lokaler `docker build`), POSTet die im Testbody dokumentierte
> Kontext-URL und prüft, dass die Antwort eine echte GIF-Datei
> (`GIF89a`-Magic, `0x3B`-Trailer, 50 KB ≤ Größe ≤ 8 MB) und der
> Container-Log frei von `[export-video] Fehler` ist. Lokal: per
> `npm run test:integration:tc`; in CI als eigener Job
> `video-export-integration` in
> [`.github/workflows/test.yml`](../.github/workflows/test.yml). Der
> Test wird automatisch übersprungen, wenn kein Docker-Socket
> erreichbar ist.

---

## 6. Drei Ebenen der Auswertung

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
