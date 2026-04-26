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
Support-Status, http(s)-Portal-URLs); kaputte Einträge führen daher
beim ersten Zugriff auf die Registry bzw. darauf basierende Endpunkte
oder Helper zu einem Fehler – nicht bereits beim Boot.

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
> hilft beim schnellen Überblick.  Vollständig: 44 Städte aus allen
> 16 Bundesländern.

| Stufe | supported | partially_supported | unsupported |
|:------|----------:|--------------------:|------------:|
| A – Unfallanalyse        | 23 | 11 | 10 |
| B – Politische Recherche |  9 | 29 |  6 |
| C – Persistenz / Batch   |  9 | 25 | 10 |

Die neun mit Level B `supported` sind die Städte mit angebundenem
Provider: **Hannover** (SIM), **Berlin** (Pardok + Bezirks-Allris),
**Bonn** (Allris/SessionNet), **Hamburg** (Parldok + Bezirks-Allris)
sowie **Bielefeld**, **Chemnitz**, **Halle (Saale)**, **Magdeburg**
und **Nürnberg** (alle über den generischen
[`sessionNetProvider`](../server/political-context/providers/sessionNetProvider.js)
für klassische SessionNet-Portale `<base>/bi/info.asp`).
Die 29 mit Level B `partially_supported` haben einen Portallink aus
der kuratierten Seed-Liste (siehe [Stufe B – Portal-Seed-Liste](#stufe-b--portal-seed-liste-fuer-grosse-staedte)),
aber noch keinen Provider.

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
GeoJSON in `out/` vorhanden) – **23 große Städte**:

- **Priorität 1 (>500.000 Einwohner)**: Berlin, Hamburg, München,
  Köln, Frankfurt am Main, Stuttgart, Düsseldorf, Leipzig, Dortmund,
  Essen, Bremen, Dresden, Hannover, Nürnberg, Duisburg.
- **Priorität 2 (>300.000 Einwohner)**: Bochum, Wuppertal, Bielefeld,
  Bonn, Münster.
- **Weitere materialisierte Städte (NI/BW)**: Braunschweig, Wolfsburg,
  Heilbronn.

Aktuell in Rollout-Queue (`qualityFlag: "rollout-queued"`, in
`cities.txt`, noch nicht materialisiert):

- **Priorität 2 (>300k, BW/BY)**: Karlsruhe, Mannheim, Augsburg.

Sobald der Workflow `Generate & Commit` für eine dieser Städte gelaufen
ist und die GeoJSON eingecheckt wurde, wird die Stadt nach dem unten
beschriebenen Verfahren auf `supported` hochgestuft.  Das Diagnose-
Skript [`scripts/check-city-rollout.js`](../scripts/check-city-rollout.js)
listet jederzeit alle hochstufungsreifen Kandidaten.

## Kriterien `supported` vs. `partially_supported` (Stufe A)

| Status                  | Bedingung                                                                                                         |
|-------------------------|-------------------------------------------------------------------------------------------------------------------|
| `supported`             | Stadt steht in `cities.txt` **und** `out/output_all_years_<id>.geojson` existiert (Test: Materialisierungs-Honesty) |
| `partially_supported`   | Stadt im Katalog, aber GeoJSON liegt nicht (mehr) im Repo (Rollout-Queue oder noch nicht angefordert)             |
| `unsupported`           | Stadt ist im Katalog formal nicht erfasst (Stufe A explizit nicht zugesichert)                                    |

## Eine Stadt von `partially_supported` auf `supported` heben

> **Tipp:** Mit `node scripts/check-city-rollout.js` (alias `--json` für
> maschinenlesbar) bekommst du jederzeit eine Liste der Städte, die
> *bereits* Workflow-Daten in `out/` haben, im Katalog aber noch nicht
> auf `supported` stehen – das sind die offenen Upgrade-Kandidaten.

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
5. **Diagnose laufen lassen**: `node scripts/check-city-rollout.js`.
   Sektion 1 sollte deine Stadt nicht mehr listen, Sektion 2/3 müssen
   leer sein.
6. **Tests laufen lassen**: `npx jest --testPathPatterns="cityRegistry|checkCityRollout"`.

### Bedingungen pro Stufe (Kurzfassung)

| Stufe | `supported` setzt voraus                                             |
|:-----:|:---------------------------------------------------------------------|
| **A** | Stadt in `cities.txt` **und** `out/output_all_years_<id>.geojson` vorhanden |
| **B** | konkretes Portal (`portalBaseUrl` + `knownPortalType`) **und** registrierter Provider in `cityPortalRegistry.js` |
| **C** | Persistenz/Batch im Analysis-Service real verfügbar (Schema, Migrationen, Job-Konfiguration) |

`partially_supported` ist die ehrliche Zwischenstufe (z. B. „Portal ist
bekannt, aber der Provider folgt"), `unsupported` heißt: bewusst nicht
zugesichert.

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

## Stufe B – Portal-Seed-Liste für große Städte

Die Capability-Stufe B (politische Kontextrecherche) wird gezielt für
große deutsche Städte angereichert.  Grundlage ist eine **kuratierte
Seed-Liste** mit Rats-/Bürgerinformationsportalen (Stand: 37 Städte,
PR „Portal-Seed").  Die Seed-Liste fließt direkt in
`cityCatalogData.json` ein – pro Stadt werden `knownPortalType`,
`portalBaseUrl` und `politicalContextSupport` gepflegt.

**Wichtiger Leitsatz**: Es findet keine freie Webrecherche im Agenten
statt.  Neue Portale müssen über die Seed-Liste eingespielt werden.

### Einstufung politischer Recherche (Stufe B)

| Status                  | Bedingung                                                                                                  |
|-------------------------|------------------------------------------------------------------------------------------------------------|
| `supported`             | Konkretes Portal **und** registrierter Provider in `server/political-context/registry/cityPortalRegistry.js` |
| `partially_supported`   | Konkretes Portal aus Seed-Liste hinterlegt, aber noch kein Provider (UI/API zeigt das ehrlich an)          |
| `unsupported`           | Kein belastbarer Portalbezug bekannt – Stufe B explizit nicht zugesichert                                  |

Der Test `cityRegistry – Portal-Seed-Konsistenz` wacht über diese
Invariante (jede Stadt mit `partially_supported`/`supported` hat ein
Portal; keine `unsupported`-Stadt trägt einen verwaisten Portallink).

### Portal-Familien (`knownPortalType`)

| Wert         | Beispiele                                                |
|--------------|----------------------------------------------------------|
| `allris`     | Stuttgart, Augsburg, Kiel, Oberhausen, Aachen, Rostock   |
| `sim`        | Hannover                                                 |
| `parldok`    | Hamburg                                                  |
| `sessionnet` | Bremen, Bielefeld, Mainz, Halle (Saale), Chemnitz, Kassel|
| `ris`        | München, Essen, Wuppertal, Nürnberg, Krefeld, Freiburg   |
| `other`      | Köln, Frankfurt, Düsseldorf, Leipzig, Dortmund, …        |

Die Portal-Familie ist eine Heuristik nach URL-/Anbieterstruktur und
hilft, künftig generische Provider-Adapter (z. B. ein
`SessionNetProvider`) für mehrere Städte gleichzeitig zu schreiben.

### Aktuell aus der Seed-Liste gepflegte Städte

Mit Stand des Portal-Seed-PR sind 38 Städte mit konkreten Portal-
referenzen ausgestattet (Flag `portal-from-seed`):

- **Bereits mit Provider (Stufe B `supported`)**: Berlin, Hamburg,
  Hannover, Bonn (jeweils dedizierter Provider) sowie Bielefeld,
  Chemnitz, Halle (Saale), Magdeburg, Nürnberg (über den generischen
  [`sessionNetProvider`](../server/political-context/providers/sessionNetProvider.js)).
- **Portal hinterlegt, Provider folgt (Stufe B `partially_supported`)**:
  München, Köln, Frankfurt am Main, Stuttgart, Düsseldorf, Leipzig,
  Dortmund, Essen, Bremen, Dresden, Duisburg, Bochum,
  Wuppertal, Münster, Karlsruhe, Mannheim, Augsburg,
  Wiesbaden, Braunschweig, Kiel, Mainz, Gelsenkirchen,
  Aachen, Freiburg im Breisgau, Lübeck,
  Krefeld, Oberhausen, Rostock, Kassel.

Nicht in der aktuellen Seed-Liste enthaltene Katalog-Städte (z. B.
Erfurt, Saarbrücken, Potsdam, Schwerin, Heilbronn, Wolfsburg) bleiben
auf `politicalContextSupport: 'unsupported'` und tragen kein Portal.

### Eine neue Stadt aus der Seed-Liste in den Katalog überführen

1. Eintrag in `server/cities/cityCatalogData.json` ergänzen oder
   bestehende Stadt befüllen mit `knownPortalType`, `portalBaseUrl`
   (`https://…`) und `qualityFlags: ["portal-from-seed", …]`.
2. `politicalContextSupport` auf `partially_supported` setzen
   (oder `supported`, falls auch ein Provider in
   `cityPortalRegistry.js` registriert wird).
3. Tests laufen lassen:
   `npx jest --testPathPatterns=cityRegistry`.

### Eine Stadt von Stufe B `partially_supported` auf `supported` heben

1. Provider-Modul unter `server/political-context/providers/` anlegen
   (z. B. `dortmundOtherProvider.js`).
2. In `server/political-context/registry/cityPortalRegistry.js` die
   Stadt-Map `REGISTRY` um den Provider ergänzen.
3. `politicalContextSupport` im Katalog auf `supported` setzen.
4. Tests + `npx jest --testPathPatterns="cityRegistry|political"`.

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
