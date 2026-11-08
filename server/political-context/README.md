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
│   ├── _portalUtils.js              # Geteilte HTTP-/HTML-/Heuristik-Helfer
│   ├── hannoverSimProvider.js       # Hannover SIM-Portal
│   ├── berlinAllrisProvider.js      # Berlin Pardok + Bezirks-Allris
│   ├── bonnAllrisProvider.js        # Bonn Bürgerinfo (Allris/SessionNet)
│   └── hamburgParldokProvider.js    # Hamburg Parldok + Bezirks-Allris
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
     ['berlin',   berlinAllrisProvider],
     ['bonn',     bonnAllrisProvider],
     ['hamburg',  hamburgParldokProvider],
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

### Verkehrsrelevanz-Gating (Folge-PR D)

Zusätzliche, **abwärtskompatible** Felder.  Werden serverseitig vom
`trafficRelevanceService` und `aiGatingService` gesetzt; rein deterministisch,
keine KI.

| Feld                    | Typ                              | Beschreibung                                                                                                  |
|:------------------------|:---------------------------------|:--------------------------------------------------------------------------------------------------------------|
| `trafficCategory`       | `'direct_traffic'\|'indirect_traffic'\|'non_traffic'\|null` | Verkehrsfachliche Einordnung (direkt / indirekt / kein Bezug).                                                |
| `trafficRelevanceScore` | `number\|null`                   | Verkehrsrelevanz-Score 0–100.                                                                                 |
| `trafficSubtopics`      | `string[]`                       | Erkannte Subthemen (z. B. `Radverkehr`, `Verkehrssicherheit`, `Knotenpunkt/Ampel`).                           |
| `isTrafficRelevant`     | `boolean`                        | Convenience-Flag: `true`, wenn `trafficCategory ∈ {direct,indirect}` **und** `trafficRelevanceScore ≥ 20`.    |
| `trafficReason`         | `string\|null`                   | Lesbare Kurzbegründung der Verkehrsklassifikation (max. 240 Zeichen).                                         |
| `aiGating`              | `{ allowed: boolean, reason: string }\|null` | Ergebnis von `shouldAllowForAiEvaluation` – maschinenlesbare KI-Zulassungsentscheidung mit Begründung.        |

**Variantensuche** (Recall-Verbesserung): der `portalSearchService` erweitert
die Originalbegriffe per `searchVariantBuilder` um Kombinationen wie
`Straße + Radverkehr`, `Straße + Verkehrssicherheit`, `Straße + Gremium`,
`Stadtbezirk + Straße`, `Thema + Stadtteil` (max. 8 Varianten,
case-insensitiv dedupliziert).  Die ursprünglichen Begriffe bleiben in
`meta.searchTerms` erhalten.  Deaktivierbar pro Aufruf via
`expandVariants: false`.

**KI-Zulassungslogik** (`server/political-context/services/aiGatingService.js`,
Funktion `shouldAllowForAiEvaluation(reference, context)`):

- `non_traffic` → **nie** an die KI weitergeben.
- `direct_traffic` → nur mit brauchbarem Orts- *oder* Themenbezug
  (`locationMatch` ∈ {street, district, bbox} **oder** `topicMatch`/`streetHints`/`areaHints`
  nicht leer).
- `indirect_traffic` → nur mit *gutem* Ortsbezug (`locationMatch` ∈ {street, district})
  **oder** mindestens einem `topicMatch`.

Die Suche bleibt damit bewusst breit; die fachliche Auswahl für die
KI-Bewertung erfolgt zentral und deterministisch – keine KI-basierte
Erst­klassifikation.

---

## Umgebungsvariablen

| Variable                  | Standard | Beschreibung                                           |
|:--------------------------|:---------|:-------------------------------------------------------|
| `PORTAL_SEARCH_TIMEOUT_MS`| `10000`  | HTTP-Timeout für Portal-Anfragen (ms) – alle Provider  |

---

## Unterstützte Städte

| Stadtschlüssel | Provider-Modul                       | `_key`            | Portal                                                                                                  |
|:---------------|:-------------------------------------|:------------------|:--------------------------------------------------------------------------------------------------------|
| `hannover`     | `providers/hannoverSimProvider.js`   | `hannover-sim`    | [Hannover SIM-Ratsinformation](https://e-government.hannover-stadt.de/lhhsimwebre.nsf/ds_suchformular)  |
| `berlin`       | `providers/berlinAllrisProvider.js`  | `berlin-allris`   | [Pardok Abgeordnetenhaus Berlin](https://pardok.parlament-berlin.de/) (+ Bezirks-Allris)                |
| `bonn`         | `providers/bonnAllrisProvider.js`    | `bonn-allris`     | [Bonner Bürgerinfo (Allris)](https://www2.bonn.de/bo_ris/ws_buergerinfo/buergerinfo.asp)                |
| `hamburg`      | `providers/hamburgParldokProvider.js`| `hamburg-parldok` | [Parldok Hamburgische Bürgerschaft](https://www.buergerschaft-hh.de/parldok/formalkriterien) (+ Bezirke) |

Provider-URLs sind ausschließlich im jeweiligen Modul hartkodiert; es findet
keine URL-Konstruktion aus Nutzereingaben statt (keine SSRF-Angriffsfläche).
Berlin und Hamburg bündeln Land/Bürgerschaft sowie die Bezirks-Allris-Endpunkte
in einer konfigurierbaren Liste innerhalb des jeweiligen Provider-Moduls.

> **Katalog-Gating:** `getProviderForCity` prüft den zentralen
> [Städte-Katalog](../../docs/CITY_CATALOG.md).  Steht `politicalContextSupport`
> einer Stadt dort auf `unsupported`, wird kein Provider zurückgegeben –
> auch wenn ein Provider physisch registriert ist.  Damit lässt sich
> politische Recherche pro Ort gezielt deaktivieren (z. B. bei
> Portal-Wartung oder bekannten Datenproblemen), ohne den Provider
> entfernen zu müssen.  `getProviderForCityRaw` umgeht das Gating für
> interne Tests/Migrationen.

---

## Veröffentlichte Ratsdaten und Karte

Bonn und Hannover teilen sich ein versioniertes Format unter `data/ris/`. Version 2 trennt
Vorgänge, Suchindex, Ortsbelege, Beziehungen und räumliche Kartenobjekte in begrenzte,
bedarfsgerecht geladene Teile. Das kleine Manifest nennt Quellen, Datenstand,
Zeitraum und erfasste Gremien. Jede Datei ist per SHA-256 geprüft. Die Recherche in der
Werkbank sucht nach Titel, Drucksachennummer oder Ortsangabe und zeigt verknüpfte Anfragen und Antworten.
Die amtlichen Dokumente bleiben über ihre Original-URL erreichbar. Ausgewählte Vorgänge
erscheinen im Bericht.

| Stadt | Quelle und Umfang |
|---|---|
| Bonn | Öffentliche OParl-Drucksachen; konfigurierbarer historischer Suchbeginn, standardmäßig 2014. Der tatsächlich geprüfte Zeitraum steht im Manifest. |
| Hannover | Öffentliche SIM-Vorlagensuche für alle Gremien, jahrgangsweise standardmäßig ab 2014, ergänzt durch aktuelle SIM-Feeds und verlinkte Vorgänge. Bereits veröffentlichte ältere Jahrgänge bleiben erhalten. |

Der Schalter „Ratsvorgänge“ im gemeinsamen schwebenden Menü „Karte“ ist anfangs aus. In Hannover werden benannte
Kreuzungen, Abschnitte und verkehrsbezogene Hausnummern aus Titel und öffentlichem Maßnahmentext
mit dem [Ortsverzeichnis](../../config/ris-locations/README.md) abgeglichen. Die Recherche zeigt
je Ort die Fundstelle und öffnet eine belegte Geometrie mit „Auf Karte zeigen“. Ortsangaben mit
offener Geometrie bleiben in der Suche sichtbar. Die Karte unterscheidet amtliche Geometrien,
abgeleitete Lagen und reine Straßenbezüge. Der Datenstand bleibt in Recherche und Bericht sichtbar.

Alle Indexeinträge beider Städte durchlaufen denselben Ortsabgleich. Das gemeinsame
`locationAssessment` nennt die geprüften Grundlagen (`title`, `document`, `official`),
den Status und gegebenenfalls Einschränkungen. `mapped` bezeichnet belegte Kartenlagen,
`partial` belegte Kartenlagen mit offenen oder begrenzten Belegen, `unresolved` eine
erfolglose räumliche Zuordnung und `unavailable` fehlende geeignete Ortsdaten. Das Manifest
zählt geprüfte Einträge und die vier Ergebnisse getrennt von der Zahl der Kartenobjekte.
Eine Prüfung jedes Eintrags bedeutet daher keine erfolgreiche Verortung jedes Eintrags.
Bestehende amtliche Geometrien bleiben erhalten; abgeleitete Orte werden bei jeder
Neubewertung ersetzt. Version 2 erhält auch mehr als acht Ortsbelege je Vorgang und lädt
längere Ortslisten seitenweise. Fehlende Dokumenttexte und Begrenzungen bei der
Texterschließung bleiben im Prüfstatus sichtbar. Der Leser unterstützt weiterhin Version 1.

Nicht verortete Vorgänge und offene Ortsangaben bleiben im vollständigen Dokumenten- und
Suchbestand. Die Karte fordert ausschließlich räumliche Teile für ihren Ausschnitt an.
Dokumentdetails, Ortsbelege und verknüpfte Antworten werden beim Öffnen nachgeladen.
Bei großen oder dichten Ausschnitten zeigen ausdrücklich bezeichnete Übersichtsflächen
die räumliche Verteilung; sie sind keine behaupteten Einzelpositionen.

Hannover übermittelt für jeden Jahrgang eine Suche ohne Stichwort, mit allen Typen und
Gremien sowie allen Ergebnissen. Der Import vergleicht die gelesenen Tabellenzeilen mit
der amtlich genannten Trefferzahl. Nicht verfügbare Detailseiten verlieren dadurch ihren
verifizierten Listeneintrag nicht. `coverage.scope: "citywide"` beschreibt den stadtweiten
Suchumfang; `complete: false` bleibt bestehen, da damit keine Vollständigkeit des gesamten
amtlichen Archivs nachgewiesen ist. Ältere Kataloge ohne diese optionalen Felder bleiben lesbar.

`node scripts/refresh-ris-catalogues.js` ruft die städtischen Quellen ab und schreibt die Kataloge.
Mit `--city bonn` beziehungsweise `--city hannover` lässt sich derselbe Ablauf auf eine Stadt
begrenzen. Erfolgreich geprüfte Quelldaten liegen im gemeinsamen Cache `.cache/ris-sources/`.
Quellrevision, Parserrevision und eine maximale Lebensdauer von sieben Tagen verhindern die
unbegrenzte Wiederverwendung alter Antworten. Fehlgeschlagene Abrufe werden nicht gespeichert.
Die bestehenden Pages-Workflows sichern diesen Cache auch nach einem fehlgeschlagenen Build.
Zusätzliche, nach Quelle, Umfang und Jahr getrennte Arbeitsstände erhalten bereits erledigte
Quellarbeit über Zeitlimits hinweg. `--history-start-year 2014` konfiguriert den Suchbeginn;
`--work-budget N` und `--max-duration-ms N` begrenzen einen fortsetzbaren Arbeitsdurchlauf.
Ein erneuter Aufruf setzt offene Arbeit fort. Die Veröffentlichung umfasst das Manifest
und sämtliche von seinen Indexbäumen referenzierten komprimierten Dateien.
Ein Katalog gilt nach acht Tagen als veraltet und läuft 14 Tage nach seiner ursprünglichen
Erstellung ab. Schlägt die Aktualisierung für Pages fehl, kennzeichnet das Manifest den letzten
verifizierten Stand mit `refreshFailure` (Zeitpunkt, Grund und Ablaufdatum). Datenstand und
erfasster Umfang bleiben erhalten. Normale Builds übernehmen lokal vorhandene Kataloge ohne Netzabruf.
Fehlt einem noch gültigen, verifizierten Bestand der aktuelle Ortsprüfstatus, kann derselbe
Ablauf ihn auch bei Quellausfall lokal ergänzen. Dafür werden Titel, bereits gespeicherte
Belegauszüge und amtliche Kartenlagen erneut bewertet. Begrenzte oder fehlende Dokumenttexte
werden ausdrücklich markiert. Quellzeit, Umfang, Wiederholungsfrist und Ablaufdatum bleiben
unverändert; `--restore-only` übernimmt weiterhin exakt den veröffentlichten Bestand.
Für einen Docker-Build mit veröffentlichten Katalogen steht `--build-arg RESTORE_PUBLISHED_RIS=1`
zur Verfügung. Der Browser benötigt für die Kartenprüfung HTTPS oder `localhost`.

Weitere Städte liefern ihre öffentlichen Vorgänge über einen Adapter im gemeinsamen Format.
Die Veröffentlichung erhält dafür einen Eintrag im Erneuerungsskript. Straßenableitungen
verwenden die dokumentierten, stadtbezogenen Referenzen unter `config/ris-locations/`.
Format, Budgets, Migration und Betrieb sind in [Ratsdatenkataloge](../../docs/ris-catalogue.md)
beschrieben.

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
