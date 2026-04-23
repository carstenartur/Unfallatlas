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
| `aiAssessmentServiceV2.js`                           | Orchestriert: Features → Konfliktmuster → Vorselektion → Prompt → Provider → Validierung → Cache |
| `features/deriveFeatures.js`                         | Berechnet KSI, Beteiligungsanteile, dominante Muster, Trend, räumliche Verdichtung, Tags – inklusive `conflictPatterns` (siehe unten) |
| `features/conflictPatterns.js`                       | Erkennt fachliche Konfliktmuster (Kfz-Rad-Abbiegekonflikt, Schienenquerung, Schulumfeld, …) auf Basis der berechneten Features |
| `catalog/measureCatalog.js`                          | Maßnahmenbibliothek mit Metadaten zu Einsatzfällen, Vorsicht, Konfliktmustern, Wirkungsrichtung, Dauer, Klasse |
| `scoring/preselectMeasures.js`                       | Deterministische Vorselektion plausibler Maßnahmen aus dem Katalog – mit `matchedRiskFactors`, `matchedConflictPatterns`, `reasonForPreselection` |
| `prompts/exportAssessmentPrompt.v2.js`               | System- + Nutzerprompt-Builder für beide Modi               |
| `providers/geminiStructuredProvider.js`              | Gemini-Adapter mit `responseSchema`, Retry/Backoff          |
| `cache/aiAssessmentCache.js`                         | In-Memory-Cache (sha256 + TTL + LRU)                         |
| `jobs/aiJobQueue.js`                                 | Einfache Concurrency-Queue (Stub für späteren Folge-PR)     |
| `schema/exportAssessment.v2.schema.json`             | Schema für Modus `assessment` (inkl. `uncertainty`, `provenance`, `policyContext`, antragstauglicher Felder) |
| `schema/proposalBrief.v1.schema.json`                | Schema für Modus `proposal-brief` (gleiche Erweiterungen)    |

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

---

## Konfliktmuster (`features/conflictPatterns.js`)

Die KI-Ausgabe muss konkrete **Konfliktmuster** benennen können – nicht nur
„hier gibt es Unfälle". Aus den deterministisch berechneten Features wird
deshalb ein zweiter Schritt abgeleitet, der typische Konfliktbilder
identifiziert. Jedes Muster ist mit Evidenz, Begründung und
Vor-Ort-Prüfauftrag annotiert.

| ID                                       | Auslöser (verkürzt)                                                  | Tags                          |
|------------------------------------------|----------------------------------------------------------------------|-------------------------------|
| `kfz_rad_abbiegekonflikt`                | Rad+Kfz beide ≥ 20 % und `junction` oder hoher KSI-Anteil            | `bike_car`, `junction`        |
| `rad_alleinunfall_oberflaeche`           | Rad-Anteil hoch, Kfz-Anteil niedrig, optional `surface`-Hint         | `bike_alone`, `surface`       |
| `schienenquerung_spitzwinkel`            | `rail`-Tag (POI) oder Hint enthält „Schiene/Gleis/Tram"              | `rail`, `surface`             |
| `schulumfeld_querungsdruck`              | `school_zone`-Tag aus POI                                            | `school_zone`, `crossing`     |
| `fussverkehr_konflikt`                   | Fußverkehrsanteil ≥ 15 % oder `ped_car`-Tag                          | `ped_car`, `crossing`         |
| `schwere_unfaelle_geringe_haeufigkeit`   | Total < 10 aber KSI-Anteil ≥ 30 % – fordert Vor-Ort-Prüfung          | `junction`, `crossing`        |
| `linearer_korridor_statt_punkt`          | `spatialDensity.hint = distributed/localized` (große Spannweite)     | `bike_car`, `crossing`        |
| `sicht_park_konflikt`                    | Sicht-/Park-Hints oder Knotenpunkt/Querung als Tag                   | `junction`, `crossing`        |
| `lkw_lieferverkehr_kontext`              | `hgv` oder `bike_truck`-Tag bzw. Lkw-/Liefer-Hint                    | `hgv`, `bike_truck`           |
| `oepnv_haltestellenbereich`              | `transit`-Tag aus POI                                                | `transit`, `ped_car`          |
| `datenlage_unzureichend`                 | Total = 0 → expliziter `dataIssue: true`                             | —                             |

Jedes Pattern enthält:

* `classification`: `primary` (von Evidenz gestützt) oder `secondary` (Hypothese)
* `confidence`: `high` / `medium` / `low` – bei `< 5` Unfällen gedeckelt auf `medium`
* `evidence`: Liste der Datenfelder/Hints, die das Muster stützen
* `requiresOnSiteCheck`: konkrete Vor-Ort-Prüfaufträge

Die Muster fließen in zwei Richtungen weiter:

1. Sie ergänzen `features.tags` automatisch, sodass die Maßnahmenvorselektion
   sie auch ohne explizite Pattern-Verknüpfung sieht.
2. Sie erscheinen direkt in der KI-Ausgabe als `detectedConflictPatterns`
   und sind so für die UI / Word-/PDF-Ausgabe sichtbar.

---

## Maßnahmenbibliothek (`catalog/measureCatalog.js`)

Jede Maßnahme im Katalog ist nicht nur ein Titel, sondern ein
fachlich annotiertes Objekt:

| Feld                       | Bedeutung                                                                        |
|----------------------------|----------------------------------------------------------------------------------|
| `id`                       | stabile ID, die in der KI-Antwort wiederverwendet werden darf                    |
| `category`                 | `quickWin` \| `infrastructure` \| `organizational` \| `monitoring`               |
| `targetAccidentTypes`      | semantische Tags aus `deriveFeatures` (z. B. `bike_car`, `surface`, `school_zone`) |
| `conflictPatterns`         | IDs aus `conflictPatterns`, die diese Maßnahme adressiert                        |
| `useCases`                 | typische Einsatzfälle (z. B. „Knotenpunkt mit Lkw-Abbiegekonflikt")              |
| `cautions`                 | typische Vorsichts-/Ausschlussfälle (z. B. „bei sehr schmalem Querschnitt")      |
| `effectDirection`          | „reduziert Häufigkeit" / „reduziert Schwere" / „verbessert Faktenbasis" …        |
| `implementationEffort`     | `low` / `medium` / `high`                                                        |
| `costBand`                 | `low` / `medium` / `high`                                                        |
| `implementationDuration`   | `weeks` / `months` / `year_plus`                                                 |
| `measureClass`             | `quickWin` / `operational` / `marking` / `signal` / `structural` / `major_rebuild` |

Vorhandene Maßnahmen sind u. a.:

* **Markierung**: Schutzstreifen, Aufpflasterung, Parken zurücksetzen
* **Signal/Knoten**: vorgezogene Grünphase, geschützte Knotenpunktecke (ARAS)
* **Bauliche Lösung**: geschützte Radführung, Knotenpunktumbau, Belagssanierung,
  Schienenquerung-Realign, sichere Querungsanlage, ÖPNV-Haltestellenumbau,
  Schulwegsicherung
* **Lkw-Sicherheit**: Lkw-Routing / Abbiegeassistenten-Kampagne
* **Organisatorisch**: Unfallkommission, Verkehrsschau
* **Monitoring**: Nachher-Vergleich

---

## Schärfere Maßnahmenzuordnung

`scoring/preselectMeasures.js` reicht zu jedem Kandidaten zusätzlich zu Score
und Katalogfeldern auch maschinenlesbare Begründungen mit:

```jsonc
{
  "id": "inf_truck_routing",
  "title": "Lkw-Routing / Lkw-Abbiege-Sicherheit …",
  "matchedRiskFactors":           ["bike_truck", "hgv", "junction"],
  "matchedConflictPatterns":      ["lkw_lieferverkehr_kontext", "kfz_rad_abbiegekonflikt"],
  "expectedTargetAccidentTypes":  ["bike_truck", "hgv", "junction"],
  "reasonForPreselection":        "adressiert Konfliktmuster: lkw_lieferverkehr_kontext, kfz_rad_abbiegekonflikt; passt zu Risikofaktoren: bike_truck, hgv, junction"
}
```

Das Modell darf priorisieren, kombinieren und eigene Begründungen für **diesen
Ort** ergänzen (`whyThisFitsHere`), aber **keine vom Katalog losgelösten
Maßnahmen erfinden**, solange passende Kandidaten existieren.

---

## AI vs. deterministisch (Provenance)

Sowohl der `assessment`- als auch der `proposal-brief`-Output enthalten ein
**`provenance`**-Objekt:

```jsonc
"provenance": {
  "derivedFromDeterministicFeatures": [
    "counts", "severity.bySev", "crossTable", "deviations.focus",
    "yearTable", "spatialDensity", "poiSummary",
    "features.tags", "features.conflictPatterns"
  ],
  "inferredByModel": [
    "Priorisierung der Maßnahmen",
    "Formulierung 'Sachverhalt' und 'Begründung'"
  ],
  "uncertainOrNeedsVerification": [
    "Genaue Fahrtrichtung in den Konflikten",
    "Tatsächliche Sichtverhältnisse vor Ort"
  ]
}
```

Damit kann die UI klar trennen, welche Aussagen 1:1 aus den amtlichen Daten
stammen, welche eine KI-Verdichtung sind und welche unbedingt noch geprüft
werden müssen. Im deterministischen Fallback ist `inferredByModel` leer.

---

## Unsicherheitslogik (`uncertainty`)

Statt Scheinsicherheit gibt jede v2-Antwort einen strukturierten
Unsicherheitsblock zurück:

```jsonc
"uncertainty": {
  "missingData": [
    "Genaue Unfallhergänge sind nicht im Datensatz enthalten.",
    "Fallzahl im Bereich liegt unter 10 – statistische Aussagen sind unsicher."
  ],
  "weakDataBasis": true,
  "plausibleNotEvidenced": [
    "Korridor- statt Punktproblem (linearer Streckenmangel)"
  ],
  "requiresOnSiteCheck": true,
  "alternativeExplanations": [
    "Punktuelle bauliche Mängel sind oft nicht aus den Daten ersichtlich.",
    "Verkehrsstärken und Geschwindigkeiten sind im Unfallatlas nicht enthalten."
  ]
}
```

Bei `weakDataBasis = true` darf `confidence.overall` niemals `high` sein; das
Schema erzwingt das nicht direkt, aber Prompt + Fallback halten sich daran.

---

## Antragstaugliche Ausgabefelder

Beide Ausgabe-Schemata enthalten jetzt zusätzliche, **direkt verwendbare**
Bausteine für Anträge, Anfragen, Prüfaufträge und Verwaltungsnotizen:

| Feld                                | Zweck                                                       |
|-------------------------------------|-------------------------------------------------------------|
| `shortAdministrativeSummary`        | 1–2 Sätze für Verwaltungsnotiz                              |
| `technicalRationale`                | fachliche Begründung mit Datenbezug (nur Assessment)        |
| `recommendedImmediateAction`        | was sollte ≤ 4 Wochen passieren?                            |
| `recommendedDetailedExamination`    | welche tiefere Prüfung ist angezeigt?                       |
| `expectedSafetyBenefit`             | realistische Wirkungseinschätzung                           |
| `whyActionIsPlausibleHere`          | warum sind Maßnahmen an diesem Ort plausibel?               |
| `whyEvidenceIsLimitedIfApplicable`  | falls Datenlage schwach: warum trotzdem handeln?            |
| `suggestedCouncilRequest`           | Vorschlag für Antrags-/Anfragetext                          |
| `suggestedReviewOrder`              | Vorschlag für formellen Prüfauftrag an die Verwaltung       |
| `fieldInspectionChecklist`          | konkrete Punkte für die Ortsbegehung                        |

Alle Felder sind **optional** im Schema (Backward-Kompatibilität); der
deterministische Fallback füllt sie konservativ.

---

## Politische Nutzbarkeit (Vorbereitung, optional)

Optionaler `policyContext`-Block – bewusst klein gehalten, ohne erzwungene
externe Datenintegration:

```jsonc
"policyContext": {
  "policyReadiness": "medium",
  "existingPoliticalSignals":     [],
  "synergyWithKnownRequests":     [],
  "implementationOpportunityLevel": "medium"
}
```

Damit ist die Ausgabe darauf vorbereitet, in einem späteren Folge-PR mit
politischen Signalen (laufende Anträge, gefasste Beschlüsse) angereichert
zu werden, ohne dass jetzt schon eine Persistenzlösung gebaut werden muss.

---

## Beispiel (gekürzt) – `assessment`

```jsonc
{
  "schemaVersion": "exportAssessment.v2",
  "problemProfile": {
    "headline": "Auffällige Unfallhäufung im Bereich Mitte",
    "summary":  "18 Unfälle, davon 5 schwer; dominierend Rad+Kfz mit Knotenpunktbezug.",
    "dominantPattern": "🚲+🚗"
  },
  "evidence": [
    { "statement": "18 Unfälle (0/5/13).",      "source": "severity.bySev" },
    { "statement": "KSI-Anteil 28 %.",          "source": "severity.bySev" },
    { "statement": "🚲+🚗: 12 lokal.",          "source": "deviations.focus" }
  ],
  "primaryRiskFactors": [
    { "factor": "Kfz/Rad-Abbiegekonflikt am Knotenpunkt", "rationale": "…", "confidence": "medium" }
  ],
  "secondaryRiskFactors": [
    { "factor": "Korridor- statt Punktproblem", "rationale": "…", "confidence": "low" }
  ],
  "detectedConflictPatterns": [
    { "id": "kfz_rad_abbiegekonflikt", "label": "Kfz/Rad-Abbiegekonflikt am Knotenpunkt", "confidence": "medium" }
  ],
  "recommendedMeasures": [
    {
      "id": "qw_marking_bike_lane",
      "title": "Fahrbahnmarkierung Schutzstreifen erneuern",
      "category": "quickWin",
      "matchedRiskFactors":      ["bike_car", "junction"],
      "matchedConflictPatterns": ["kfz_rad_abbiegekonflikt"],
      "implementationDuration":  "weeks",
      "measureClass":            "marking",
      "whyThisFitsHere":         "…",
      "expectedEffect":          "…",
      "targetAccidentTypes":     ["bike_alone", "bike_car", "junction"],
      "implementationEffort":    "low",
      "costBand":                "low",
      "confidence":              "medium"
    }
  ],
  "shortAdministrativeSummary": "18 Unfälle, davon 5 schwer/tödlich. Konfliktmuster: Kfz/Rad-Abbiegekonflikt am Knotenpunkt.",
  "recommendedImmediateAction": "Verkehrsschau / Ortstermin mit Polizei und Verwaltung anberaumen.",
  "fieldInspectionChecklist":   ["Sichtachsen prüfen", "Furtmarkierungen prüfen", "Aufstellbereiche prüfen"],
  "uncertainty": { "weakDataBasis": false, "missingData": [ "…" ], "requiresOnSiteCheck": true, "alternativeExplanations": [ "…" ] },
  "provenance":  { "derivedFromDeterministicFeatures": [ "…" ], "inferredByModel": [ "…" ], "uncertainOrNeedsVerification": [ "…" ] },
  "policyContext": { "policyReadiness": "medium", "implementationOpportunityLevel": "medium" },
  "confidence": { "overall": "medium", "rationale": "Genug Fälle, aber Hergänge unklar." },
  "dataGaps":   ["…"]
}
```

## Beispiel (gekürzt) – `proposal-brief`

```jsonc
{
  "schemaVersion": "proposalBrief.v1",
  "title": "Verkehrssicherheit im Bereich Mitte verbessern",
  "shortVersion":  "…",
  "longVersion":   "…",
  "sachverhalt":   "…",
  "begruendung":   "Erkannte Konfliktmuster: Kfz/Rad-Abbiegekonflikt am Knotenpunkt …",
  "beschlussvorschlag": "…",
  "pruefauftrag":  "…",
  "measureSummary": [
    { "id": "qw_marking_bike_lane", "title": "…", "category": "quickWin",
      "rationale": "adressiert Konfliktmuster: kfz_rad_abbiegekonflikt; passt zu Risikofaktoren: bike_car, junction",
      "matchedRiskFactors":      ["bike_car", "junction"],
      "matchedConflictPatterns": ["kfz_rad_abbiegekonflikt"] }
  ],
  "shortAdministrativeSummary": "…",
  "suggestedCouncilRequest":    "Die Verwaltung wird gebeten, …",
  "suggestedReviewOrder":       "Prüfung der Unfallhäufung durch Verwaltung/Unfallkommission …",
  "fieldInspectionChecklist":   [ "…" ],
  "uncertainty":   { "…": "…" },
  "provenance":    { "…": "…" },
  "policyContext": { "…": "…" },
  "confidence":    { "overall": "medium" },
  "caveats":       [ "…" ]
}
```

---

## Hinweise zur fachlichen Interpretation

* **Konfliktmuster sind Hypothesen, keine Diagnosen.** Sie sind aus den
  amtlichen Daten plausibel ableitbar, müssen aber durch Vor-Ort-Befund
  bestätigt werden – das macht der Block `requiresOnSiteCheck` jeder
  Pattern-Eintrag und das Feld `fieldInspectionChecklist` explizit.
* **`primary` vs. `secondary`**: ein primäres Muster ist von Evidenz
  gestützt; ein sekundäres ist eine Hypothese, die offen ausgesprochen
  werden soll – nie zur Hauptaussage werden lassen.
* **Maßnahmen ohne Bezug**: erscheint im Output eine Maßnahme ohne
  `matchedConflictPatterns`/`matchedRiskFactors`, ist das ein Indiz, dass
  sie generisch ausgewählt wurde – das ist legitim für organisatorische /
  Monitoring-Schritte, aber bei baulichen Maßnahmen ein Warnzeichen.
* **`confidence: low`** ist keine Schwäche, sondern ein wichtiges Signal.
  Antragstexte sollten in diesem Fall die `whyEvidenceIsLimitedIfApplicable`-
  Begründung übernehmen.
* **Datenlage = 0**: das System gibt explizit `datenlage_unzureichend` aus,
  statt eine inhaltliche Aussage zu erfinden.

---

## Tests

* `tests/unit/aiAssessmentServiceV2.test.js` – Pipeline, Cache, Schema-Subset,
  Validierung, Reparaturversuch, Fallback.
* `tests/unit/aiAssessmentServiceV2.golden.test.js` – realistische Falltypen
  (Kfz-Rad-Abbiegekonflikt, Schienenquerung, Oberflächenproblem,
  Schulumfeld, Lkw-Konflikt, linearer Korridor, schwache Datenlage,
  Vorsicht bei kleiner Stichprobe). Geprüft wird **fachliche Mindestqualität**
  (Konfliktmuster erkannt, passende Maßnahmen, Unsicherheit sauber,
  antragstaugliche Bausteine vorhanden), nicht der Wortlaut.

