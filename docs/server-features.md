# Server-Features – API, Konfiguration, Fallback-Verhalten

Dieses Dokument beschreibt die optional verfügbaren Server-Endpunkte der
Unfallwerkbank (`server/index.js`) sowie deren Konfiguration über
Umgebungs­variablen.

> Modulübersicht und Architektur: siehe
> [`docs/architecture.md`](architecture.md),
> [`server/ai/README.md`](../server/ai/README.md) und
> [`server/political-context/README.md`](../server/political-context/README.md).

Server starten:

```bash
npm run start:server         # node server/index.js
# Standard-Port: 8000 (per PORT überschreibbar)
```

---

## 1. Übersicht aller Endpunkte

Die Endpunkte sind nach fachlichen Gruppen sortiert; die ausführliche
Beschreibung folgt in den jeweiligen Abschnitten.

**Plattform / Status**

| Methode | Pfad                              | Zweck                                                |
|--------:|-----------------------------------|------------------------------------------------------|
| GET     | `/api/health`                     | Liveness-Check                                       |
| GET     | `/api/status`                     | **Aggregierte Capability-Übersicht** aller optionalen Features |
| GET     | `/api/video-export-available`     | Feature-Flag Video-Export                            |
| POST    | `/api/export-video`               | GIF-Video-Export (Playwright/ffmpeg, Docker-Distribution) |
| GET     | `/api/ai-assessment-available`    | Feature-Flag KI (v1) – `GEMINI_API_KEY` gesetzt?     |

**Gruppe „AI" – Optionale KI-Bewertung** (siehe §2 – §4)

| Methode | Pfad                              | Zweck                                                |
|--------:|-----------------------------------|------------------------------------------------------|
| POST    | `/api/ai/export-assessment`       | KI-Bewertung v1 (Bestand, kein Fallback)             |
| POST    | `/api/ai/export-assessment/v2`    | KI-Bewertung v2 (Modi `assessment` / `proposal-brief`, mit Fallback) |
| POST    | `/api/ai/jobs`                    | Asynchroner Job für v2-Bewertung                     |
| GET     | `/api/ai/jobs/:id`                | Status / Ergebnis eines Jobs                         |

**Gruppe „political-context" – Politische Recherche** (siehe §5)

| Methode | Pfad                                       | Zweck                                                |
|--------:|--------------------------------------------|------------------------------------------------------|
| GET     | `/api/political-context/supported`         | Liste unterstützter Städte                           |
| POST    | `/api/political-context/search`            | Recherche politischer Vorgänge in Stadt-Portalen     |

**Gruppe „location-brief" – Maßnahmen-Steckbrief je Stelle** (siehe §12)

| Methode | Pfad                              | Zweck                                                |
|--------:|-----------------------------------|------------------------------------------------------|
| POST    | `/api/location-brief`             | Maßnahmen-Steckbrief je Stelle (deterministisch, optional KI-Polish, optionales Persistieren) |

**Gruppe „analysis-service forwarder" – persistierte Reads & Top-N** (siehe §13)

Dünne Forwarder zum separaten Spring-Boot-Dienst.  Ohne
`ANALYSIS_SERVICE_BASE_URL`: `503 ANALYSIS_SERVICE_NOT_CONFIGURED`.

| Methode | Pfad                                                | Zweck                                                |
|--------:|-----------------------------------------------------|------------------------------------------------------|
| GET     | `/api/location-briefs/by-location/:locationKey`     | Persisted reads – alle Briefs einer Stelle, neueste zuerst |
| GET     | `/api/location-briefs/top?city=&profile=&limit=`    | Top-N je Stadt + Profil (sortiert nach Profil-Score) |
| GET     | `/api/location-briefs?city=&profile=&page=&size=`   | Paginierte Liste gespeicherter Briefs einer Stadt    |
| POST    | `/api/batch/jobs/city-prioritization`               | Stadtweiten Spring-Batch-Lauf anstoßen               |
| GET     | `/api/batch/jobs`                                   | Jüngste Lauf-Übersicht                               |
| GET     | `/api/batch/jobs/:executionId`                      | Technischer Status eines Laufs                       |
| GET     | `/api/batch/jobs/:executionId/summary`              | Fachliche Zusammenfassung (Top-N, Counts)            |

**Gruppe „priorities" – Decision-Cards für Top-N und gespeicherte Briefs** (siehe §14)

Verdichten gespeicherte Briefs zu kompakten Entscheidungs­karten.  Liefern
einen einheitlichen Envelope mit stabilem `dataStatus` (`freshly_computed` /
`loaded_from_store` / `persisted` / `fallback_result`); leere Resultate
sind **kein 404**, sondern `{ items: [], empty: true, dataStatus: "loaded_from_store" }`.

| Methode | Pfad                                                | Zweck                                                |
|--------:|-----------------------------------------------------|------------------------------------------------------|
| GET     | `/api/priorities/profiles`                          | Verfügbare Profile + `dataStatus`-Vokabular (kein Service nötig) |
| GET     | `/api/priorities/top?city=&profile=&limit=`         | Top-N als Decision-Cards (Ort, Score, Konfliktmuster, Maßnahme, politischer Hinweis) |
| GET     | `/api/priorities/by-location/:locationKey?profile=` | Gespeicherte Briefs einer Stelle, neuester / passendes Profil zuerst |

Rate-Limits (per IP, 1-Minuten-Fenster):

| Endpunkt                          | Limit |
|-----------------------------------|------:|
| `POST /api/export-video`          |   3/min + max. 2 gleichzeitig |
| `POST /api/ai/export-assessment*` |  10/min |
| `POST /api/ai/jobs`               |  10/min |
| `POST /api/political-context/search` | 20/min |

---

## 2. `POST /api/ai/export-assessment/v2`

### Zweck

Liefert eine KI-gestützte Bewertung oder einen antragsfähigen
Maßnahmen­steckbrief zu einem Export.  Eingabe ist immer das
`structured`-Objekt aus `computeExportReport()` (siehe
[`js/ua.export_v2.js`](../js/ua.export_v2.js)).

Die Antwort wird strikt gegen das hinterlegte JSON-Schema validiert
(`server/ai/schema/exportAssessment.v2.schema.json` bzw.
`proposalBrief.v1.schema.json`).  Bei ungültigem Output erfolgt **ein**
Reparatur­versuch; schlägt auch dieser fehl, greift der Fallback (siehe
unten).

### Request

```http
POST /api/ai/export-assessment/v2?mode=assessment
Content-Type: application/json
```

```jsonc
{
  "structured":   { /* Output aus computeExportReport() */ },
  "contextHints": {
    "knownHazards":   ["Schienen quer zur Fahrtrichtung"],
    "locationHints":  ["Limmerstraße / Leinaustraße"],
    "surfaceHints":   ["Kopfsteinpflaster"],
    "notes":          ["Vor 18 Uhr Lieferverkehr"]
  },
  "mode":         "assessment",       // optional, alternativ ?mode=...
  "withFallback": true                 // optional, Standard true
}
```

Gültige Modi: `assessment` (Standard), `proposal-brief`.

### Response

```jsonc
{
  "mode":     "assessment",
  "source":   "ai",                // ai | ai-repaired | cache | fallback
  "cacheKey": "<sha256>",
  "result":   { /* Schema-konformer Output */ }
}
```

Bei Fallback enthält die Antwort zusätzlich `fallbackReason: "<Klartext>"`.

### Fehlerfälle

| Status | Bedingung                                                        |
|------:|-------------------------------------------------------------------|
| `400` | `structured` fehlt / kein Objekt; ungültiger `mode`               |
| `429` | Rate-Limit überschritten                                          |
| `503` | `GEMINI_API_KEY` fehlt **und** `withFallback: false`              |
| `500` | sonstige interne Fehler                                           |

### Verhalten ohne API-Key / bei Timeout / im Fallback

| Situation                              | Antwort                                                              |
|----------------------------------------|----------------------------------------------------------------------|
| `GEMINI_API_KEY` nicht gesetzt, `withFallback: true` (Standard) | `200 OK`, `source: "fallback"`, deterministischer Output (ohne KI-Texte) |
| `GEMINI_API_KEY` nicht gesetzt, `withFallback: false`           | `503 Service Unavailable`                                            |
| Provider-Timeout (`AI_ASSESSMENT_TIMEOUT_MS`, Standard 30 s)    | Retry/Backoff bis `AI_ASSESSMENT_MAX_RETRIES`, dann Fallback bzw. `500` |
| HTTP `429`/`5xx` vom Provider          | Retry/Backoff im Provider; danach Fallback bzw. `500`                |
| Antwort verletzt Schema                | Genau ein Reparatur­versuch; bleibt sie ungültig → Fallback bzw. `500` |
| Identische Anfrage erneut              | `source: "cache"` (sha256-Cache, TTL 1 h)                            |

---

## 3. `POST /api/ai/export-assessment` (v1, Bestand)

Bestand für ältere Frontend-Pfade.

- Erfordert `GEMINI_API_KEY` (sonst `503`).
- **Kein** Fallback, **kein** Cache, **keine** Job-Variante.
- Antwort: `{ "assessment": ExportAssessmentOutput }`.

Für neue Integrationen wird **v2** empfohlen.

---

## 4. KI-Jobs (asynchron)

Für längere Modell-Aufrufe oder Free-Tier-Drosselung kann der v2-Aufruf
asynchron verlaufen:

```http
POST /api/ai/jobs
Content-Type: application/json

{
  "kind":    "export-assessment-v2",
  "payload": { /* Body wie POST /api/ai/export-assessment/v2 */ }
}
```

Antwort: `202 Accepted` mit `{ id, status, kind, submittedAt }`.

Status / Ergebnis abrufen:

```http
GET /api/ai/jobs/:id
```

Antwort: `{ id, kind, status: 'queued'|'running'|'done'|'error',
submittedAt, startedAt?, finishedAt?, result?, error? }`.

`result` entspricht im Erfolgsfall dem Body des synchronen v2-Endpunkts.

---

## 5. `POST /api/political-context/search`

### Zweck

Recherchiert in den Rats-/Bürgerinformations­portalen einer unterstützten
Stadt nach politischen Vorgängen (Anträge, Anfragen, Beschlüsse,
Verwaltungsantworten, Protokollnotizen) zu einer Liste von Suchbegriffen.

### Request

```http
POST /api/political-context/search
Content-Type: application/json
```

```jsonc
{
  "city":        "Hannover",
  "searchTerms": ["Limmerstraße", "Stadtbezirk Linden"],
  "context": {
    "gremium":  "Stadtbezirksrat Linden-Limmer",
    "location": "Limmerstraße / Leinaustraße"
  },
  "maxResults": 10           // optional, Standard 10, Hard-Cap 30
}
```

### Response

```jsonc
{
  "references": [
    {
      "id":             "abc123def456abc1",
      "title":          "Antrag zur Verkehrsberuhigung Limmerstraße",
      "type":           "Antrag",
      "date":           "15.03.2024",
      "gremium":        "Stadtbezirksrat Linden-Limmer",
      "number":         "DS 2024-0042",
      "snippet":        "Beantragung einer Tempo-30-Zone …",
      "url":            "https://e-government.hannover-stadt.de/…",
      "source":         "hannover-sim",
      "relevanceScore": 87,
      "referenceType":  "Antrag",
      "reason":         "Suchbegriff „Limmerstraße\" im Titel.",
      "locationMatch":  "street",
      "topicMatch":     ["Limmerstraße"],
      "streetHints":    ["limmerstraße"],
      "areaHints":      []
    }
  ],
  "meta": {
    "city":        "Hannover",
    "searchTerms": ["Limmerstraße", "Stadtbezirk Linden"],
    "searchedAt":  "2026-04-23T18:00:00.000Z",
    "totalFound":  5,
    "providerKey": "hannover-sim",
    "supported":   true
  }
}
```

Liste der unterstützten Städte:

```http
GET /api/political-context/supported
→ { "cities": ["hannover", "berlin", "bonn", "hamburg"] }
```

### Fehlerfälle

| Status | Bedingung                                                                   |
|------:|------------------------------------------------------------------------------|
| `400` | `city` fehlt/leer; `searchTerms` fehlt oder enthält keine gültigen Strings   |
| `429` | Rate-Limit überschritten                                                     |
| `500` | Interner Fehler in der Orchestrierung (nicht im Provider, siehe unten)       |

### Verhalten bei Timeout / unsupported / leerer Trefferliste

| Situation                                 | Antwort |
|-------------------------------------------|---------|
| Stadt nicht unterstützt                    | `200 OK` mit `meta.supported: false`, `references: []` |
| Portal-Timeout (`PORTAL_SEARCH_TIMEOUT_MS`, Standard 10 s) oder HTTP-Fehler | Provider liefert leeres Array; Antwort `200 OK` mit `references: []` und `meta.totalFound: 0` |
| Suchbegriffe werden auf max. 200 Zeichen gekürzt, leere/Nicht-Strings entfernt | – (Sanitisierung) |
| `maxResults` wird auf `[0..30]` gekappt   | – |

Eine fehlgeschlagene Portal-Anfrage führt **nicht** zu einem `5xx`, damit
der Aufrufer eine konsistente, leere Liste verarbeiten kann.

---

## 6. `POST /api/export-video` (Docker-Distribution)

Erzeugt animiertes GIF des aktuellen Werkbank-Zustands.

- Body: aktuelle URL-Parameter der Werkbank (Stadt, Filter, Karten­position
  …).  Siehe Inline-Doku in [`server/index.js`](../server/index.js).
- Antwort: `image/gif` als Download.
- Limit: 3 Requests/min/IP, max. `MAX_CONCURRENT = 2` parallele Jobs
  (sonst `429`).
- Voraussetzung: Playwright + Chromium + ffmpeg vorhanden (im
  Docker-Image enthalten).

---

## 7. `GET /api/status` – aggregierte Capability-Übersicht

Single-Call-Endpunkt für Frontend, Doku und Smoke-Tests.  Liefert pro
optionalem Feature einen strukturierten Capability-Eintrag mit
maschinenlesbarem `reasonCode`.  Die bestehenden Single-Feature-Flag-
Endpunkte (`/api/ai-assessment-available`, `/api/video-export-available`,
`/api/political-context/supported`) bleiben aus Kompatibilitätsgründen
unverändert verfügbar.

### Response (Beispiel ohne API-Key)

```jsonc
{
  "status":    "ok",
  "timestamp": "2026-04-24T17:48:33.658Z",
  "version":   "2.0.0",
  "uptimeSec": 2,
  "capabilities": {
    "aiAssessmentV1": {
      "available":  false,
      "reasonCode": "missing_api_key",
      "reason":     "GEMINI_API_KEY fehlt – KI-Bewertung v1 ist nicht verfügbar."
    },
    "aiAssessmentV2": {
      "available":  true,
      "reasonCode": "missing_api_key",
      "reason":     "GEMINI_API_KEY fehlt – v2 liefert deterministischen Fallback ohne KI-Texte.",
      "details":    { "aiCallEnabled": false, "provider": "gemini", "fallback": true }
    },
    "politicalContext": {
      "available":  true,
      "reasonCode": "ok",
      "reason":     "4 unterstützte Stadt-Portale registriert.",
      "details":    { "cities": ["hannover", "berlin", "bonn", "hamburg"] }
    },
    "videoExport": {
      "available":  true,
      "reasonCode": "server_only_feature",
      "reason":     "Video-Export erfordert den Server und (in der Praxis) das Docker-Image.",
      "details":    { "dockerRecommended": true }
    }
  }
}
```

### `reasonCode`-Werte

| Code                    | Bedeutung                                                              |
|-------------------------|------------------------------------------------------------------------|
| `ok`                    | Feature ist regulär verfügbar                                          |
| `missing_api_key`       | Erforderlicher API-Key (`GEMINI_API_KEY`) fehlt                        |
| `provider_disabled`     | Provider per Konfiguration deaktiviert (`AI_PROVIDER=null`)            |
| `server_only_feature`   | Feature setzt den Server (oder Docker-Image) voraus                    |
| `not_configured`        | Feature ist im Code vorhanden, aber nicht konfiguriert                 |
| `upstream_timeout`      | Reserviert für künftige Health-Probes                                  |

> Implementierung: [`server/lib/capabilities.js`](../server/lib/capabilities.js)

---

## 8. Einheitliches Fehler-Envelope

Alle optionalen Server-Features liefern Fehler­antworten in einem
einheitlichen Schema.  Bestehende Aufrufer können wie bisher `body.error`
auswerten; zusätzlich stehen jetzt zwei Felder zur Verfügung, mit denen
das Frontend gezielter reagieren kann:

```jsonc
{
  "error":    "Pflichtfeld \"city\" fehlt oder ist leer.",  // Klartext für UI
  "code":     "CITY_REQUIRED",                                // maschinenlesbar
  "category": "invalid_request"                                // s. Tabelle unten
}
```

| `category`             | Empfohlener HTTP-Status | Bedeutung                                        |
|------------------------|------------------------:|--------------------------------------------------|
| `feature_unavailable`  |                     503 | Feature ist nicht konfiguriert (z. B. KI v1 ohne Key) |
| `upstream_error`       |                     502 | Upstream/Provider hat geantwortet, aber fehlerhaft |
| `invalid_request`      |                     400 | Pflichtfelder fehlen oder sind ungültig          |
| `rate_limited`         |                     429 | Rate-Limit pro IP überschritten                  |
| `internal_error`       |                     500 | unerwarteter interner Fehler                     |
| `fallback_returned`    |                     200 | Erfolgs­antwort, aber semantisch ein Fallback (siehe `body.fallback`) |

Erfolgs­antworten mit Fallback (KI v2 ohne Key) enthalten zusätzlich einen
`fallback`-Block, der die Originalantwort *nicht* verändert:

```jsonc
{
  "mode":   "assessment",
  "source": "fallback",
  "result": { /* … */ },
  "fallback": {
    "code":     "AI_FALLBACK_USED",
    "message":  "KI nicht verfügbar – deterministischer Fallback wurde geliefert.",
    "category": "fallback_returned",
    "details":  { "aiCallEnabled": false }
  }
}
```

> Implementierung: [`server/lib/errors.js`](../server/lib/errors.js)

---

## 9. Persistenz-Schnittstellen (Vorbereitung)

Damit AI-Cache, political-context-Cache und Job-Persistenz später
einheitlich auf eine echte Persistenz (Redis, SQLite, …) umgestellt
werden können, gibt es eine schmale, synchrone Key-Value-Schnittstelle:

| Modul                                                      | Heute (in-memory + optional JSON-Disk)                          |
|------------------------------------------------------------|------------------------------------------------------------------|
| [`server/lib/keyValueStore.js`](../server/lib/keyValueStore.js)             | Generische Schnittstelle (TTL, LRU, atomare Disk-Persistenz)     |
| [`server/ai/cache/aiAssessmentCache.js`](../server/ai/cache/aiAssessmentCache.js) | KI-Antwort-Cache (sha256-Key); Pfad via `AI_CACHE_PATH`          |
| [`server/ai/jobs/aiJobQueue.js`](../server/ai/jobs/aiJobQueue.js)           | Async-Job-Queue mit Statuspersistenz; Pfad via `AI_JOBS_PATH`    |
| [`server/political-context/services/portalSearchCache.js`](../server/political-context/services/portalSearchCache.js) | Cache für politische Recherche; Pfad via `POLITICAL_CONTEXT_CACHE_PATH` |

In dieser Iteration wird **keine** externe Datenbank eingeführt – alle
Caches bleiben in-memory mit optionaler JSON-Datei.  Die Schnittstelle ist
aber stabil genug, um später Adapter (z. B. Redis) ohne Änderung der
Aufrufer einzuhängen.

---

## 10. Smoke-Tests

Für die manuelle Release-Prüfung gibt es einen kleinen Helfer:

```bash
npm run smoke                  # gegen http://localhost:8000
BASE=http://host:port npm run smoke
```

Geprüft werden: `/api/health`, `/api/status`, die bestehenden
Single-Feature-Flag-Endpunkte, das Fehler-Envelope der
politischen Recherche und der KI v2 Fallback-Pfad.  Skript:
[`scripts/smoke.sh`](../scripts/smoke.sh).

---

## 11. Konfiguration – Umgebungs­variablen

| Variable | Standard | Beschreibung |
|---|---|---|
| `PORT` | `8000` | TCP-Port des Express-Servers |
| `BASE_URL` | `http://localhost:${PORT}` | Basis-URL für den Video-Export (interner Playwright-Aufruf) |
| `GEMINI_API_KEY` | – | API-Key für Google Gemini. Ohne Key: KI-Endpunkte fallen auf Fallback (`v2`) bzw. `503` (`v1`) zurück. |
| `AI_PROVIDER` | `gemini` | Auswahl des KI-Providers (`gemini` oder `null` zum Deaktivieren) |
| `AI_ASSESSMENT_MODEL` | `gemini-2.0-flash` | Modellname; geht in den Cache-Key ein |
| `AI_ASSESSMENT_TIMEOUT_MS` | `30000` | Hard-Timeout pro KI-Request (ms) |
| `AI_ASSESSMENT_MAX_RETRIES` | `2` | Retry-Versuche im strukturierten Provider bei `429`/`5xx` |
| `AI_CACHE_PATH` | – (in-memory) | Optionaler Pfad für Persistenz des KI-Antwort-Caches |
| `AI_JOBS_PATH` | – (in-memory) | Optionaler Pfad für Persistenz der Job-Queue |
| `PORTAL_SEARCH_TIMEOUT_MS` | `10000` | HTTP-Timeout für jede Portal-Anfrage der politischen Recherche (ms) |
| `POLITICAL_CONTEXT_CACHE_PATH` | – (in-memory) | Optionaler Pfad für Persistenz des political-context-Caches |
| `POLITICAL_CONTEXT_CACHE_TTL_MS` | `600000` | TTL für den political-context-Cache (ms) |
| `POLITICAL_CONTEXT_CACHE_MAX` | `100`    | Maximale Einträge im political-context-Cache (LRU) |

### Default-Verhalten ohne weitere Konfiguration

- Server läuft auf `:8000` und liefert `werkbank_v2.html` aus.
- `/api/health`, `/api/video-export-available`, `/api/ai-assessment-available`,
  `/api/political-context/supported` antworten sofort.
- KI-Bewertungs­endpunkte antworten:
  - **v2** mit `source: "fallback"` (deterministischer, datengestützter
    Output ohne KI-Texte) – als wäre KI ein optionales Add-on.
  - **v1** mit `503` und Hinweis, dass `GEMINI_API_KEY` fehlt.
- Politische Recherche funktioniert für die unterstützten Städte;
  bei externen Portal-Ausfällen erhält der Client eine leere Trefferliste
  und kann den Export trotzdem fertigstellen.

### Sicherheits- und Persistenz-Hinweise

- `GEMINI_API_KEY` darf **nicht** in das Repository, in Docker-Images oder in
  Frontend-Bundles gelangen. Übergabe ausschließlich über
  Umgebungs­variablen (`-e GEMINI_API_KEY=...` bzw. Secret-Mechanismen).
- Cache- und Job-Dateien (`AI_CACHE_PATH`, `AI_JOBS_PATH`) können
  Eingaben aus Exports enthalten – Pfad daher nur an vertrauenswürdige
  Stellen legen.
- Provider-URLs der politischen Recherche sind hartkodiert; Stadt-/
  Suchwert kommen ausschließlich als Query-Parameter in die jeweilige
  Portal-URL → keine SSRF-Angriffsfläche.

---

## 12. Gruppe „location-brief" – `POST /api/location-brief`

### Zweck

Erzeugt für eine einzelne Stelle einen **deterministischen
Maßnahmen-Steckbrief** (Konfliktmuster, vorausgewählte Maßnahmen,
Profil-Score).  KI ist nur eine optionale Veredelung (`aiPolish`); der
Brief funktioniert ohne `GEMINI_API_KEY` und ohne Analysis Service.

Quelle: [`server/location-brief/`](../server/location-brief/),
[`docs/LOCATION_BRIEF.md`](LOCATION_BRIEF.md).

### Request

```http
POST /api/location-brief
Content-Type: application/json
```

```jsonc
{
  "structured":   { /* Output aus computeExportReport() */ },
  "locationId":   "hannover::altenbekener_damm",   // stabile Stellen-ID (empfohlen)
  "profile":      "low_hanging_fruit",             // optional, Default greift
  "contextHints": { /* optional, wie bei /api/ai/export-assessment/v2 */ },
  "politicalContext": { /* optional, Ergebnis aus political-context */ },
  "aiPolish":     { /* optional: KI-Veredelung an/aus, Modus */ },
  "persist":      true,        // optional: an Analysis Service forwarden
  "useStored":    true         // optional: zuerst gespeicherten Brief verwenden
}
```

### Typische Response

```jsonc
{
  "schemaVersion":    "locationActionBrief.v1",
  "locationKey":      "hannover::altenbekener_damm",
  "profileKey":       "low_hanging_fruit",
  "conflictPatterns": [ /* … */ ],
  "candidateMeasures": [ /* … */ ],
  "profileScores":    { /* … */ },
  "versioning":       { "rulesVersion": "conflictPatterns.v1", /* … */ },
  "persistence": {
    "status":           "freshly_computed",   // s. Tabelle unten
    "persisted":        false,
    "persistRequested": false,
    "attempts":         0
  }
}
```

### Persistenz-Lebenszyklus (`persistence.status`)

| Status              | Bedeutung                                                            |
|---------------------|----------------------------------------------------------------------|
| `freshly_computed`  | Brief frisch berechnet, kein Persist gewünscht/aktiv.                |
| `loaded_from_store` | `useStored=true` → bestehender Brief aus dem Service geliefert.      |
| `persisted`         | Brief berechnet **und** erfolgreich persistiert.                     |
| `persist_skipped`   | Persist gewünscht, aber Service nicht erreichbar/aktiviert.          |

### Fallback-Verhalten

- **Ohne Analysis Service** (Standard): Brief wird berechnet und
  zurückgegeben, `persistence.status: "freshly_computed"`.
- **Mit `persist: true`, Service nicht erreichbar / 5xx**:
  Brief wird trotzdem zurückgegeben,
  `persistence.status: "persist_skipped"`, `reason` enthält den
  Fehlergrund.  Es gibt **kein** `5xx` aus diesem Endpunkt allein wegen
  Persistenzproblemen.
- **`useStored: true`** mit Treffer im Service: kein Recompute, Antwort
  enthält `source: "analysis-service"` und den gespeicherten Brief
  (`persistence.status: "loaded_from_store"`).

### Fehlerfälle

| Status | Bedingung                                                     |
|------:|----------------------------------------------------------------|
| `400` | `structured` fehlt / kein Objekt; unbekanntes `profile`        |
| `429` | Rate-Limit überschritten                                       |
| `500` | unerwarteter interner Fehler beim Erzeugen des Briefs          |

---

## 13. Gruppe „analysis-service forwarder" – Persisted Reads, Top-N, Batch

Die folgenden Endpunkte sind **dünne Forwarder** auf den separaten
Spring-Boot-Dienst (`analysis-service/`).  Sie erlauben es der Node-App,
gespeicherte Briefs wieder abzurufen und stadtweit zu vergleichen, ohne
selbst Persistenz zu betreiben.  Ohne konfigurierten Analysis Service
antworten sie mit `503 ANALYSIS_SERVICE_NOT_CONFIGURED`; bei
Upstream-Fehlern mit `502 upstream_error`.

| Modus                     | Voraussetzung                                                  | Verhalten                                                                                                  |
|---------------------------|----------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| **Browser-only**          | keine                                                          | Werkbank läuft komplett im Browser, keine Server-Aufrufe.                                                  |
| **Node-Standalone**       | `npm run start:server`                                         | `POST /api/location-brief` berechnet, **persistiert nicht**.  Forwarder antworten `503`.                   |
| **Node + Analysis Service** | zusätzlich `ANALYSIS_SERVICE_BASE_URL` gesetzt              | Persistieren, Lesen, Top-N, Batch-Anstoß sind verfügbar.                                                   |

### Konfiguration

| Variable                         | Default | Beschreibung                                                                  |
|----------------------------------|---------|-------------------------------------------------------------------------------|
| `ANALYSIS_SERVICE_BASE_URL`      | –       | Basis-URL des Analysis Service, z. B. `http://analysis-service:8081`. Aktiviert das Feature implizit. |
| `ANALYSIS_SERVICE_ENABLED`       | `true`  | Override – `false` deaktiviert das Forwarding trotz vorhandener `BASE_URL`.   |
| `ANALYSIS_SERVICE_TIMEOUT_MS`    | `4000`  | HTTP-Timeout pro Aufruf (ms).                                                 |
| `ANALYSIS_SERVICE_RETRIES`       | `1`     | Anzahl Wiederholungen bei 5xx oder Netzwerkfehlern (4xx wird **nicht** wiederholt). |
| `ANALYSIS_SERVICE_RETRY_DELAY_MS`| `200`   | Wartezeit zwischen Retries (ms).                                              |
| `ANALYSIS_SERVICE_AUTO_PERSIST`  | `false` | Wenn `true`, wird `POST /api/location-brief` ohne explizites `persist`-Flag automatisch persistiert. |

Der aktuelle Status (konfiguriert / aktiviert / Basis-URL) ist über
`GET /api/status` unter `capabilities.analysisService` sichtbar; die
unterstützten Batch-Jobs unter `capabilities.batchJobs.supportedJobs`.

### 13.1 Persisted reads – Briefs einer Stelle wieder abrufen

```http
GET /api/location-briefs/by-location/:locationKey
```

**Zweck:** alle gespeicherten Versionen einer Stelle, neueste zuerst.

**Beispiel:**

```bash
curl http://localhost:8000/api/location-briefs/by-location/hannover::altenbekener_damm
```

**Typische Response:** 1:1 Antwort des Analysis Service – Array von
gespeicherten Briefs mit `id`, `createdAt`, `profileKey`,
`schemaVersion`, `versioning`, `sourceFingerprint` u. a.  Bei `404`
liefert die Node-App ein leeres Array `[]`.

### 13.2 Persisted reads – paginierte Stadtansicht

```http
GET /api/location-briefs?city=Hannover&profile=safety_first&page=0&size=20
```

**Zweck:** alle Briefs einer Stadt, optional nach Profil gefiltert,
paginiert.

**Fallback:** ohne konfigurierten Service `503`; bei Upstream-Fehler
`502`; sonst Array (paginiert) wie vom Analysis Service geliefert.

### 13.3 Top-N je Stadt + Profil

```http
GET /api/location-briefs/top?city=Hannover&profile=low_hanging_fruit&limit=10
```

**Zweck:** Ranking der **Top-N Stellen** einer Stadt nach Profil-Score.
Grundlage für stadtweite Priorisierung („Welche Stellen zuerst?").

**Beispiel:**

```bash
curl "http://localhost:8000/api/location-briefs/top?city=Hannover&profile=safety_first&limit=5"
```

**Typische Response:** Array der Top-N Briefs, sortiert nach dem
profilspezifischen Gesamt-Score (höchster zuerst).

### 13.4 Batch-Jobs (stadtweite Verarbeitung)

| Methode | Pfad                                                | Zweck                                                                  |
|---------|-----------------------------------------------------|------------------------------------------------------------------------|
| POST    | `/api/batch/jobs/city-prioritization`               | Startet den `city-prioritization-job`.  Body: `{city, profile, recomputeExisting?, limit?, runLabel?}` – `city` und `profile` sind Pflicht.  Antwort: `{jobName, executionId, status}`. |
| GET     | `/api/batch/jobs`                                   | Jüngste Lauf-Übersicht (fachlich, aus `analysis_job`).                 |
| GET     | `/api/batch/jobs/:executionId`                      | Technischer Status (Steps, Exit-Codes, Zeitstempel).                   |
| GET     | `/api/batch/jobs/:executionId/summary`              | Fachliche Zusammenfassung (Top-N, Counts, Fehler).                     |

**Beispiel:**

```bash
curl -X POST http://localhost:8000/api/batch/jobs/city-prioritization \
  -H 'Content-Type: application/json' \
  -d '{"city":"Hannover","profile":"low_hanging_fruit","limit":50,"runLabel":"monatlich"}'
```

Validation-Fehler kommen über den vorhandenen `error`-Envelope mit
`category: "validation"` zurück; Konflikte (Job läuft, Instance bereits
abgeschlossen) als `409` mit maschinenlesbarem `code` (siehe
[`analysis-service/README.md`](../analysis-service/README.md#bekannte-fehlermodi)).

### 13.5 Wann reicht Browser-only, wann Node, wann Persistenz?

- **Browser-only** (GitHub Pages Live-Demo): einzelne Analysen,
  Bezirksrats-Export – die häufigste Nutzung.
- **Node-Standalone**: lokales Hosten, Video-Export, KI-Bewertung,
  politische Recherche, Brief-Berechnung – ohne Persistenzbedarf.
- **Node + Analysis Service**: stadtweite Vergleiche, Top-N-Listen
  pro Profil, reproduzierbare Briefs (versioniert mit Source-
  Fingerprint, Regelversionen, optional KI-Metadaten).

### Migrationen & Health

- Schema-Migrationen liegen in
  `analysis-service/src/main/resources/db/migration/V*__*.sql` und
  laufen beim Boot über **Flyway** (PostgreSQL in Prod, H2 im
  PostgreSQL-Mode in Dev/Test).
- Health-Probe: `GET http://<analysis-service>/actuator/health`
  (Container-Health-Check und Reverse-Proxy-tauglich).
- Lokales Compose mit PostgreSQL:

  ```bash
  docker compose --profile persist up
  ```

## 14. Gruppe „priorities" – Decision-Cards für die Prioritätenansicht

Die Endpunkte unter `/api/priorities/*` verdichten die Roh-Antworten des
Analysis Service zu **kompakten Entscheidungs­karten** für die Werkbank.
Sie sind reine *Lese*-Endpunkte und beantworten die zentralen
Produkt-Fragen:

> **Welche Stelle ist wichtig? Warum? Welche Maßnahme ist plausibel?
> Ist das frisch berechnet oder aus Persistenz?**

Im Gegensatz zu den 1:1-Forwardern unter `/api/location-briefs/*`
liefern sie:

- ein **einheitliches Antwort-Envelope** mit `mode`, `count`, `empty`,
  `items[]`, `dataStatus` (siehe Vokabular unten) und optional
  `fallbackReason`,
- pro Eintrag eine **stabile Decision-Card-Struktur** (Ort, Profil,
  zentrale Scores, Konfliktmuster, empfohlene Maßnahmen, politischer
  Kontext-Hinweis),
- **kein 404 für leere Resultate** – stattdessen `{ items: [], empty: true,
  dataStatus: "loaded_from_store" }`, damit die UI klar zwischen „keine
  gespeicherten Briefs" und „Persistenz nicht erreichbar" unterscheiden
  kann.

Ohne konfigurierten Analysis Service gilt **graceful degradation**:
statt 503 antworten die Endpunkte mit `dataStatus: "fallback_result"`
und einem `fallbackReason` – die Werkbank bleibt nutzbar.

### 14.1 Stabiler `dataStatus`-Vertrag

Vier Werte beschreiben die Herkunft eines Ergebnisses; der String selbst
ist Teil des API-Vertrags und ändert sich nicht (vgl.
[`server/priorities/index.js`](../server/priorities/index.js)):

| `dataStatus`         | Bedeutung                                                              |
|----------------------|------------------------------------------------------------------------|
| `freshly_computed`   | Frisch berechnet, **nicht** persistiert.                               |
| `loaded_from_store`  | Aus dem Analysis Service gelesen (Top-N oder by-location).             |
| `persisted`          | Frisch berechnet **und** erfolgreich persistiert.                      |
| `fallback_result`    | Persistenz war gewünscht, aber nicht möglich; Ergebnis aus Fallback.   |

`POST /api/location-brief` ergänzt jede Antwort additiv um dieses Feld
(neben dem bestehenden `persistence.status`-Block; das alte Feld bleibt
unverändert).

### 14.2 `GET /api/priorities/profiles`

Liefert die unterstützten Profile und das `dataStatus`-Vokabular für
UI-Dropdowns und Status-Anzeigen.  **Hängt nicht** vom Analysis Service
ab, funktioniert auch im Browser-only-/Node-Standalone-Modus.

```bash
curl http://localhost:8000/api/priorities/profiles
```

```json
{
  "profiles": ["low_hanging_fruit", "bicycle_safety_priority", "..."],
  "defaultProfile": "low_hanging_fruit",
  "dataStatusValues": ["freshly_computed", "loaded_from_store", "persisted", "fallback_result"]
}
```

### 14.3 `GET /api/priorities/top?city=&profile=&limit=`

Top-N gespeicherte Briefs einer Stadt für ein Profil als Decision-Cards.

```bash
curl "http://localhost:8000/api/priorities/top?city=Hannover&profile=low_hanging_fruit&limit=5"
```

```json
{
  "mode": "top",
  "dataStatus": "loaded_from_store",
  "count": 1,
  "empty": false,
  "items": [
    {
      "id": "b-1",
      "locationKey": "hannover::altenbekener_damm",
      "city": "Hannover",
      "title": "Maßnahmensteckbrief: Altenbekener Damm",
      "profileKey": "low_hanging_fruit",
      "confidence": 0.72,
      "score": { "total": 78, "subScores": { "quickWinScore": 0.9 } },
      "conflictPatterns": [
        { "id": "right_turn_conflict", "label": "Rechtsabbiegekonflikt",
          "classification": "primary", "confidence": "high" }
      ],
      "recommendedMeasures": [
        { "id": "protected_bike_lane", "title": "Geschützte Radspur",
          "fitScore": 0.9, "costBand": "high", "effort": "medium" }
      ],
      "political": { "count": 2, "hasHighRelevance": true }
    }
  ],
  "query": { "city": "Hannover", "profile": "low_hanging_fruit", "limit": 5 }
}
```

### 14.4 `GET /api/priorities/by-location/:locationKey?profile=`

Alle gespeicherten Briefs einer Stelle, **neuester / passendes Profil
zuerst**.  Selbes Envelope wie 14.3.  Kein Treffer → `empty: true`.

```bash
curl "http://localhost:8000/api/priorities/by-location/hannover::altenbekener_damm?profile=safety_first"
```

### 14.5 Fehler- und Fallback-Verhalten

| Situation                                     | HTTP | `dataStatus`        | `fallbackReason`                  |
|-----------------------------------------------|------|---------------------|-----------------------------------|
| Erfolg, Treffer vorhanden                     | 200  | `loaded_from_store` | –                                 |
| Erfolg, leer / Upstream 404                   | 200  | `loaded_from_store` | – (`empty: true`)                 |
| Analysis Service nicht konfiguriert           | 200  | `fallback_result`   | `analysis_service_unconfigured`   |
| Analysis Service deaktiviert                  | 200  | `fallback_result`   | `analysis_service_disabled`       |
| Analysis Service erreichbar, aber 5xx/Timeout | 200  | `fallback_result`   | aus dem Client (`http_503`, …)    |
| Pflicht-Parameter fehlt                       | 400  | – (`error`-Envelope) | – (Validierungsfehler, kein Fallback) |

