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

`scoring/preselectMeasures.js` wählt anhand der Tags aus
`deriveFeatures().tags` (`bike_car`, `school_zone`, `surface`, …) die
plausibelsten Maßnahmen aus.  Ein Monitoring-Eintrag wird **immer** mit
aufgenommen (Wirkungskontrolle).

Die KI darf priorisieren, sortieren und konkret begründen
(`whyThisFitsHere`), aber im Regelfall keine völlig fremden Maßnahmen
erfinden.

---

## TODOs für einen späteren Folge-PR

* **Persistenz** der Job-Queue (`jobs/aiJobQueue.js`) – z. B. SQLite/Disk –
  damit lange laufende Jobs einen Server-Neustart überleben.
* **Job-Status-Endpunkt** `GET /api/ai/jobs/:id` für asynchrone Workflows.
* **Persistenz** des Caches – z. B. einfache Disk-Persistenz oder Redis,
  damit Cache-Hits Server-Neustarts überleben.
* **Erweiterung des Maßnahmenkatalogs** um stadt- bzw. landesspezifische
  Maßnahmen (z. B. eigene Templates wie bei `templates/gremien_*.json`).
* **Mehrere Anbieter** (lokales Modell, Anthropic, OpenAI) hinter einer
  einheitlichen Provider-Schnittstelle.
* **Frontend-Integration** mit klarer Kennzeichnung „KI-Vorschlag"
  vs. „deterministisch berechnet".
