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

| Methode | Pfad                                        | Zweck                                                |
|--------:|---------------------------------------------|------------------------------------------------------|
| GET     | `/api/health`                               | Liveness-Check                                       |
| GET     | `/api/video-export-available`               | Feature-Flag Video-Export                            |
| POST    | `/api/export-video`                         | GIF-Video-Export (Playwright/ffmpeg)                 |
| GET     | `/api/ai-assessment-available`              | Feature-Flag KI (v1) – `GEMINI_API_KEY` gesetzt?     |
| POST    | `/api/ai/export-assessment`                 | KI-Bewertung v1 (Bestand)                            |
| POST    | `/api/ai/export-assessment/v2`              | KI-Bewertung v2 (Modi `assessment` / `proposal-brief`, mit Fallback) |
| POST    | `/api/ai/jobs`                              | Asynchroner Job für v2-Bewertung                     |
| GET     | `/api/ai/jobs/:id`                          | Status / Ergebnis eines Jobs                         |
| GET     | `/api/political-context/supported`          | Liste unterstützter Städte                           |
| POST    | `/api/political-context/search`             | Recherche politischer Vorgänge in Stadt-Portalen     |

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

## 7. Konfiguration – Umgebungs­variablen

| Variable | Standard | Beschreibung |
|---|---|---|
| `PORT` | `8000` | TCP-Port des Express-Servers |
| `BASE_URL` | `http://localhost:${PORT}` | Basis-URL für den Video-Export (interner Playwright-Aufruf) |
| `GEMINI_API_KEY` | – | API-Key für Google Gemini. Ohne Key: KI-Endpunkte fallen auf Fallback (`v2`) bzw. `503` (`v1`) zurück. |
| `AI_PROVIDER` | `gemini` | Auswahl des KI-Providers (zur Zeit nur `gemini`) |
| `AI_ASSESSMENT_MODEL` | `gemini-2.0-flash` | Modellname; geht in den Cache-Key ein |
| `AI_ASSESSMENT_TIMEOUT_MS` | `30000` | Hard-Timeout pro KI-Request (ms) |
| `AI_ASSESSMENT_MAX_RETRIES` | `2` | Retry-Versuche im strukturierten Provider bei `429`/`5xx` |
| `AI_CACHE_PATH` | – (in-memory) | Optionaler Pfad für Persistenz des KI-Antwort-Caches |
| `AI_JOBS_PATH` | – (in-memory) | Optionaler Pfad für Persistenz der Job-Queue |
| `PORTAL_SEARCH_TIMEOUT_MS` | `10000` | HTTP-Timeout für jede Portal-Anfrage der politischen Recherche (ms) |

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
