# Unfallatlas Analysis Service

Separater **Spring-Boot-/Hibernate-Persistenzdienst** für die fachlichen
Kernobjekte des *Location Action Brief* (siehe PR #199).  Die bestehende
Node.js-Anwendung im Wurzelverzeichnis bleibt **unverändert** und ist
weiterhin alleinige Quelle der deterministischen Berechnungen; dieser
Dienst läuft **daneben** und persistiert die strukturierten Ergebnisse
versioniert für späteres Vergleichen, Wiederverwenden und stadtweite
Rankings.

> **Hinweis:** Dieser PR liefert **bewusst keine** vollständige
> Persistenz-Großlösung.  Schema-Migration (Liquibase/Flyway), Batch- und
> Queue-Infrastruktur, vollständige Multi-City-Orchestrierung und eine
> Hibernate-Search-Suchfunktion sind Folge-PRs.

## Inhalt

- `pom.xml` – Spring Boot 3.3, Java 17, Hibernate ORM 6, Hibernate
  Validator, Spring Data JPA, H2 (Dev/Test) + PostgreSQL (Prod).
- `src/main/java/de/unfallatlas/analysis/`
  - `domain/` – persistierbare Entitäten (`LocationActionBriefEntity`,
    `ConflictPatternAssessmentEntity`,
    `CandidateMeasureAssessmentEntity`,
    `PrioritizationProfileScoreEntity`,
    `PoliticalReferenceSummaryEntity`) und Embeddables
    (`VersioningInfo`, `AiAssessmentMetadata`).
  - `persistence/` – Spring-Data-Repositories.
  - `api/` – REST-Controller, Service, Validation-Error-Handler.
  - `api/dto/` – versioniertes Ingest-DTO `locationBriefIngest.v1`
    sowie Response-DTO.
  - `mapping/` – handgeschriebener Mapper (DTO → Entität).
  - `fingerprint/` – kanonischer Source-Fingerprint (SHA-256).

## Lokal starten

Voraussetzungen: JDK 17, Maven 3.9+.

```bash
cd analysis-service
mvn spring-boot:run            # Default-Profil 'dev' → H2 in-memory
```

Erreichbar unter `http://localhost:8081`.  Der Port lässt sich über
`PORT` oder `-Dserver.port=…` überschreiben.

### Tests

```bash
mvn test
```

Aktuell: **24 Tests** (Validierung, JPA-Mapping, Repository-Abfragen,
REST-Integration, Source-Fingerprint, mit/ohne KI-Metadaten).

### Mit PostgreSQL (Prod)

```bash
export SPRING_PROFILES_ACTIVE=prod
export ANALYSIS_DB_URL=jdbc:postgresql://localhost:5432/unfallatlas
export ANALYSIS_DB_USER=unfallatlas
export ANALYSIS_DB_PASSWORD=…
mvn spring-boot:run
```

Im Prod-Profil ist `spring.jpa.hibernate.ddl-auto=validate` gesetzt –
Schema-Erstellung muss in einem Folge-PR über Liquibase/Flyway erfolgen.
PostGIS wird vom Persistenzschema dieser Iteration noch **nicht**
benötigt; Geometrien werden vorerst nicht direkt gespeichert.

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

Validation-Fehler werden in einem einheitlichen Envelope geliefert
(`{ error, category: "validation", message, details, timestamp }`),
analog zu `server/lib/errors.js` der Node-App.

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

Der DTO-Vertrag ist bewusst eng an der Node-Ausgabe in
`server/location-brief/briefService.js` orientiert (`schemaVersion`,
`title`, `problemSummary`, `accidentProfile`, `conflictPatterns`,
`candidateMeasures`, `deterministicFindings`, `politicalContext`,
`confidence`, `meta`, optional `aiPolish`).

Empfohlene Integration in einem Folge-PR:

1. In `server/index.js` einen optionalen Forwarder hinter dem
   bestehenden `POST /api/location-brief` ergänzen, der das Ergebnis an
   `POST {ANALYSIS_SERVICE_URL}/api/location-briefs` weitergibt, wenn
   `ANALYSIS_SERVICE_URL` konfiguriert ist.
2. Dieser PR enthält den Forwarder bewusst noch nicht, um die Node-App
   nicht zu verändern.

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
- Keine vollständige Batch-/Queue-Infrastruktur.
- Keine vollständige stadtweite Pipeline.
- Keine Schema-Migration (Liquibase/Flyway) – kommt im Folge-PR.
- Keine PostGIS-Geometrien – derzeit kein Persistenzbedarf.
- Kein gemeinsamer Build mit der Node-App – die beiden Welten bleiben
  getrennt.
