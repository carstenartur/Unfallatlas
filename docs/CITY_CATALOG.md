# Bundesweiter Städte-/Regionen-Katalog

> Zentrale, maschinenlesbare Registry, die für jede unterstützte deutsche
> Stadt / Region transparent macht, **welche Funktionen der Werkbank
> dort verfügbar sind**.  Basis für die schrittweise Skalierung von
> „ausgewählte Großstädte" auf bundesweite Abdeckung.

## Wozu?

Nicht jede Stadt muss sofort alle Features mitbringen.  Damit das
Produkt trotzdem ganz Deutschland strukturiert abbilden kann, führt
Unfallatlas einen **bundesweiten Katalog** mit drei orthogonalen
Support-Stufen pro Ort:

| Stufe | Bezeichnung           | Bedeutung                                                      |
|:-----:|:----------------------|:---------------------------------------------------------------|
| **A** | Unfallanalyse         | Filter, Cluster, Heatmap, Hotspots, Export – Browser-Werkbank  |
| **B** | Politische Recherche  | Anbindung an ein Ratsinformationssystem (Anträge/Beschlüsse …) |
| **C** | Persistenz / Batch    | Maßnahmen-Steckbriefe, Top-N, Priorisierungen via Analysis-Service |

Jede Stufe wird pro Stadt als `supported`, `partially_supported` oder
`unsupported` ausgewiesen.  Damit kann eine Stadt z. B. „Level A
supported, B unsupported, C partially_supported" sein und trotzdem im
Produkt sichtbar bleiben.

## Wo lebt der Katalog?

```
server/cities/
├── cityCatalogData.json   # Daten – ohne Code-Änderung pflegbar
├── cityRegistry.js        # Loader, Validator, Lookups, Suche
└── supportLevels.js       # Konstanten + Helper für Stufen A/B/C
```

Das Modul wird beim ersten Zugriff lazy geladen und gecached.  Die
Daten werden beim Laden streng validiert (ids, Bundeslandkürzel,
Support-Status, http(s)-Portal-URLs); kaputte Einträge führen zum
Bootfehler.

## Schema eines Eintrags

| Feld                       | Pflicht | Beispiel                                       | Bedeutung                                                        |
|:---------------------------|:-------:|:-----------------------------------------------|:-----------------------------------------------------------------|
| `id`                       |   ✓     | `"frankfurt_am_main"`                          | normalisierter Slug (`[a-z0-9_]+`); stabiler Lookup-Schlüssel    |
| `displayName`              |   ✓     | `"Frankfurt am Main"`                          | Anzeigename inkl. Diakritika                                     |
| `state`                    |   ✓     | `"HE"`                                         | ISO 3166-2:DE-Kürzel (ohne `DE-`)                                |
| `officialCodes`            |   ✓     | `{ "land":"06", "kreis":"06412", "gemeinde":"06412000" }` | Amtliche Codes (Land/Reg.-Bez./Kreis/Gemeinde)        |
| `populationClass`          |         | `"metropolis"`                                 | `metropolis`, `large`, `medium`, `small` oder `null`             |
| `accidentDataSupport`      |   ✓     | `"supported"`                                  | Stufe A                                                          |
| `politicalContextSupport`  |   ✓     | `"partially_supported"`                        | Stufe B                                                          |
| `analysisServiceSupport`   |   ✓     | `"supported"`                                  | Stufe C                                                          |
| `rankingSupport`           |         | `"supported"`                                  | Eigenes Flag für Top-N/Priorisierung; defaultet auf C            |
| `knownPortalType`          |         | `"allris"`                                     | `allris`, `sim`, `parldok`, `sessionnet`, `ris`, `other`, `null` |
| `portalBaseUrl`            |         | `"https://…"`                                  | Nur http(s) erlaubt; rein dokumentarisch                         |
| `qualityFlags`             |         | `["state-capital","city-state"]`               | Frei vergebbare Hinweise (Landeshauptstadt, Stadtstaat …)        |

Status-Werte sind streng begrenzt auf `supported`,
`partially_supported`, `unsupported`.

## API

| Methode | Pfad                                | Zweck                                                          |
|--------:|:------------------------------------|:---------------------------------------------------------------|
| GET     | `/api/cities`                       | Liste mit Capability-Matrix (filterbar via `q`,`state`,`support`,`limit`) |
| GET     | `/api/cities/:idOrKey`              | Einzelner Ort (Lookup via id, Name oder Gemeindeschlüssel)     |
| GET     | `/api/status`                       | Capability-Übersicht inkl. `cities` (Gesamtzahl + Verteilung A/B/C) |

`GET /api/cities` liefert pro Eintrag zusätzlich ein `supportLevels`-
Objekt sowie ein `capabilities`-Boolean-Bündel.  Beispiel:

```json
{
  "id": "hannover",
  "displayName": "Hannover",
  "state": "NI",
  "officialCodes": { "land":"03","regierungsbezirk":null,"kreis":"03241","gemeinde":"03241001" },
  "populationClass": "metropolis",
  "accidentDataSupport": "supported",
  "politicalContextSupport": "supported",
  "analysisServiceSupport": "supported",
  "rankingSupport": "supported",
  "knownPortalType": "sim",
  "portalBaseUrl": "https://e-government.hannover-stadt.de/lhhsimwebre.nsf/ds_suchformular",
  "qualityFlags": ["state-capital"],
  "supportLevels": {
    "supportLevelA": "supported",
    "supportLevelB": "supported",
    "supportLevelC": "supported"
  },
  "capabilities": {
    "accidentAnalysis": true,
    "politicalContext": true,
    "analysisService":  true,
    "ranking":          true
  }
}
```

## Capability-Matrix (Stand der Initialdaten)

> Maschinell aus `summarize()` ablesbar – die untenstehende Tabelle
> hilft beim schnellen Überblick.  Vollständig: 34 Städte aus allen
> 16 Bundesländern.

| Stufe | supported | partially_supported | unsupported |
|:------|----------:|--------------------:|------------:|
| A – Unfallanalyse        | 12 | 22 | 0 |
| B – Politische Recherche |  4 |  0 | 30 |
| C – Persistenz / Batch   |  9 | 25 | 0 |

Die vier mit Level B `supported` sind die Städte mit angebundenem
Provider: **Hannover** (SIM), **Berlin** (Pardok + Bezirks-Allris),
**Bonn** (Allris/SessionNet), **Hamburg** (Parldok + Bezirks-Allris).

## Kopplung an die GitHub-Workflows

Stufe A (Unfallanalyse) ist nur dann ehrlich `supported`, wenn die
Workflows die GeoJSONs für die Stadt tatsächlich erzeugt haben.  Die
Master-Liste dafür ist die Datei [`cities.txt`](../cities.txt) im
Repository-Root, die von zwei Workflows abgearbeitet wird:

| Workflow                                              | Was wird erzeugt?                                | Output                                    |
|-------------------------------------------------------|--------------------------------------------------|-------------------------------------------|
| `.github/workflows/generate-and-commit.yml`           | Unfall-GeoJSONs (`convertAmt2gmaps.sh`)          | `out/output_all_years_<id>.geojson`       |
| `.github/workflows/fetchpoi.yml`                      | POI-GeoJSONs (Schulen/Kitas via OSM-Overpass)    | `out/poi_<id>.geojson`                    |

Der Slug-Algorithmus in `fetchpoi.yml` (`tr` + `sed`) ist identisch zu
`cityRegistry.normalizeCityName`; die Katalog-`id` einer Stadt **muss
exakt diesem Slug entsprechen**, sonst findet das Frontend die Datei
nicht.

Die Konsistenz wird per Test (`tests/unit/cityRegistry.test.js`,
Block „Kopplung an cities.txt und out/") fest abgesichert:

- jede Zeile in `cities.txt` muss einen Katalog-Eintrag mit derselben
  `id` haben
- **Materialisierungs-Honesty**: eine Stadt darf nur dann
  `accidentDataSupport: 'supported'` führen, wenn
  `out/output_all_years_<id>.geojson` tatsächlich existiert
- **Rollout-Invariante**: alle Katalog-Städte mit
  `accidentDataSupport: 'supported'` sind in `cities.txt` enthalten
  (cities.txt ⊇ supported, damit `Generate & Commit` die Stadt
  reproduzieren kann)
- alle Katalog-Städte ohne GeoJSON-Datei stehen auf
  `'partially_supported'` (im Katalog erfasst, Daten-Generierung steht
  noch aus)
- Städte mit `qualityFlag: "rollout-queued"` stehen in `cities.txt`,
  sind aber bis zum nächsten erfolgreichen Workflow-Lauf
  `partially_supported`

## Rollout-Strategie: erst >500k, dann >300k

Der Katalog ist bundesweit strukturiert, die *reale* Stufe-A-
Materialisierung wird aber bewusst stufenweise ausgerollt: zuerst
**Großstädte mit >500.000 Einwohnern** (Priorität 1), dann
**Großstädte mit >300.000 Einwohnern** (Priorität 2).  Begründung:

- Das Werkzeug richtet sich primär an urbane Räume mit ausreichender
  Unfallhäufung und hohem Nutzen für kommunale Maßnahmenplanung.
- Lieber ehrliche, belastbare Level-A-Abdeckung für große Städte als
  nominelle Vollabdeckung bei dünner Datenlage.
- Kleinere Städte und ländliche Räume bleiben im Katalog erhalten,
  laufen aber als `partially_supported`, bis ein konkreter Bedarf
  besteht.

Population-Klassen (Schema, gerundete Einwohnerwerte; Quelle:
Statistische Ämter des Bundes und der Länder, Stand 2023/2024):

| `populationClass` | Definition          | Beispiele                          |
|-------------------|---------------------|------------------------------------|
| `metropolis`      | > 500.000           | Berlin, Hamburg, München, Köln, …  |
| `large`           | 100.000 – 500.000   | Bonn, Bielefeld, Münster, …        |
| `medium`          | 20.000 – 100.000    | Schwerin                           |
| `small`           | < 20.000            | (derzeit nicht im Katalog)         |

Aktuelle Materialisierung (`accidentDataSupport: 'supported'`,
GeoJSON in `out/` vorhanden): Berlin, Hamburg, München, Köln,
Frankfurt am Main, Düsseldorf, Hannover, Bielefeld, Bonn,
Braunschweig, Heilbronn, Wolfsburg.

Aktuell in Rollout-Queue (`qualityFlag: "rollout-queued"`, in
`cities.txt`, noch nicht materialisiert):

- **Priorität 1 (>500k)**: Stuttgart, Leipzig, Dortmund, Essen,
  Bremen, Dresden, Nürnberg, Duisburg
- **Priorität 2 (>300k)**: Bochum, Wuppertal, Münster

Sobald der Workflow `Generate & Commit` für eine dieser Städte gelaufen
ist und die GeoJSON eingecheckt wurde, wird die Stadt nach dem unten
beschriebenen Verfahren auf `supported` hochgestuft.

## Kriterien `supported` vs. `partially_supported` (Stufe A)

| Status                  | Bedingung                                                                                                         |
|-------------------------|-------------------------------------------------------------------------------------------------------------------|
| `supported`             | Stadt steht in `cities.txt` **und** `out/output_all_years_<id>.geojson` existiert (Test: Materialisierungs-Honesty) |
| `partially_supported`   | Stadt im Katalog, aber GeoJSON liegt nicht (mehr) im Repo (Rollout-Queue oder noch nicht angefordert)             |
| `unsupported`           | Stadt ist im Katalog formal nicht erfasst (Stufe A explizit nicht zugesichert)                                    |

## Eine Stadt von `partially_supported` auf `supported` heben

1. **Stadtnamen in [`cities.txt`](../cities.txt)** ergänzen, exakt so
   geschrieben, dass `normalizeCityName(name)` die Katalog-`id` ergibt
   (z. B. `Frankfurt am Main` → `frankfurt_am_main`).
2. **Workflow `Generate & Commit`** triggern (Tab „Actions" auf
   GitHub, „Run workflow") – legt `out/output_all_years_<id>.geojson`
   und `out/output_all_years_<id>.csv` an.
3. **Workflow `Fetch POIs for cities.txt`** triggern – legt
   `out/poi_<id>.geojson` an.
4. **Im Katalog** `cityCatalogData.json`: `accidentDataSupport` auf
   `"supported"` setzen, `qualityFlags` um `"accident-data-generated"`
   und (sofern POIs erzeugt wurden) `"poi-generated"` ergänzen.  Falls
   die Stadt vorher `"rollout-queued"` trug, dieses Flag entfernen.
5. **Tests laufen lassen**: `npx jest --testPathPatterns=cityRegistry`.

## Graceful Degradation

- Suchen oder Detailansichten für **katalog-unbekannte** Orte sind
  weiterhin möglich; die Werkbank funktioniert browser-only ohne
  Server.
- `POST /api/political-context/search` antwortet für katalog-
  `unsupported` Städte mit `references: []` und
  `meta.supported: false` plus `meta.supportStatus`/`meta.supportLevels`
  – kein Fehler, kein unnötiger Provider-Call.
- Provider-Auflösung `getProviderForCity()` prüft den Katalog; ist
  dieser nicht ladbar, fällt das System auf das alte Verhalten zurück
  (Provider-Auswahl rein über die Map).

## Maintainer-Hinweise: Neue Stadt hinzufügen

> **Reihenfolge:** zuerst den Katalog-Eintrag (mit
> `accidentDataSupport: "partially_supported"`) anlegen.  Sobald die
> Workflows Daten erzeugt haben, auf `"supported"` heben (siehe
> Abschnitt „Eine Stadt von `partially_supported` auf `supported`
> heben").

1. **Eintrag in `server/cities/cityCatalogData.json`** anlegen.  Die
   `id` muss bereits in normalisierter Form vorliegen (`[a-z0-9_]+`,
   Umlaute → `ae/oe/ue/ss`).  Beispiel:
   ```json
   {
     "id": "leipzig",
     "displayName": "Leipzig",
     "state": "SN",
     "officialCodes": { "land":"14","kreis":"14713","gemeinde":"14713000" },
     "populationClass": "metropolis",
     "accidentDataSupport":     "partially_supported",
     "politicalContextSupport": "unsupported",
     "analysisServiceSupport":  "partially_supported",
     "rankingSupport":          "partially_supported",
     "knownPortalType": null,
     "portalBaseUrl":   null,
     "qualityFlags":    []
   }
   ```
2. **Tests laufen lassen**: `npx jest --testPathPatterns=cityRegistry`.
   Validierungsfehler werden direkt beim Laden gemeldet.
3. **Daten erzeugen** (für Stufe A `supported`): Stadt zu
   `cities.txt` hinzufügen und die Workflows
   `Generate & Commit` + `Fetch POIs for cities.txt` triggern, dann
   im Katalog `accidentDataSupport` auf `supported` setzen.
4. **Politische Recherche** für eine Stadt mit Provider freischalten:
   - Provider-Modul in `server/political-context/providers/` anlegen
   - Eintrag in `server/political-context/registry/cityPortalRegistry.js`
   - im Katalog `politicalContextSupport` auf `supported` (oder
     `partially_supported` bei Einschränkungen) setzen, `knownPortalType`
     und `portalBaseUrl` ergänzen.
5. **Persistenz/Batch** (Stufe C) wird nicht pro Stadt im Code
   abgebildet, sondern hängt am Analysis-Service.  Die Status-Angabe
   im Katalog dient der UI/Doku; die tatsächliche Verfügbarkeit
   meldet `/api/status`.

## Validierungsregeln

`cityRegistry` wirft bereits beim Laden, wenn:

- eine `id` doppelt ist
- `state` kein gültiges Bundesland-Kürzel ist
- ein Support-Status nicht zu `supported|partially_supported|unsupported` gehört
- `populationClass` außerhalb der erlaubten Werte liegt
- `knownPortalType` außerhalb der erlaubten Werte liegt
- `portalBaseUrl` keine http(s)-URL ist
- die JSON-Datei syntaktisch kaputt ist

Damit verhindert das System, dass kaputte Einträge stillschweigend
ins Frontend leaken.
