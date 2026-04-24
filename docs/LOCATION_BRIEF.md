# Location Action Brief – Maßnahmen-Steckbriefe

> **Status:** v1 (deterministisch, KI optional). Modular neben der bestehenden
> KI-Bewertung (`server/ai/`) angelegt; bestehende Funktionen bleiben unverändert.

Der **Location Action Brief** beantwortet für eine einzelne Stelle die Frage:

> *Welche Stelle sollten wir als Nächstes mit welcher Maßnahme angehen – und warum genau diese?*

Er ist die Brücke vom reinen Analyse-/Exportwerkzeug zum priorisierenden
Entscheidungswerkzeug.

---

## Architektur (Überblick)

```
server/location-brief/
├── index.js                         – öffentliche API
├── briefService.js                  – Top-Level: buildLocationBrief(...)
├── conflictPatternAliases.js        – DE↔EN Pattern-IDs (1:1 Mapping)
├── measureLibrary.js                – angereicherte Sicht des Maßnahmenkatalogs
├── politicalContextSummary.js       – verdichtet Portal-Suchergebnisse
└── prioritization/
    ├── profiles.js                  – 5 Bewertungsprofile (Gewichtsvektoren)
    └── scoring.js                   – 8 Sub-Scores + Profil-Anwendung
```

Alle Bestandteile sind rein deterministisch. KI ist eine optionale
**Veredelung** und kann z. B. bestehende Maßnahmenrationalen umformulieren –
sie darf aber **niemals** Maßnahmen oder Konfliktmuster erfinden, die nicht
schon in der Vorselektion stehen.

Der HTTP-Endpunkt ist `POST /api/location-brief` und benötigt keinen
GEMINI_API_KEY.

---

## Konfliktmuster

Die Erkennung selbst lebt in `server/ai/features/conflictPatterns.js`
und verwendet stabile **deutsche IDs**. Der Brief reicht jede Erkennung
zusätzlich mit der **englischen ID** (alias) durch, wie im Produkt verlangt:

| Englische ID                          | Deutsche ID (kanonisch)                |
| ------------------------------------- | -------------------------------------- |
| `bicycle_turning_conflict`            | `kfz_rad_abbiegekonflikt`              |
| `bicycle_single_accident_surface`     | `rad_alleinunfall_oberflaeche`         |
| `tram_track_angle_conflict`           | `schienenquerung_spitzwinkel`          |
| `school_route_crossing_conflict`      | `schulumfeld_querungsdruck`            |
| `pedestrian_crossing_conflict`        | `fussverkehr_konflikt`                 |
| `truck_turning_conflict`              | `lkw_lieferverkehr_kontext`            |
| `parking_visibility_conflict`         | `sicht_park_konflikt`                  |
| `stop_area_conflict`                  | `oepnv_haltestellenbereich`            |
| `linear_corridor_deficiency`          | `linearer_korridor_statt_punkt`        |
| `severe_low_frequency_risk`           | `schwere_unfaelle_geringe_haeufigkeit` |

Jedes erkannte Muster trägt:

- `id` (DE) und `aliasId` (EN)
- `classification` (`primary` | `secondary`)
- `confidence` (`high` | `medium` | `low`)
- `evidence[]` – konkrete Datenfeldverweise
- `rationale` – kurze fachliche Begründung
- `requiresOnSiteCheck[]` – was vor Ort geprüft werden muss

Konfliktmuster sind **strukturierte Felder, kein KI-Text** – sie können von
Tests, Maßnahmen-Vorselektion und Steckbrief-Ausgabe gleichermaßen
verarbeitet werden.

---

## Maßnahmenbibliothek (angereichert)

Die Quelle der Maßnahmen bleibt der etablierte Katalog
`server/ai/catalog/measureCatalog.js` (mit optionalen Stadt-Erweiterungen
über `cityMeasureCatalog.js`).

Die Funktion `getMeasureLibrary([citySlug])` aus
`server/location-brief/measureLibrary.js` liefert pro Maßnahme:

| Feld                           | Beschreibung |
| ------------------------------ | ------------ |
| `id`, `title`                  | siehe Basiskatalog |
| `category`                     | abgeleitet aus `measureClass`/`id` (siehe unten) |
| `applicableConflictPatterns`   | DE-Pattern-IDs **plus** zugehörige EN-Aliasse |
| `typicalTargetAccidentTypes`   | aus `targetAccidentTypes` |
| `typicalBenefits`              | aus `useCases` |
| `exclusionHints`               | aus `cautions` |
| `implementationEffort`         | `low` | `medium` | `high` |
| `costBand`                     | `low` | `medium` | `high` |
| `quickWinScore` (0..1)         | abgeleitet aus Aufwand + Kosten + Dauer |
| `policyReadinessHints[]`       | kurze Hinweise zu politischer Anschlussfähigkeit |
| `notes`                        | Kurzbeschreibung + Wirkungsrichtung |

### Brief-Kategorien

`category` ist nicht der Basis-Eintrag (`quickWin`/`infrastructure`/…),
sondern eine fachlichere Klassifikation:

`marking`, `signaling`, `parking_management`, `loading_management`,
`surface_improvement`, `crossing_upgrade`, `cycle_protection`,
`junction_redesign`, `traffic_calming`, `stop_area_improvement`,
`tram_crossing_treatment`.

Die ursprüngliche Kategorie steht weiterhin als `sourceCategory` zur
Verfügung.

---

## Vorselektion + Bewertung

Pro Stelle berechnet der Brief für jede Maßnahme:

- `fitScore` (0..1) – wie gut passt die Maßnahme zur erkannten Konfliktlage?
- `quickWinPotential` (0..1) – wie schnell und günstig wirksam?
- `matchedConflictPatterns[]`, `matchedRiskFactors[]`
- `expectedTargetAccidentTypes[]`
- `implementationEffort`, `costBand`
- `whyPreselected` – nachvollziehbare Begründung

Die deterministische Vorselektion stammt aus `preselectMeasures` (3 Punkte
pro adressiertem Konfliktmuster, 2 Punkte pro Risikofaktor); der Brief
ergänzt das um den `fitScore` (skaliert + gemischt mit dem
Sicherheits-Impact-Score der Stelle) und `quickWinPotential`.

---

## Multi-Kriterien-Priorisierung

`computeLocationScores({ features, preselected, policyContext })` gibt 8
Sub-Scores in `[0,1]` zurück:

| Score                           | Inhalt |
| ------------------------------- | ------ |
| `safetyImpactScore`             | Volumen × erkannte Hauptmuster |
| `severeAccidentReductionScore`  | KSI-Anzahl × KSI-Anteil |
| `bicycleSafetyScore`            | Radanteil + radspezifische Muster |
| `quickWinScore`                 | Mittelwert quickWinScore der Vorselektion |
| `implementationFeasibilityScore`| inverse Aufwandsschwere |
| `policyReadinessScore`          | aus politischem Kontext + Maßnahmen-Hints |
| `costEfficiencyScore`           | inverse Kosten × Sicherheits-Impact |
| `dataConfidenceScore`           | Volumen vs. low-confidence/dataIssue-Patterns |

### Bewertungsprofile

`server/location-brief/prioritization/profiles.js` definiert fünf
Profile als Gewichtsvektoren:

- `low_hanging_fruit` – betont quickWin + Umsetzbarkeit + Kosten
- `bicycle_safety_priority` – betont Radverkehrssicherheit + Schwere
- `severe_accident_priority` – betont KSI-Reduktion
- `policy_ready` – betont politische Anschlussfähigkeit
- `cost_effective` – betont Kosten/Wirkung

`applyProfile(scores, profileId)` liefert einen normierten Gesamtwert
(`total ∈ [0,1]`); `applyAllProfiles(scores)` berechnet alle fünf auf
einen Schlag und ist Teil jedes Briefs (`deterministicFindings.profileScores`).

---

## Politischer Kontext

`summarizePoliticalContext(searchResult)` arbeitet auf dem
PoliticalReferenceSearchResult, das die bestehende Portalsuche liefert.

Wichtig: **Es werden ausschließlich Treffer berücksichtigt, die im
Portalsuchdienst positiv als verkehrsrelevant klassifiziert wurden**
(`trafficRelevance.classification ∈ {traffic_safety, traffic_infrastructure,
traffic_general}` oder `isRelevant === true`). Damit kein Vorgang nur wegen
gleichem Straßennamen als wichtig erscheint.

Ausgabefelder im Brief unter `politicalContext`:

- `previousPoliticalAttention` – `none` | `some` | `frequent`
- `policyReadiness`            – `low` | `medium` | `high`
- `relatedReferences[]`        – Top-Treffer mit Relevanzwert
- `recurringRequests[]`        – wiederkehrende Themen (Heuristik)
- `administrativeMomentumHints[]` – Hinweise auf laufende Vorgänge

---

## Steckbrief-Ausgabeform

Der `LocationActionBrief` (Schema `locationActionBrief.v1`) trennt klar
zwischen:

```jsonc
{
  "deterministicFindings": { /* alles, was aus Daten ableitbar ist */ },
  "modelInferences":       null /* oder die optional übergebene KI-Veredelung */,
  "uncertainties":         { /* ehrlich ausgewiesene Lücken */ },
  "recommendedActions":    { /* priorisierte Maßnahmenliste */ }
}
```

Zusätzlich enthält der Brief oben die im Produkt geforderten Felder:
`locationId`, `title`, `problemSummary`, `accidentProfile`,
`dominantPatterns`, `conflictPatterns`, `dataQuality`, `politicalContext`,
`candidateMeasures`, `recommendedMeasures`, `quickWins`,
`infrastructureOptions`, `expectedEffects`, `implementationEffort`,
`costBands`, `confidence`, `openChecks`, `suggestedNextSteps`.

---

## Trennung deterministisch / KI / Unsicherheit

| Output-Bucket          | Inhalt                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| `deterministicFindings`| Kennzahlen, Muster, Maßnahmen-Scoring, Profil-Bewertungen.             |
| `modelInferences`      | nur befüllt, wenn `aiPolish` übergeben wurde. Niemals neue Maßnahmen.  |
| `uncertainties`        | weakDataBasis, low-confidence-Muster, Hinweise auf Vor-Ort-Bedarf.     |
| `recommendedActions`   | Top-Maßnahmen + Quick-Wins + nächste Schritte.                         |

**KI darf:**

- Sprachlich verdichten, formulieren, Antragstexte vorschlagen
- Innerhalb der bereits vorselektierten Maßnahmen umsortieren
  (`aiPolish.preferredMeasureIds`)
- Ergänzende Rationalen liefern (`aiPolish.refinedMeasureRationales`)

**KI darf nicht:**

- Maßnahmen erfinden, die nicht in der deterministischen Vorselektion stehen
- Konfliktmuster ohne strukturierte Datenbasis erfinden
- Quelle der Wahrheit für Scores sein

Unbekannte Maßnahmen-IDs in `aiPolish.preferredMeasureIds` werden
serverseitig still verworfen.

---

## API-Beispiel: Ein vollständiger Orts-Steckbrief

`POST /api/location-brief`

**Body:**

```jsonc
{
  "structured": { /* aus computeExportReport(), Frontend */ },
  "contextHints": {
    "knownHazards": ["Sichtbehinderung durch parkende Lkw"],
    "surfaceHints": ["Kopfsteinpflaster bei Nässe sehr rutschig"]
  },
  "politicalContext": { /* Antwort von /api/political-context/search */ },
  "locationId": "hannover::altenbekenerdamm-kreuzung",
  "profile": "low_hanging_fruit"
}
```

**Auszug der Antwort (gekürzt):**

```jsonc
{
  "schemaVersion": "locationActionBrief.v1",
  "locationId": "hannover::altenbekenerdamm-kreuzung",
  "title": "Maßnahmensteckbrief: Altenbekener Damm (Hannover)",
  "problemSummary": "Im Bereich wurden 18 Unfälle erfasst (0 getötet, 5 schwer, 13 leicht). Dominante Konfliktmuster: Kfz/Rad-Abbiegekonflikt am Knotenpunkt.",
  "accidentProfile": { "total": 18, "fatal": 0, "serious": 5, "slight": 13, "ksiShare": 0.28 },
  "dominantPatterns": [
    { "id": "kfz_rad_abbiegekonflikt", "aliasId": "bicycle_turning_conflict",
      "label": "Kfz/Rad-Abbiegekonflikt am Knotenpunkt", "confidence": "high" }
  ],
  "conflictPatterns": [
    {
      "id": "kfz_rad_abbiegekonflikt",
      "aliasId": "bicycle_turning_conflict",
      "label": "Kfz/Rad-Abbiegekonflikt am Knotenpunkt",
      "classification": "primary",
      "confidence": "high",
      "evidence": ["involvement.bike=66%", "involvement.car=33%", "ksiShare=28%"],
      "rationale": "Erhöhter Anteil von Rad+Kfz mit Knotenpunkt-/Schwereindikatoren …",
      "requiresOnSiteCheck": ["Sichtverhältnisse prüfen", "Furtmarkierungen prüfen"]
    }
  ],
  "dataQuality": { "sampleSize": 18, "weakDataBasis": false, "dataConfidenceScore": 0.78 },
  "politicalContext": {
    "previousPoliticalAttention": "frequent",
    "policyReadiness": "high",
    "relatedReferences": [
      { "title": "Antrag: Sichere Querung …", "url": "https://…", "type": "Antrag", "relevance": 0.82 }
    ],
    "recurringRequests": [{ "topic": "radverkehr", "count": 3 }],
    "administrativeMomentumHints": ["Es liegen 4 Vorgänge aus dem letzten Jahr vor – das Thema ist politisch aktiv."]
  },
  "recommendedMeasures": [
    {
      "id": "qw_advance_green_bike",
      "title": "Vorgezogene Grünphase / separate Radsignalisierung prüfen",
      "category": "signaling",
      "fitScore": 0.71,
      "quickWinPotential": 0.62,
      "implementationEffort": "medium",
      "costBand": "medium",
      "matchedConflictPatterns": ["kfz_rad_abbiegekonflikt"],
      "expectedTargetAccidentTypes": ["bike_car", "bike_truck", "junction"],
      "whyPreselected": "adressiert Konfliktmuster: kfz_rad_abbiegekonflikt; fitScore=0.71, quickWinPotential=0.62"
    }
  ],
  "quickWins": [{ "id": "qw_marking_bike_lane", "title": "…", "quickWinPotential": 0.78 }],
  "infrastructureOptions": [{ "id": "inf_protected_bike_lane", "title": "…", "category": "cycle_protection", "costBand": "high" }],
  "deterministicFindings": {
    "locationScores": {
      "safetyImpactScore": 0.55, "severeAccidentReductionScore": 0.48,
      "bicycleSafetyScore": 0.82, "quickWinScore": 0.61,
      "implementationFeasibilityScore": 0.62, "policyReadinessScore": 0.78,
      "costEfficiencyScore": 0.58, "dataConfidenceScore": 0.78
    },
    "profileScores": [
      { "profile": "low_hanging_fruit", "total": 0.61, "weights": { /* … */ } },
      { "profile": "bicycle_safety_priority", "total": 0.69, "weights": { /* … */ } }
      /* … */
    ],
    "activeProfileScore": { "profile": "low_hanging_fruit", "total": 0.61 }
  },
  "modelInferences": null,
  "uncertainties": {
    "weakDataBasis": false,
    "lowConfidencePatterns": [],
    "secondaryHypotheses": ["ÖPNV-/Haltestellenbereich mit Konfliktpotenzial"],
    "requiresOnSiteCheck": ["Sichtverhältnisse aus Sicht von Kfz-Fahrenden auf Radverkehr prüfen"],
    "politicalContextMissing": false,
    "notes": ["Genaue Unfallhergänge sind nicht im offiziellen Datensatz enthalten."]
  },
  "recommendedActions": {
    "measures": [ /* gleich wie recommendedMeasures */ ],
    "quickWins": [ /* … */ ],
    "infrastructureOptions": [ /* … */ ],
    "suggestedNextSteps": [
      "Verkehrsschau / Ortstermin mit Polizei und Verwaltung anberaumen.",
      "Sachstand zu bereits laufenden Vorgängen einholen, bevor neue Anträge gestellt werden.",
      "Quick-Win prüfen: „Vorgezogene Grünphase / separate Radsignalisierung prüfen"."
    ]
  },
  "meta": {
    "schemaVersion": "locationActionBrief.v1",
    "profile": "low_hanging_fruit",
    "availableProfiles": ["low_hanging_fruit","bicycle_safety_priority","severe_accident_priority","policy_ready","cost_effective"],
    "requiredConflictPatternIds": ["bicycle_turning_conflict","bicycle_single_accident_surface","…"],
    "generatedWithAi": false,
    "city": "Hannover",
    "areaName": "Altenbekener Damm"
  }
}
```

---

## Tests

`tests/unit/locationBrief/locationBrief.test.js` deckt alle 10 vom Produkt
geforderten Szenariotypen sowie Profile, KI-Veredelungssicherheit und die
politische Kontextverdichtung ab. Die Suite läuft ohne KI-Provider.

```
npm test -- tests/unit/locationBrief
```
