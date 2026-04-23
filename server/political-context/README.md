# `server/political-context/` – Serverseitige politische Kontextrecherche

## Übersicht

Dieses Modul ermöglicht die serverseitige Recherche früherer politischer Vorgänge (Anträge,
Anfragen, Beschlüsse, Verwaltungsantworten, Protokolle) für einen markierten Kartenbereich.

Die Architektur ist **erweiterbar**: Neue Städte können durch einen zusätzlichen Provider
und einen Registry-Eintrag ergänzt werden, ohne die Export- oder KI-Logik zu ändern.

---

## Endpunkte

| Methode | Pfad                                  | Zweck                                          |
|--------:|---------------------------------------|------------------------------------------------|
| GET     | `/api/political-context/supported`    | Liste unterstützter Städte                     |
| POST    | `/api/political-context/search`       | Recherche politischer Vorgänge                 |

### POST `/api/political-context/search`

**Body (JSON):**
```json
{
  "city":        "Hannover",
  "searchTerms": ["Limmerstraße", "Stadtbezirk Linden"],
  "context": {
    "gremium": "Stadtbezirksrat Linden-Limmer"
  },
  "maxResults": 10
}
```

**Antwort:**
```json
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

---

## Modulstruktur

```
server/political-context/
├── registry/
│   └── cityPortalRegistry.js        # Stadt → Provider-Mapping
├── providers/
│   └── hannoverSimProvider.js       # Hannover SIM-Portal-Provider
├── services/
│   ├── portalSearchService.js       # Orchestrierung
│   ├── portalNormalizationService.js# Einheitliches internes Datenmodell
│   └── portalRelevanceService.js    # Relevanzbewertung + Sortierung
└── schemas/
    ├── politicalReference.schema.json
    └── politicalReferenceSearchResult.schema.json
```

---

## Provider-Konzept

Jeder Provider implementiert zwei Funktionen:

```js
// Gibt true zurück, wenn dieser Provider die Stadt unterstützt.
function supportsCity(city: string): boolean

// Sucht im Portal und gibt rohe Treffer zurück.
async function search(params: SearchParams): Promise<RawResult[]>
```

### Neue Stadt ergänzen

1. Neues Provider-Modul in `providers/` erstellen (z. B. `muenchenRisProvider.js`)
2. In `registry/cityPortalRegistry.js` einen neuen Eintrag hinzufügen:
   ```js
   const muenchenProvider = require('../providers/muenchenRisProvider.js');
   const REGISTRY = new Map([
     ['hannover', hannoverSimProvider],
     ['muenchen', muenchenProvider],   // neu
   ]);
   ```

Keine weitere Anpassung an Services, Endpunkten oder Export-Logik nötig.

---

## Datenmodell (`PoliticalReference`)

| Feld            | Typ              | Beschreibung                                    |
|:----------------|:-----------------|:------------------------------------------------|
| `id`            | `string`         | SHA-256-Präfix der URL (16 Hex-Zeichen)         |
| `title`         | `string`         | Titel des Vorgangs                              |
| `type`          | `string` (enum)  | Antrag / Anfrage / Änderungsantrag / Beschluss / Verwaltungsantwort / Protokoll / Sonstige |
| `date`          | `string\|null`   | Datum (deutsches oder ISO-Format)               |
| `gremium`       | `string\|null`   | Gremium / Ausschuss                             |
| `number`        | `string\|null`   | Drucksachennummer                               |
| `snippet`       | `string\|null`   | Textauszug (max. 400 Zeichen)                   |
| `url`           | `string`         | Link zur Dokumentenseite                        |
| `source`        | `string`         | Provider-Kürzel (z. B. `hannover-sim`)          |
| `relevanceScore`| `number\|null`   | Relevanzscore 0–100                             |

### Reicheres Referenzmodell (Folge-PR A)

Zusätzliche, **abwärtskompatible** Felder. Werden vom Provider befüllt; der
`portalNormalizationService` reicht sie unverändert durch (defensive Defaults
+ Schema-Validierung, kein erneutes Mapping).

| Feld            | Typ                 | Beschreibung                                                                                                  |
|:----------------|:--------------------|:--------------------------------------------------------------------------------------------------------------|
| `referenceType` | `string\|null` enum | Feinere fachliche Klassifikation für Antragsschreiber: `Antrag`, `Anfrage`, `Beschluss`, `Verwaltungsantwort`, `Protokollnotiz`, `verwandtes Thema`. Folge-PR C verfeinert die Heuristik. |
| `reason`        | `string\|null`      | Kurze, lokalisierte Begründung, warum dieser Treffer relevant ist (max. 240 Zeichen, ohne PII).               |
| `locationMatch` | `string\|null` enum | Welcher Ortsbezug wurde getroffen: `street`, `district`, `bbox`, `topic-only`.                                |
| `topicMatch`    | `string[]\|null`    | Suchbegriffe, die im Titel oder Snippet tatsächlich getroffen haben.                                          |
| `streetHints`   | `string[]`          | Im Titel/Snippet erkannte Straßennamen (Heuristik).                                                           |
| `areaHints`     | `string[]`          | Im Titel/Snippet erkannte Stadtbezirks-/Gebietsnamen (Heuristik).                                             |

---

## Umgebungsvariablen

| Variable                  | Standard | Beschreibung                                           |
|:--------------------------|:---------|:-------------------------------------------------------|
| `PORTAL_SEARCH_TIMEOUT_MS`| `10000`  | HTTP-Timeout für Portal-Anfragen (ms) – Hannover-Provider |

---

## Relevanzbewertung

| Faktor                      | Max. Punkte |
|:----------------------------|------------:|
| Titelübereinstimmung        |          50 |
| Snippet-Übereinstimmung     |          20 |
| Vorgangstyp-Relevanz        |          15 |
| Gremium-Übereinstimmung     |          10 |
| Aktualität (≤ 1 Jahr: voll) |           5 |
| **Gesamt**                  |     **100** |

---

## Frontend-Integration

Das Modul `js/ua.political-context.js` bietet:

- **Button** „🔍 Politische Vorgänge recherchieren" im Seitenbereich unter „Ausschnitt & Export"
- **Panel** mit Suchfeld, Trefferliste und Übernahme-Button
- **`UA.PoliticalContext.buildSearchTerms(ctx)`** – leitet automatisch Suchbegriffe aus
  Stadtname, Straßenname und Gremium ab
- **Übernahme in den Export**: Ausgewählte Vorgänge erscheinen im Word-/PDF-Export
  unter „Bisherige politische Befassung"
