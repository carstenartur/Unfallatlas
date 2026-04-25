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

> **Hinweis:** Die Test-Suite läuft regulär mit `mvn test`,
> einschließlich der Controller- und Repository-Integrationstests
> (`LocationBriefControllerTest` nutzt die Spring-Boot-4-Variante von
> `@AutoConfigureMockMvc` aus
> `org.springframework.boot.webmvc.test.autoconfigure`).

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
  (Brief wird trotzdem zurückgegeben, mit `persistence.status = "persist_skipped"`).

Siehe [`docs/server-features.md`](../docs/server-features.md) für
Konfiguration und Beispielanfragen.

## Persistenz-Status (`persistence.status` in der Node-API)

Die Node-Antwort auf `POST /api/location-brief` enthält jetzt immer ein
`persistence`-Objekt mit einem klaren Lebenszyklus-Status:

| Status              | Bedeutung                                                      |
|---------------------|----------------------------------------------------------------|
| `freshly_computed`  | Brief wurde frisch berechnet, kein Persist gewünscht.          |
| `loaded_from_store` | `useStored=true` → bestehender Brief aus dem Service geliefert.|
| `persisted`         | Brief wurde berechnet **und** erfolgreich persistiert.         |
| `persist_skipped`   | Persist gewünscht, aber Service nicht erreichbar/aktiviert.    |

Zusätzliche Felder: `persisted` (boolean), `persistRequested`, `attempts`,
ggf. `storedId` und `reason`.  Die Vokabular bleibt stabil; UI und Tests
können sich darauf verlassen.

## Dublettenstrategie / Wiederholungsverhalten

* `LocationActionBrief` wird **idempotent** persistiert:
  Eindeutigkeit über `(location_key, profile_key, source_fingerprint)`,
  in `V2__harden_indexes_and_idempotency.sql` zusätzlich als
  `UNIQUE`-Index gehärtet.
* Mehrfaches Posten desselben Briefs liefert denselben Datensatz zurück
  (kein doppelter Eintrag).
* Neuberechnungen mit anderem Inhalt erzeugen einen neuen Eintrag mit
  neuem `source_fingerprint`; abfragbar bleibt der jeweils neueste Brief
  pro `(locationKey, profileKey)` über `findLatestBy*`.
* Die V2-Migration ergänzt zusammengesetzte Indizes für die häufigen
  Lese-Pfade: `(city, profile_key, created_at desc)`,
  `(location_key, profile_key, created_at desc)`,
  `(profile_key, total desc)` für Top-N-Abfragen.

## Spring Batch (stadtweite Verarbeitung)

Der Service enthält ab dieser Iteration eine **erste** Spring-Batch-
Anbindung als Grundlage für stadtweite Priorisierungsläufe.  Die
interaktive REST-API (`/api/location-briefs/...`) bleibt davon
unberührt – Batch ist *zusätzlich*, nicht *Ersatz*.

### Tabellen / Metadaten

* Spring-Batch-Metadatentabellen (`BATCH_JOB_INSTANCE`,
  `BATCH_JOB_EXECUTION`, `BATCH_JOB_EXECUTION_PARAMS`,
  `BATCH_STEP_EXECUTION`, `BATCH_STEP_EXECUTION_CONTEXT`,
  `BATCH_JOB_EXECUTION_CONTEXT` + Sequenzen) werden über
  `V3__analysis_job_batch_link.sql` von Flyway angelegt.  Spring Boot 4
  bringt keinen Auto-Initializer mehr mit, deshalb explizit per
  Migration.
* Das fachliche `analysis_job` wurde um `job_execution_id`, `run_label`
  und `summary` erweitert; der `AnalysisJobLinkListener` koppelt die
  technische Spring-Batch-Execution mit dem fachlichen Datensatz und
  schreibt am Lauf-Ende eine kompakte Top-N-Zusammenfassung als JSON
  in `analysis_job.summary`.
* `BatchJdbcConfig extends JdbcDefaultBatchConfiguration` zwingt Spring
  Batch dazu, das JDBC-gestützte JobRepository zu verwenden (Default
  in Boot 4 ist sonst `ResourcelessJobRepository`).

### `city-prioritization-job` – Steps

| Step                 | Aufgabe                                                         |
|----------------------|-----------------------------------------------------------------|
| `loadCandidatesStep` | Lädt `locationKeys` der Stadt aus den vorhandenen Briefs.       |
| `computeBriefsStep`  | Liest die Briefs (bei `recomputeExisting=true` markiert sie für Neuberechnung). |
| `scoreProfilesStep`  | Validiert / aktualisiert den `prioritization_profile_score` je Brief. |
| `persistResultsStep` | Schreibt die aktualisierten Score-Felder zurück.                |
| `buildRankingStep`   | Erzeugt das Top-N-Ranking und legt es als JSON-Summary ab.      |

Steps sind sauber getrennt (keine Mega-Tasklet) und können je für sich
restartet werden.

### Job-Parameter

| Parameter           | Pflicht | Identifying | Bedeutung                                  |
|---------------------|:-------:|:-----------:|--------------------------------------------|
| `city`              | ja      | ja          | Stadt-Key (z. B. `Hannover`)               |
| `profile`           | ja      | ja          | Profil-ID (z. B. `low_hanging_fruit`)      |
| `recomputeExisting` | nein    | ja          | `true` lässt vorhandene Briefs neu bewerten|
| `limit`             | nein    | nein        | Max. Anzahl betrachteter Stellen (Default 100) |
| `runLabel`          | nein    | nein        | Frei wählbarer Lauf-Tag (z. B. `monatlich`)|
| `runTimestamp`      | (auto)  | ja          | Wird vom Controller gesetzt – macht Wieder-Auslösungen eindeutig|

### REST-API

| Methode | Pfad                                                | Zweck                               |
|---------|-----------------------------------------------------|-------------------------------------|
| POST    | `/api/batch/jobs/city-prioritization`               | Lauf starten (gibt `executionId` zurück, 202)|
| GET     | `/api/batch/jobs`                                   | Jüngste Lauf-Übersicht              |
| GET     | `/api/batch/jobs/{executionId}`                     | Technischer Status (Steps, Exit-Codes)|
| GET     | `/api/batch/jobs/{executionId}/summary`             | Fachliche Zusammenfassung (Top-N + Counts) |

Die Endpunkte sind dünn und nutzen `JobLauncher` + `JobExplorer` direkt.
Validation-Fehler kommen über den vorhandenen `error`-Envelope
(category `validation`).  Konflikte (z. B. bereits laufender Lauf,
abgeschlossene JobInstance) werden mit `409 Conflict` und einem
maschinenlesbaren `code` zurückgegeben.

### Restart / Fehlerverhalten

* Auto-Run beim Start ist abgeschaltet (`BatchJobLauncherAutoConfiguration`
  ist in `AnalysisServiceApplication` ausgeschlossen).  Die alte Property
  `spring.batch.job.enabled` ist in Spring Boot 4 entfallen.
* Identifying Parameter (`city`, `profile`, `recomputeExisting`,
  `runTimestamp`) sorgen dafür, dass jeder neue Aufruf eine neue
  `JobInstance` bekommt.  Ein vom Aufrufer übergebener identischer
  Parametersatz kann *nicht* doppelt komplett ausgeführt werden – Spring
  Batch wirft `JobInstanceAlreadyCompleteException`, die im Controller
  als `409` mit Code `JOB_INSTANCE_ALREADY_COMPLETE` durchgereicht wird.
* `scoreProfilesStep` lässt fehlende Profilscores nicht still verschwinden,
  sondern erhöht den `processSkipCount` und schreibt einen Warn-Log.
* Der `AnalysisJobLinkListener` markiert den fachlichen Datensatz bei
  Failure mit `status=FAILED` und füllt `lastError` – kein stiller
  Datenverlust.

### Bekannte Fehlermodi

| Symptom                                              | Ursache / Behandlung                                                |
|------------------------------------------------------|---------------------------------------------------------------------|
| 409 `JOB_ALREADY_RUNNING`                            | Vorheriger Lauf läuft noch.  Auf Abschluss warten.                  |
| 409 `JOB_INSTANCE_ALREADY_COMPLETE`                  | Identische Parameter wurden bereits erfolgreich verarbeitet.       |
| 409 `JOB_RESTART_FAILED`                             | Restart einer fehlgeschlagenen Instance schlug fehl.               |
| 400 `validation`                                     | `city`/`profile` fehlen oder sind leer.                            |
| 404                                                  | `executionId` existiert nicht.                                     |
| `persist_skipped` beim Node-Forwarder                | Analysis Service nicht konfiguriert/aktiviert/erreichbar.          |

## Bewusst nicht enthalten

- Keine Ablösung der Node-App.
- Keine erzwungene Frontend-Migration.
- Keine vollständige Multi-City-Orchestrierung oder Cluster-/Worker-Verteilung.
- Keine vollständige Scheduler-Landschaft.
- Keine PostGIS-Geometrien – derzeit kein Persistenzbedarf.
- Kein Hibernate-Search-Backend in diesem Schritt.
- Kein gemeinsamer Build mit der Node-App – die beiden Welten bleiben
  getrennt.

## Hibernate-Search-Vorbereitung

Die Klassen `LocationActionBriefEntity`,
`ConflictPatternAssessmentEntity` und
`PoliticalReferenceSummaryEntity` haben Kommentar-Marker für die
spätere Ergänzung von `@Indexed` / `@FullTextField`.  Das eigentliche
Search-Backend (Lucene/Elasticsearch) ist **nicht** eingebunden, um den
PR überschaubar zu halten.
