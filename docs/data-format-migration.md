# Dateiformat-Migration: GeoJSON → PMTiles/MVT

> **Status**: Architekturvorschlag und Migrationsplan (kein Big-Bang-Refactoring)
>
> Dieser Plan analysiert das aktuelle Datenformat, bewertet Alternativen und beschreibt
> einen schrittweisen Migrationspfad weg von großen GeoJSON-/ctxtiles-Artefakten hin
> zu PMTiles/MVT als bevorzugtes statisches Hosting-Format.
>
> **Dieser PR enthält keine Enrichment-Artefakte und regeneriert keine Massendaten.**

---

## 1. Problemstellung (Ursache / Motivation)

Das bisherige Konzept basiert auf vollständig vorab generierten, uncompressed GeoJSON-Dateien,
die direkt in Git versioniert werden. Das hat mehrere Konsequenzen:

| Symptom | Ursache |
|---------|---------|
| Riesige PR-Diffs (unlesbar, CI-Timeouts) | Jede Regeneration erzeugt binäre Diffs in MB-großen Textdateien |
| GitHub kann Diffs nicht anzeigen | GeoJSON-Dateien überschreiten GitHub's Diff-Anzeigelimit |
| CI-Runs dauern sehr lang / scheitern | Validation muss hunderte MB parsen |
| Browser lädt die ganze Stadt auf einmal | Kein viewport-basiertes, progressives Laden |
| 1.458 ctxtiles-Dateien als einzelne Commits | Git-Tree wird sehr groß, Checkout langsam |
| Skalierungsproblem bei mehr Städten | Bereits bei 25 Städten über 1 GB generierter Daten |

Das Projekt stößt schon jetzt an Grenzen – bevor alle Städte vollständig erfasst sind.

---

## 2. Größenanalyse der aktuellen Artefakte

### 2.1 Übersicht per Artefakttyp

| Artefakttyp | Dateien | Gesamt (unkomprimiert) | Gesamt (gzip-9 geschätzt) |
|-------------|---------|----------------------|--------------------------|
| `out/output_all_years_<city>.geojson` | 26 | **294,6 MB** | ~20 MB |
| `out/ctxtiles/<city>/…` | 1.458 | **836,8 MB** | ~100–150 MB |
| `out/ways_<city>.json` | 26 | ~0 MB (Stubs) | — |
| `out/output_all_years.geojson` (alles) | 1 | 20 MB | ~1,4 MB |
| `out/*.csv` | 27 | 57,5 MB | ~10 MB |
| **Gesamte generierte Daten** | **~1.540** | **~1.131 MB** | **~135 MB** |

### 2.2 Größe der zehn größten Städte

| Stadt | Features | GeoJSON | ctxtiles |
|-------|----------|---------|---------|
| Berlin | 87.266 | 50,6 MB | 146 MB |
| Hamburg | 62.327 | 36,0 MB | 79 MB |
| München | 43.988 | 25,4 MB | 53 MB |
| Köln | 26.198 | 15,2 MB | 43 MB |
| Frankfurt a. M. | 22.500 | 13,0 MB | 35 MB |
| Bremen | 19.992 | 11,6 MB | 26 MB |
| Dresden | 18.935 | 11,0 MB | 24 MB |
| Hannover | 19.248 | 11,1 MB | 28 MB |
| Leipzig | 16.931 | 9,8 MB | 21 MB |
| Stuttgart | 16.046 | 9,3 MB | 20 MB |
| **25 Städte gesamt** | **465.774** | **294,6 MB** | **836,8 MB** |

### 2.3 Redundanzanalyse im GeoJSON-Format

GeoJSON ist aus mehreren Gründen besonders ineffizient für diesen Anwendungsfall:

1. **Wiederholte Property-Namen**: Jedes Feature trägt alle 26 Property-Namen als String.
   Bei 465.774 Features bedeutet das ~12,1 Millionen redundante Schlüssel-Wiederholungen.
   Hochgerechnet auf den Augsburg-Datensatz (11.354 Features × 26 Properties):
   - Nur die Property-Namen verbrauchen: ~2,7 MB an Zeichenketten.

2. **Koordinaten als Dezimaltext**: Breitengrad/Längengrad werden als 9–10-stellige
   Dezimalzahlen gespeichert (`10.928983531`, `48.378541758`).
   In MVT/Tile-Koordinaten würden dieselben Punkte 2 Byte pro Achse benötigen.

3. **Immer gleiches Feld `road_context_source: "osm"`**: 100 % redundant – spart
   bei Entfernung ~2 Byte × 465.774 Features = ~930 KB.

4. **`name`-Feld mit vollem Muster**: `"Unfall 60696 (2016) Kat:3, Licht: 2"` –
   redundante Metainformation, die aus anderen Feldern ableitbar ist.

5. **Komprimierungspotenzial**: Augsburg-GeoJSON (6,57 MB) → 0,45 MB bei gzip-9:
   Faktor **14,5×** Kompression. Das Format ist für Git-Storage hochgradig suboptimal.

6. **ctxtiles als 1.458 Einzeldateien**: Slippy-Tile-JSON-Dateien pro Stadt/Zoom/X/Y.
   Jede Datei ist eine eigene Git-Blob-Eintragung. Bei Änderungen entstehen
   tausende Datei-Einträge in einem einzigen Commit.

---

## 3. Formatvergleich: Zielformate

### 3.1 Bewertungsmatrix

| Format | Dateigröße | Browser-Loading | Statisches Hosting | Git-Freundlich | CI-Aufwand | Kompl. |
|--------|-----------|----------------|-------------------|----------------|-----------|--------|
| GeoJSON (aktuell) | ❌ Groß | ❌ Alles auf einmal | ✅ Ja | ❌ Riesige Diffs | ❌ Hoch | ✅ Minimal |
| GeoJSON + gzip | ✅ Klein | ⚠️ Alles auf einmal | ✅ Ja (Content-Encoding) | ❌ Binär-Diffs | ✅ Niedrig | ✅ Minimal |
| NDJSON + gzip | ✅ Klein | ⚠️ Stream möglich | ✅ Ja | ❌ Binär-Diffs | ✅ Niedrig | ⚠️ Mittel |
| TopoJSON | ⚠️ Mittel | ⚠️ Alles auf einmal | ✅ Ja | ❌ Große Diffs | ✅ Niedrig | ⚠️ Mittel |
| FlatGeobuf | ✅ Klein | ✅ Bbox-Queries | ✅ Ja | ❌ Binär | ⚠️ Mittel | ⚠️ Mittel |
| Parquet / GeoParquet | ✅ Klein | ❌ Browser-Unterstützung | ⚠️ CDN | ❌ Binär | ✅ Niedrig | ❌ Komplex |
| MVT (`.pbf` Slippy-Tiles) | ✅ Klein | ✅ Viewport-Loading | ✅ Ja | ❌ Binär | ⚠️ Mittel | ⚠️ Mittel |
| **PMTiles** | ✅ Klein | ✅ Range-Request | ✅ Ja | ⚠️ 1 Datei/Stadt | ✅ Niedrig | ⚠️ Mittel |

### 3.2 PMTiles als bevorzugte Zieloption

**PMTiles** (Protomaps Tile Archive) ist ein offenes, einzeldatei-basiertes Format für
Vektor-Map-Tiles:

- **Eine `.pmtiles`-Datei** enthält alle Tiles einer Stadt (alle Zoom-Level).
- Kein Tile-Server nötig: Der Browser nutzt **HTTP Range Requests** (`Range: bytes=X-Y`).
- Nativ unterstützt von **MapLibre GL JS** (seit v3), **Leaflet** über `pmtiles.js`.
- Kompatibel mit GitHub Pages, S3, Cloudflare Pages, Netlify – kein Server nötig.
- **Massiv kleiner** als GeoJSON: MVT-Encoding ist binär + delta-komprimiert.

**Geschätzte Größen für PMTiles (Zoom 5–15):**

| Stadt | GeoJSON aktuell | PMTiles-Schätzung | Ersparnis |
|-------|----------------|-------------------|-----------|
| Berlin (87k Features) | 50,6 MB | ~2–4 MB | ~93 % |
| Hamburg (62k Features) | 36,0 MB | ~1,5–3 MB | ~92 % |
| Alle 25 Städte | 294,6 MB | ~15–30 MB | ~90 % |

(Schätzungen basieren auf typischen Kompressionsraten für Punkt-Datensätze mit MVT/zstd)

**ctxtiles-Ersatz:**
- Die 1.458 ctxtiles-Dateien (836 MB) könnten durch eine einzige PMTiles-Datei
  pro Stadt für Kontext-Layer ersetzt werden.
- Alternativ: Context-Daten als zweiter Layer in derselben PMTiles-Datei.

### 3.3 Alternativen im Kurzvergleich

**FlatGeobuf**: Sehr effizient, bbox-fähig, direkt browserunterstützt über
`flatgeobuf` NPM-Paket. Guter Zwischenweg: ~5–10× kleiner als GeoJSON, behält
Feature-Semantik. Kein Tile-Server nötig. **Empfehlung**: gute kurzfristige Option
für die GeoJSON-Dateien.

**GeoJSON + Brotli/gzip**: Einfachste Migration. Dateigröße 10–15× kleiner. Kein
Tool-Ökosystem nötig. **Nachteil**: Browser lädt immer noch alles auf einmal, kein
viewport-basiertes Laden, binäre Diffs in Git.

**NDJSON + gzip**: Ermöglicht Streaming. Kein Standard für Karten-Layer. Schwieriger
im Frontend.

**TopoJSON**: Gut für Polygone/Linien, weniger Vorteil für reine Punktdaten.

---

## 4. Empfohlene Zielarchitektur

### 4.1 Schichtenmodell

```
┌─────────────────────────────────────────────────────────────────┐
│  Statisch gehostete Karten-Assets (GitHub Pages / CDN)          │
│                                                                  │
│  out/pmtiles/<city>.pmtiles                                     │
│    └─ Layer 1: accidents (Unfalldaten, Zoom 5–15)               │
│    └─ Layer 2: context_roads (OSM-Wege, Zoom 13–15, optional)   │
│                                                                  │
│  out/metadata/<city>.json   (Metadaten: Schema, Felder, Stats)  │
│  out/metadata/cities.json   (Stadt-Index, Bbox, Feature-Count)  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Datenmodell: Minimale Pflichtattribute pro Unfallpunkt

Statt 26 Properties pro Feature werden nur die für Karte und Filter wirklich
nötigen Attribute eingebettet:

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `year` | uint16 | Unfalljahr (2016–2024) |
| `ukategorie` | uint8 | Unfallkategorie (1–3) |
| `utyp1` | uint8 | Unfalltyp (1–9) |
| `uart` | uint8 | Unfallart (0–9) |
| `ulichtverh` | uint8 | Lichtverhältnisse |
| `ustunde` | uint8 | Stunde (0–23) |
| `uwochentag` | uint8 | Wochentag (1–7) |
| `umonat` | uint8 | Monat (1–12) |
| `istrad` | bool | Radfahrer beteiligt |
| `istpkw` | bool | PKW beteiligt |
| `istfuss` | bool | Fußgänger beteiligt |
| `istkrad` | bool | Motorrad beteiligt |
| `slope_class` | uint8 (0–4) | Hangneigungsklasse (Code) |
| `traffic_proxy_class` | uint8 (0–3) | Verkehrsklasse (Code) |
| `matched_way_id` | uint64 | FK → context layer |

**Nicht mehr im Accident-Layer** (lazy aus context layer):
- `elevation_m`, `slope_percent`, `slope_source` – aus Kontext-Layer ladbar
- `highway`, `maxspeed`, `lanes`, `surface` – aus Kontext-Layer ladbar
- `name` – ableitbar, nicht für Filter/Karte nötig
- `road_context_source` – immer "osm", überflüssig
- `id`, `strasse` – ableitbar / selten genutzt

### 4.3 Context-Layer: Separate PMTiles / Lazy-Loaded

Die Road-Context-Daten (ctxtiles + ways) werden als separater Layer in derselben
PMTiles-Datei gespeichert:

- Layer wird nur bei Bedarf (Panel öffnen, Hover) über MapLibre's Source-Konzept geladen
- HTTP Range Request: nur der sichtbare Tile-Bereich wird heruntergeladen
- Keine 1.458 separate JSON-Dateien mehr

---

## 5. Schrittweiser Migrationsplan (Phasen)

### Phase 0 – Übergangssicherung (sofort, ohne Dateiänderungen)

**Ziel**: CI stabilisieren, ohne Formate zu ändern.

1. **CI-Gate für Artefaktgröße verschärfen**: `check-enrichment-size.js` um absolute
   Obergrenzen erweitern (nicht nur relatives Wachstum).
2. **`.gitattributes` prüfen**: Sicherstellen, dass generierte Dateien korrekt als
   `linguist-generated` markiert sind (verhindert zumindest Anzeige in PR-Diffs).
3. **Enrichment-Workflow auf Änderungsprüfung umstellen**: Nur committen, wenn sich
   Dateien tatsächlich geändert haben (bereits in `enrich.yml` teilweise vorhanden).

### Phase 1 – Kurzfristig: GeoJSON gzip + FlatGeobuf (Wochen)

**Ziel**: Sofortige Größenreduktion ohne Frontend-Umbau.

1. `scripts/compress-outputs.sh`: Alle `out/*.geojson` → `out/*.geojson.gz` (brotli/gzip)
   - Frontend erhält per `Content-Encoding: br` transparent komprimierte Dateien
   - Auf GitHub Pages: statische `.gz`-Dateien mit `Accept-Encoding` möglich
2. CSV-Dateien aus Git entfernen (redundant mit GeoJSON) → spart 57 MB
3. Experimentell: FlatGeobuf-Konverter für eine Stadt als Vergleich

**Erwartete Einsparung Phase 1**: GeoJSON 294 MB → ~20 MB (gzip) = **~93 % kleiner**

### Phase 2 – Mittelfristig: PMTiles für Accident-Layer (Monate)

**Ziel**: Viewport-basiertes Laden, keine großen Dateien im Browser.

1. **Tool-Chain aufbauen**:
   - `tippecanoe` als Konvertierungstool (GeoJSON → MBTiles → PMTiles)
   - oder `pmtiles` CLI direkt
   - CI-Job: `enrich.yml` → nach Enrichment direkt PMTiles generieren

2. **Frontend anpassen** (`ua.accident_provider.js`, `ua.data_v2.js`):
   - `TiledAccidentProvider` auf PMTiles-Quelle umstellen
   - `pmtiles` JS-Library einbinden (~60 KB gzip)
   - MapLibre GL JS als Option neben Leaflet

3. **Pro-Stadt-Konvertierung**:
   ```bash
   tippecanoe \
     -o out/pmtiles/<city>.pmtiles \
     -z 16 -Z 5 \
     --drop-densest-as-needed \
     --layer accidents \
     out/output_all_years_<city>.geojson
   ```

4. **ctxtiles ablösen**: Separate PMTiles-Datei (oder zweiter Layer) für Road-Context.

**Erwartete Einsparung Phase 2**: ctxtiles 837 MB → ~30 MB PMTiles = **~96 % kleiner**

### Phase 3 – Langfristig: Full-PMTiles, kein Legacy-GeoJSON mehr

**Ziel**: Nur noch PMTiles und kompakte Metadaten-JSON in Git.

1. Legacy-GeoJSON-Dateien aus Git entfernen, nur noch CI-intern erzeugen
2. `out/metadata/<city>.json` als kompaktes JSON (< 10 KB pro Stadt)
3. Altes `StaticGeoJsonAccidentProvider` durch PMTiles-Provider ersetzen
4. `out/output_all_years.geojson` (20 MB alles) komplett entfernen

---

## 6. Übergangsstrategie für bestehende Dateien

Während der Migration existieren alte und neue Formate parallel:

```
out/
├── output_all_years_<city>.geojson   ← Phase 0 behalten (kein Löschen)
├── output_all_years_<city>.geojson.gz ← Phase 1 hinzufügen
├── pmtiles/<city>.pmtiles             ← Phase 2 hinzufügen
├── ctxtiles/<city>/…                  ← Phase 2 ablösen, Phase 3 löschen
└── metadata/<city>.json               ← Phase 2 hinzufügen
```

**Feature-Flag im Frontend**: `UA.FEATURE_FLAGS.usePMTiles` steuert, ob
`TiledAccidentProvider` oder `StaticGeoJsonAccidentProvider` genutzt wird.
Ermöglicht A/B-Test ohne Breaking Change.

---

## 7. CI-Anpassungen

### 7.1 Was sich ändern muss

| Workflow | Aktuell | Nach Migration |
|----------|---------|---------------|
| `enrich.yml` | Erzeugt GeoJSON + ctxtiles | Erzeugt GeoJSON + PMTiles + ctxtiles (Übergang) |
| `checkjson.yml` | Validiert alle GeoJSON | Validiert nur Metadaten-JSON |
| `generate-and-commit.yml` | Committed GeoJSON-Diffs | Committed PMTiles-Diffs (binär, aber kompakt) |

### 7.2 Git LFS für PMTiles

PMTiles-Dateien sind Binärdateien. Sie sollten in Git LFS gespeichert werden:

```gitattributes
out/pmtiles/*.pmtiles filter=lfs diff=lfs merge=lfs -text
```

Alternativ: PMTiles aus CI auf externen Storage (S3/R2/Cloudflare) pushen und
aus Git entfernen – dann nur noch `out/metadata/` in Git versioniert.

---

## 8. Proof-of-Concept: Kleine Beispiel-Pipeline

Ein minimaler POC-Konvertierungsscript befindet sich unter
`scripts/poc-pmtiles-convert.js`. Er demonstriert:

1. Wie ein GeoJSON-Datensatz in eine kompakte, PMTiles-ähnliche Struktur umgewandelt wird
2. Welche Felder pro Feature minimal nötig sind
3. Wie das neue `metadata/<city>.json` aussieht

Der POC verwendet eine kleine Fixture-Datei (`tests/fixtures/accidents_sample.geojson`,
10 Features) und erzeugt keine großen Output-Dateien.

---

## 9. Risiken und offene Fragen

| Risiko | Bewertung | Mitigierung |
|--------|-----------|-------------|
| Browser-Kompatibilität PMTiles | Niedrig – Range Requests seit 2015 universell | Fallback auf GeoJSON für sehr alte Browser |
| MapLibre statt Leaflet | Mittel – größere Library, andere API | Bestehender `UA.LeafletRenderer` bleibt parallel |
| tippecanoe in CI | Niedrig – einfach per apt-get / brew installierbar | Docker-Image mit tippecanoe vorbereiten |
| Git LFS Kosten | Mittel – GitHub LFS hat Speicherquotas | Externe CDN-Lösung (S3/R2) als Alternative |
| Bestehende Tests/Validierung | Niedrig – `checkjson.yml` anpassen | Schrittweise: Alte Tests bleiben während Übergang |
| Enrichment-Skripte | Niedrig – erzeugen weiterhin GeoJSON intern | GeoJSON nur noch CI-intern, nicht committed |
| Feature-Parität (Filter etc.) | Mittel – MVT Properties müssen alle Filter-Felder enthalten | Felder-Inventur vor Phase 2 |

### Offene Fragen

1. **Git LFS vs. externes CDN**: Sollen PMTiles in Git LFS oder auf einem externen
   Objekt-Speicher (S3, Cloudflare R2) gespeichert werden?
2. **Zoom-Level-Range**: Welche Zoom-Level sind für die Karte sinnvoll? (Empfehlung: Z5–Z16)
3. **Clustering in Tiles**: Sollen Unfallpunkte bei niedrigen Zoom-Leveln geclustered
   werden (z. B. via `--cluster-distance` in tippecanoe)?
4. **Rückwärtskompatibilität**: Wie lange sollen alte GeoJSON-Dateien parallel gehalten werden?
5. **MapLibre GL JS Migration**: Ist eine vollständige Migration von Leaflet zu MapLibre
   gewünscht, oder soll PMTiles über das Leaflet-Plugin genutzt werden?

---

## 10. Zusammenfassung und Empfehlung

**Das aktuelle Format ist nicht skalierbar.** Mit 25 Städten und 1,1 GB an generierten
Artefakten sind Git-Diffs unhandlich, CI-Läufe dauern lang, und der Browser lädt
weit mehr Daten als nötig.

**Empfohlener Weg:**

1. **Sofort** (Phase 0): `.gitattributes` und CI-Gate verbessern, keine neuen
   Enrichment-Artefakte committen, bis Plan klar.
2. **Kurzfristig** (Phase 1): gzip-Kompression für GeoJSON, CSV aus Git entfernen.
3. **Mittelfristig** (Phase 2): PMTiles als primäres Kartenformat einführen,
   `TiledAccidentProvider` nutzen (bereits in `ua.accident_provider.js` angelegt!).
4. **Langfristig** (Phase 3): Nur noch PMTiles in Git/CDN, kein Legacy-GeoJSON mehr.

Die bestehende `TiledAccidentProvider`-Abstraktion in `js/ua.accident_provider.js`
ist bereits der richtige Baustein für PMTiles-Integration – die Architektur ist
also vorbereitet.
