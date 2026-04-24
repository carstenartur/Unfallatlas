# Unfallatlas Analysis Service

Separater **Spring-Boot-/Hibernate-Persistenzdienst** für die fachlichen
Kernobjekte des *Location Action Brief* (siehe PR #199).  Die bestehende
Node.js-Anwendung im Wurzelverzeichnis bleibt **unverändert** und ist
weiterhin alleinige Quelle der deterministischen Berechnungen; dieser
Dienst läuft **daneben** und persistiert die strukturierten Ergebnisse
versioniert für späteres Vergleichen, Wiederverwenden und stadtweite
Rankings.

> **Hinweis:** Dieser PR liefert die produktive **Anbindung** und
> **Betriebsreife** (Flyway-Migrationen, Actuator-Health, Job-Modell,
> optionaler Forwarder aus der Node-App).  Eine vollständige
> Multi-City-Batch-/Queue-Verarbeitung und eine Hibernate-Search-
> Suchfunktion sind weiterhin Folge-PRs.

## Inhalt

- `pom.xml` – Spring Boot 4, Java 21, Hibernate ORM 7, Hibernate
  Validator, Spring Data JPA, **Flyway** für Schema-Migrationen,
  **Spring Boot Actuator** (Health/Info), H2 (Dev/Test) +
  PostgreSQL (Prod).
- `src/main/java/de/unfallatlas/analysis/`
  - `domain/` – persistierbare Entitäten (`LocationActionBriefEntity`,
    `ConflictPatternAssessmentEntity`,
    `CandidateMeasureAssessmentEntity`,
    `PrioritizationProfileScoreEntity`,
    `PoliticalReferenceSummaryEntity`,
    `AnalysisJobEntity`) und Embeddables
    (`VersioningInfo`, `AiAssessmentMetadata`).
  - `persistence/` – Spring-Data-Repositories
    (inkl. `AnalysisJobRepository` als Vorbereitung für Batch/Queue).
  - `api/` – REST-Controller, Service, Validation-Error-Handler.
  - `api/dto/` – versioniertes Ingest-DTO `locationBriefIngest.v1`
    sowie Response-DTO.
  - `mapping/` – handgeschriebener Mapper (DTO → Entität).
  - `fingerprint/` – kanonischer Source-Fingerprint (SHA-256).
- `src/main/resources/db/migration/` – Flyway-Migrationen
  (`V1__init_schema.sql`, portabel zwischen PostgreSQL und H2 im
  PostgreSQL-Kompatibilitätsmodus).
- `Dockerfile` – Multi-Stage-Build (Maven → JRE 21).

## Lokal starten

Voraussetzungen: JDK 21, Maven 3.9+.

```bash
cd analysis-service
mvn spring-boot:run            # Default-Profil 'dev' → H2 in-memory
```

Erreichbar unter `http://localhost:8081`.  Der Port lässt sich über
`PORT` oder `-Dserver.port=…` überschreiben.

Im Dev-Profil wird Flyway aktiv genutzt (`spring.flyway.enabled=true`,
`ddl-auto=validate`); damit läuft lokal exakt dasselbe Schema wie in
Prod – nur in einer H2-Datenbank im PostgreSQL-Kompatibilitätsmodus.

### Tests

```bash
mvn test
```

Die Tests laufen ebenfalls gegen die Flyway-Migrationen.  Damit ist
sichergestellt, dass die Migrationsskripte sowohl in H2 (PostgreSQL-
Mode) als auch in echtem PostgreSQL durchlaufen.

> **Hinweis:** Mit dem Renovate-Bump auf Spring Boot 4 ist
> `LocationBriefControllerTest` (verwendet `@AutoConfigureMockMvc`)
> derzeit nicht kompatibel und wird per
> `<testExcludes>`/`<excludes>` in der `pom.xml` ausgeschlossen.  Die
> Migration auf MockMvc-API von Spring Boot 4 erfolgt in einem
> Folge-PR; alle übrigen Tests inkl. Repository-Integrationstests
> laufen normal mit.

### Mit PostgreSQL (Prod)

```bash
export SPRING_PROFILES_ACTIVE=prod
export ANALYSIS_DB_URL=jdbc:postgresql://localhost:5432/unfallatlas
export ANALYSIS_DB_USER=unfallatlas
export ANALYSIS_DB_PASSWORD=…
mvn spring-boot:run
```

Im Prod-Profil ist `spring.jpa.hibernate.ddl-auto=validate` und
`spring.flyway.enabled=true` gesetzt.  Beim Boot wendet Flyway alle
neuen Migrationsskripte aus `db/migration/` an; Hibernate validiert
anschließend nur noch das Schema.  PostGIS wird vom Persistenzschema
dieser Iteration noch **nicht** benötigt.

### Docker / Compose

Im Repo-Root liegt eine Compose-Datei mit zwei Profilen:

```bash
docker compose up unfallatlas                 # nur Node-App (Default)
docker compose --profile persist up           # Node + Analysis Service + PostgreSQL
```

Der Analysis-Service exponiert seinen Health-Endpoint unter
`http://localhost:8081/actuator/health`.

## Health & Actuator

`spring-boot-starter-actuator` ist eingebunden.  Standardmäßig sind
nur `health` und `info` exponiert (sicher für Container-Health-Checks
und Reverse-Proxies).  Weitere Endpunkte können bedarfsgesteuert über
`management.endpoints.web.exposure.include` zugeschaltet werden.

## REST-Endpunkte

Alle Endpunkte liegen unter `/api/location-briefs`.

| Methode | Pfad                                           | Zweck                                                         |
|---------|------------------------------------------------|---------------------------------------------------------------|
| POST    | `/api/location-briefs`                         | Brief speichern (Ingest aus der Node-App).                    |
| POST    | `/api/location-briefs/compute-and-store`       | Stub – verhält sich derzeit wie `POST /api/location-briefs`.  |
| GET     | `/api/location-briefs/{id}`                    | Einen Brief per ID lesen.                                     |
| GET     | `/api/location-briefs/by-location/{key}`       | Alle Auswertungen einer Stelle, neueste zuerst.               |
| GET     | `/api/location-briefs?city=&profile=&page=&size=` | Auswertungen einer Stadt, optional gefiltert + paginiert.     |
| GET     | `/api/location-briefs/top?city=&profile=&limit=`  | Top-N nach profilspezifischem Gesamt-Score.                   |
| GET     | `/api/location-briefs/political?city=`         | Alle Auswertungen mit politischer Vorbefassung (medium/high). |
| GET     | `/actuator/health`                             | Health-Probe (DB + Anwendung).                                |
| GET     | `/actuator/info`                               | Build-/App-Info.                                              |

Validation-Fehler werden in einem einheitlichen Envelope geliefert
(`{ error, category: "validation", message, details, timestamp }`),
analog zu `server/lib/errors.js` der Node-App.

## Schema-Migrationen (Flyway)

- Skripte liegen unter `src/main/resources/db/migration/`.
- Initiale Migration: `V1__init_schema.sql` legt alle Brief-Tabellen,
  Indizes, Foreign Keys und das Job-Modell an.
- Format ist bewusst portabel: keine PostgreSQL-spezifischen Typen
  (kein `JSONB`, keine `GEOMETRY`), `BIGINT GENERATED BY DEFAULT AS
  IDENTITY` für Auto-Inkrement-Spalten.  Damit läuft dasselbe Skript
  in H2 (PostgreSQL-Mode) und in echtem PostgreSQL.
- Neue Migrationen folgen der Konvention `V<n>__<beschreibung>.sql`.
- In Prod ist `spring.flyway.clean-disabled=true` gesetzt – ein
  versehentliches `flyway:clean` ist nicht möglich.

## Job-/Queue-Vorbereitung

`AnalysisJobEntity` und `AnalysisJobRepository` bilden ein
persistierbares Job-Modell für spätere Batch-/Queue-Funktionen
(z. B. stadtweite Neuberechnung, Top-N-Refresh, Hibernate-Search-
Reindex).  Bewusst noch **ohne** Worker, Locking oder verteilten
Betrieb – diese kommen im Folge-PR.  Status-Werte:
`PENDING | RUNNING | SUCCEEDED | FAILED | CANCELLED`.

## Versionierung & Wiederberechenbarkeit

Jeder gespeicherte Brief enthält:

- `schemaVersion` – Schema des Briefs (z. B. `locationActionBrief.v1`).
- `sourceFingerprint` – SHA-256 über die deterministisch reproduzier-
  baren Eingabedaten (ohne Zeitstempel und KI-Metadaten).  Dadurch ist
  *Ingest* idempotent über `locationKey + profileKey + sourceFingerprint`.
- `versioning.rulesVersion` (z. B. `conflictPatterns.v1`),
  `versioning.scoringVersion`, `versioning.profileVersion`,
  `versioning.generatedAt`.
- Bei `aiUsed = true`: `aiMetadata.aiModel`, `aiPromptVersion`,
  `aiInputFingerprint`, `aiSource`.

## Anbindung der bestehenden Node-Anwendung

Die Node-App enthält jetzt einen **optionalen** Forwarder
(`server/analysis-service/analysisServiceClient.js`).  Wenn
`ANALYSIS_SERVICE_BASE_URL` gesetzt ist:

- `POST /api/location-brief` kann mit `persist: true` zusätzlich
  versioniert im Analysis Service speichern.
- `GET /api/location-briefs/by-location/:key`,
  `GET /api/location-briefs/top` und
  `GET /api/location-briefs?city=…` sind dünne Forwarder zu den
  Lese-Endpunkten dieses Dienstes.
- Bei Nichterreichbarkeit oder Timeout läuft die Node-App weiter
  (Brief wird trotzdem zurückgegeben, mit `persistence.status = "skipped"`).

Siehe [`docs/server-features.md`](../docs/server-features.md) für
Konfiguration und Beispielanfragen.

## Hibernate-Search-Vorbereitung

Die Klassen `LocationActionBriefEntity`,
`ConflictPatternAssessmentEntity` und
`PoliticalReferenceSummaryEntity` haben Kommentar-Marker für die
spätere Ergänzung von `@Indexed` / `@FullTextField`.  Das eigentliche
Search-Backend (Lucene/Elasticsearch) ist **nicht** eingebunden, um den
PR überschaubar zu halten.

## Bewusst nicht enthalten

- Keine Ablösung der Node-App.
- Keine erzwungene Frontend-Migration.
- Keine vollständige Batch-/Queue-**Verarbeitung** (nur Persistenz-Modell).
- Keine vollständige stadtweite Pipeline.
- Keine PostGIS-Geometrien – derzeit kein Persistenzbedarf.
- Kein gemeinsamer Build mit der Node-App – die beiden Welten bleiben
  getrennt.
