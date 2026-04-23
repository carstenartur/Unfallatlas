# `server/ai/` – Optionale KI-Erweiterung

Diese Schicht stellt eine **optionale, serverseitige** KI-Bewertung für den
Unfallatlas-Export bereit.  Sie ist klar gekapselt:

* keine KI-Logik im Frontend
* keine direkten Browser-Aufrufe an Modellanbieter
* keine Kopplung an die Word-/PDF-Renderer

Bestehende deterministische Tabellen, Kennzahlen und Metadaten bleiben **immer
führend**.  Die KI ergänzt nur Bewertung, Hypothesen, Maßnahmen und
Formulierungsbausteine.

---

## Endpunkte

| Methode | Pfad                                | Zweck                                          |
|--------:|-------------------------------------|------------------------------------------------|
| GET     | `/api/ai-assessment-available`      | Feature-Flag (`{available: bool}`)             |
| POST    | `/api/ai/export-assessment`         | v1-Bewertung (Bestand)                         |
| POST    | `/api/ai/export-assessment/v2`      | v2-Bewertung mit zwei Modi (siehe unten)       |

### v2-Modi (Query- oder Body-Parameter `mode`)

* `assessment` *(Standard)* – fachliche Bewertung gemäß
  [`schema/exportAssessment.v2.schema.json`](./schema/exportAssessment.v2.schema.json)
* `proposal-brief` – antragsfähiger Maßnahmensteckbrief gemäß
  [`schema/proposalBrief.v1.schema.json`](./schema/proposalBrief.v1.schema.json)

Body:

```jsonc
{
  "structured":   { /* Output von computeExportReport() */ },
  "contextHints": { "knownHazards":[], "locationHints":[], "surfaceHints":[], "notes":[] },
  "mode":         "assessment",   // optional; auch ?mode=...
  "withFallback": true            // optional, Standard true
}
```

Antwort:

```jsonc
{
  "mode":     "assessment",
  "source":   "ai" | "ai-repaired" | "cache" | "fallback",
  "cacheKey": "<sha256>",
  "result":   { /* Schema-konformer Output */ }
}
```

---

## Module

| Modul                                                | Aufgabe                                                      |
|------------------------------------------------------|--------------------------------------------------------------|
| `aiAssessmentServiceV2.js`                           | Orchestriert: Features → Vorselektion → Prompt → Provider → Validierung → Cache |
| `features/deriveFeatures.js`                         | Berechnet KSI, Beteiligungsanteile, dominante Muster, Trend, räumliche Verdichtung, Tags |
| `catalog/measureCatalog.js`                          | Maßnahmenbibliothek (Quick Wins, Infrastruktur, Organisatorisch, Monitoring) |
| `scoring/preselectMeasures.js`                       | Deterministische Vorselektion plausibler Maßnahmen aus dem Katalog |
| `prompts/exportAssessmentPrompt.v2.js`               | System- + Nutzerprompt-Builder für beide Modi               |
| `providers/geminiStructuredProvider.js`              | Gemini-Adapter mit `responseSchema`, Retry/Backoff          |
| `cache/aiAssessmentCache.js`                         | In-Memory-Cache (sha256 + TTL + LRU)                         |
| `jobs/aiJobQueue.js`                                 | Einfache Concurrency-Queue (Stub für späteren Folge-PR)     |
| `schema/exportAssessment.v2.schema.json`             | Schema für Modus `assessment`                                |
| `schema/proposalBrief.v1.schema.json`                | Schema für Modus `proposal-brief`                            |

Bestand (v1, unverändert):
`aiAssessmentService.js`, `prompts/exportAssessmentPrompt.js`,
`providers/geminiProvider.js`, `schema/exportAssessment.schema.json`.

---

## Datenfluss v2

```
            structured (computeExportReport)
                          │
                          ▼
            deriveFeatures()      ← contextHints (normalisiert)
                          │
                          ▼
              preselectMeasures()  ← measureCatalog
                          │
                          ▼
              buildAiInputV2()  →  buildPrompt(mode)
                          │
                          ▼
         AiAssessmentCache.buildKey({ input, promptVersion, model, mode })
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
      cache hit?                 callStructuredGemini (mit responseSchema)
              │                       │
              │              validateAgainstMode(parsed, mode)
              │                       │  invalid?
              │                       ▼
              │              Reparaturversuch (1×)
              │                       │
              ▼                       ▼
         Antwort               cache.set(key, result)
                                      │
                                      ▼
                                  Antwort
```

---

## Free-Tier-schonende Architektur

* **Caching:** identische Anfragen werden aus dem Cache bedient.
  Der Schlüssel ist `sha256( JSON.stringify({ input, promptVersion, model, mode }) )`
  über einer **kanonisch sortierten** Repräsentation des Inputs.  TTL Standard 1h,
  LRU-Verdrängung bei > 200 Einträgen.
* **Retry/Backoff:** der Provider wiederholt bei `429` und `5xx` mit
  exponentiellem Backoff (`500 ms · 2^attempt`), Standard bis zu 2 Wiederholungen.
* **Concurrency-Queue:** alle Provider-Aufrufe gehen durch
  `AiJobQueue` (Standard `concurrency=1`).  Damit gibt es keine parallelen
  Gemini-Aufrufe pro Server-Prozess.
* **Maßnahmenvorselektion:** die KI bekommt nur ~6–8 plausible Maßnahmen statt
  des vollen Katalogs.  Das spart Tokens und reduziert Halluzinationsrisiko.
* **Strukturiertes Output:** `responseSchema` an Gemini → kürzere, schemakonforme
  Antworten ohne Markdown-Drumherum.

---

## Robustheit / Fallback-Verhalten

| Situation                                           | Verhalten                                                    |
|-----------------------------------------------------|--------------------------------------------------------------|
| `GEMINI_API_KEY` fehlt + `withFallback:true`        | deterministischer Fallback aus Features + Vorselektion       |
| `GEMINI_API_KEY` fehlt + `withFallback:false`       | HTTP 503                                                      |
| Provider-Timeout / 429 / 5xx                        | Retry mit Backoff (bis `AI_ASSESSMENT_MAX_RETRIES`)          |
| Provider-Antwort kein gültiges JSON                 | `parseJsonLoose()` extrahiert (Markdown-Fences, eingebettetes JSON) |
| Schema-Validierung schlägt fehl                     | **einmaliger** Reparaturversuch (gleiche Anfrage + Korrekturhinweis) |
| Reparaturversuch schlägt fehl + `withFallback:true` | deterministischer Fallback                                    |
| Reparaturversuch schlägt fehl + `withFallback:false`| HTTP 500                                                      |

Der **deterministische Fallback** ist garantiert schemakonform und nutzt
Features + vorselektierte Maßnahmen, um trotz fehlender KI ein nutzbares
Ergebnis zu liefern.

---

## Konfiguration

| Umgebungsvariable             | Standard               | Bedeutung                                  |
|-------------------------------|------------------------|--------------------------------------------|
| `GEMINI_API_KEY`              | *(Pflicht für KI)*     | API-Schlüssel                              |
| `AI_ASSESSMENT_MODEL`         | `gemini-2.0-flash`     | Modellname                                 |
| `AI_ASSESSMENT_TIMEOUT_MS`    | `30000`                | Timeout pro Anfrage                        |
| `AI_ASSESSMENT_MAX_RETRIES`   | `2`                    | Wiederholungen bei `429`/`5xx`             |

---

## Maßnahmenbibliothek

`catalog/measureCatalog.js` enthält ~15 typische kommunale Maßnahmen mit
Metadaten (`category`, `targetAccidentTypes`, `implementationEffort`,
`costBand`, `description`).

`catalog/cityMeasureCatalog.js` lädt zusätzlich stadt-spezifische
Erweiterungen aus `templates/measures_<citySlug>.json` (analog zu
`templates/gremien_<slug>.json`).  Einträge mit gleicher `id` wie im
Basiskatalog überschreiben diesen, neue `id`s werden ergänzt.  Der Slug
wird aus `structured.meta.city` abgeleitet.  Beispieldatei:
`templates/measures_hannover.json`.

`scoring/preselectMeasures.js` wählt anhand der Tags aus
`deriveFeatures().tags` (`bike_car`, `school_zone`, `surface`, …) die
plausibelsten Maßnahmen aus – aus dem **stadt-erweiterten** Katalog,
falls verfügbar.  Ein Monitoring-Eintrag wird **immer** mit aufgenommen
(Wirkungskontrolle).

Die KI darf priorisieren, sortieren und konkret begründen
(`whyThisFitsHere`), aber im Regelfall keine völlig fremden Maßnahmen
erfinden.

---

## Provider-Abstraktion

`providers/index.js` wählt den aktiven Provider per Umgebungsvariable
`AI_PROVIDER`:

| Wert         | Verhalten                                                         |
|--------------|-------------------------------------------------------------------|
| `gemini`     | Standard – `geminiStructuredProvider` (Gemini REST + responseSchema) |
| `null`       | Wirft sofort `RetryableError` → Service zieht den Fallback        |
| (sonstige)   | Fällt auf `gemini` zurück                                         |

Ein neuer Anbieter (z. B. lokales Modell, Anthropic, OpenAI) wird durch
Hinzufügen einer Funktion mit Signatur
`({ system, user, responseSchema, temperature, maxRetries }) => Promise<string>`
in `providers/index.js` registriert.  Die Service-Schicht muss dazu nicht
geändert werden.

---

## Asynchrone Jobs (Queue + Status-Endpunkt)

Für Workflows, in denen der Aufrufer nicht synchron warten möchte,
gibt es die Endpunkte:

* `POST /api/ai/jobs` – Body `{ kind: "export-assessment-v2", payload: {...} }`,
  Antwort `{ id, status, kind, submittedAt }` (HTTP 202).
  `payload` entspricht dem Body von `POST /api/ai/export-assessment/v2`.
* `GET  /api/ai/jobs/:id` – Antwort
  `{ id, kind, status: queued|running|done|error, submittedAt, startedAt?, finishedAt?, result?, error? }`.

Verhalten:

* Concurrency-Limit (default 1) – schont Free-Tier wie der synchrone
  Pfad.
* Persistenz nach Disk, falls `AI_JOBS_PATH` gesetzt ist (atomar via
  temp + rename).  Nach Server-Neustart werden `queued`/`running`-Jobs
  defensiv auf `error` gesetzt – sie können nicht resumiert werden und
  ein Statusabruf liefert sofort einen klaren Fehler.
* Abgeschlossene Jobs werden nach `jobTtlMs` (default 1 h) automatisch
  verworfen; harte Obergrenze `maxJobs` (default 200).

---

## Cache-Persistenz

`cache/aiAssessmentCache.js` schreibt seinen Inhalt auf Disk, wenn
`AI_CACHE_PATH` gesetzt ist:

* Schreiben ist **debounced** (default 500 ms) und atomar (temp +
  rename).
* Beim Start wird die Datei geladen und abgelaufene Einträge werden
  verworfen.
* `flushSync()` erzwingt sofortiges Schreiben (für Tests bzw. graceful
  shutdown).

---

## Konfiguration (Umgebungsvariablen, Übersicht)

| Variable                       | Wirkung                                                       |
|--------------------------------|---------------------------------------------------------------|
| `GEMINI_API_KEY`               | Pflicht für echten Gemini-Aufruf; sonst Fallback              |
| `AI_PROVIDER`                  | `gemini` (Standard) \| `null`                                 |
| `AI_ASSESSMENT_MODEL`          | Modellname (Standard `gemini-2.0-flash`)                      |
| `AI_ASSESSMENT_TIMEOUT_MS`     | Pro-Request-Timeout                                           |
| `AI_ASSESSMENT_MAX_RETRIES`    | Max. Retries bei 429/5xx/Timeout (Standard 2)                 |
| `AI_CACHE_PATH`                | Optional: Datei für persistierten Antwort-Cache               |
| `AI_JOBS_PATH`                 | Optional: Datei für persistierte Jobs                         |

---

## TODOs für einen späteren Folge-PR

* **SQLite/Redis-Backend** für Cache und Job-Queue (statt JSON-Datei) –
  belastbarer bei vielen parallelen Server-Prozessen.
* **Job-Cancellation** und **Prioritäten** (`proposal-brief` vor
  `assessment`?).
* **Echte alternative Provider** (lokales Modell, Anthropic, OpenAI)
  hinter `providers/index.js`.
* **Frontend-Integration** mit klarer Kennzeichnung „KI-Vorschlag"
  vs. „deterministisch berechnet" und einer optionalen UI für die
  asynchronen Jobs.
