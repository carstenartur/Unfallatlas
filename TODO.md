# TODO — Testcontainers- und Architektur-Folgearbeiten

Stand: 2026-05-10

Diese Datei sammelt Empfehlungen aus der Diskussion zu testcontainers-Tests
analog zu den Taxonomie- und Photographer-Projekten. Sie ergänzt die jetzt
gemergte **Schicht-1-Suite** (`tests/integration/apiSmoke.testcontainers.test.js`),
die das bestehende `unfallatlas`-Image (Node + Express + Playwright + ffmpeg)
End-to-End gegen ein breites Cross-Section von Routen prüft, ohne den
`analysis-service` oder PostgreSQL zu starten.

---

## 1. Architektur-Vorgabe: alles in ein Docker-Image, kein `docker-compose`

> Aus meiner sicht brauche ich docker compose nicht. Alles könnte in ein
> docker image. — User, 2026-05-10

Status quo:

- **Zwei** unabhängige Images:
  - `Dockerfile` (Repo-Root) → Node/Express/Playwright/ffmpeg, Port 8000.
  - `analysis-service/Dockerfile` → Spring Boot 3 / Java 21, Port 8081,
    benötigt zusätzlich PostgreSQL.
- Verknüpft über `docker-compose.yml` mit Profil `persist`.

Ziel: **ein einziges Image**, das die Werkbank inkl. Persistenz/Read-API
bedient — ohne Compose, ohne separates Postgres, ohne zwei Build-Pipelines.

Mögliche Wege (je nach Aufwand/Akzeptanz noch zu entscheiden):

- [ ] **Variante A — Embedded DB im Spring-Boot-Image.**
      `analysis-service` auf eine eingebettete Datenbank umstellen
      (H2 mit Datei-Persistenz oder besser **embedded PostgreSQL** via
      `io.zonky.test:embedded-postgres`/`pg-embedded` für Produktions-
      parität mit Flyway-Migrationen V1–V4). Der gesamte Java-Stack läuft
      dann im selben Container, ohne externen Postgres-Service.
- [ ] **Variante B — Spring-Boot-Service in das Node-Image hochziehen.**
      Multi-stage Dockerfile, das das Fat-JAR aus `analysis-service/` baut
      und im Node-Image neben dem Express-Server startet (z. B. via
      `s6-overlay`, `supervisord` oder einem simplen Shell-Wrapper, der
      Java-Prozess + Node-Prozess gemeinsam überwacht). Ports 8000 + 8081
      werden beide vom selben Container exposed.
- [ ] **Variante C — Java-Service durch eine in-process Node-Implementierung
      ersetzen.** Die `BatchJobController`/`SearchController`/
      `LocationBriefController`-Funktionalität direkt in Express-Routen
      portieren, Persistenz auf SQLite (`better-sqlite3`) oder eine
      In-Memory-Repräsentation umstellen. Eliminiert die JVM komplett.
      Bricht aber die jetzige Spring-Data-/Hibernate-Search-Schicht.

Akzeptanzkriterien für die gewählte Variante:

- [ ] `docker run -p 8000:8000 ghcr.io/carstenartur/unfallatlas` startet
      Werkbank **inkl.** persistenter `/api/location-briefs/...`,
      `/api/priorities/...`, `/api/batch/jobs/...`, `/api/search/...`
      ohne weitere Container.
- [ ] `docker-compose.yml` kann gelöscht werden (oder bleibt nur als
      Convenience für Dev-Setups mit externer DB).
- [ ] `ANALYSIS_SERVICE_BASE_URL` entfällt im Default-Pfad — die Routen
      sind ohne Konfiguration "verfügbar", `ensureAnalysisServiceConfigured`
      kann entweder entfernt oder auf "nur konfigurierbar, wenn explizit
      eine externe URL gesetzt wird" reduziert werden.
- [ ] Image-Größe bleibt vertretbar (Java 21 JRE + Node + Playwright-
      Browser ist groß; ggf. distroless/jlink prüfen).

---

## 2. Schicht-2 testcontainers-Tests (Multi-Container, derzeit nicht nötig)

**Voraussetzung:** Solange der `analysis-service` ein eigenes Image bleibt,
müssten Tests gegen die Forwarder-Routen (`/api/location-briefs/...`,
`/api/priorities/...`, `/api/batch/jobs/...`, `/api/search/...`) drei
Container in einem `Network.newNetwork()` aufsetzen
(Node + Spring Boot + PostgreSQL).

Mit der unter §1 angestrebten Vereinfachung (alles in ein Image) **entfällt
Schicht 2 komplett** — die Routen würden dann von Schicht 1 mitabgedeckt,
weil sie im selben Image laufen.

- [ ] **Erst nach §1 entscheiden:** ob Schicht-2-Tests jemals gebraucht
      werden. Wenn alles in ein Image wandert, diesen Punkt streichen.
- [ ] Falls die Multi-Container-Architektur dauerhaft bleibt: eine
      `analysisServiceForwarders.testcontainers.test.js` ergänzen, die
      `Postgres` + `unfallatlas/analysis-service:local` + `unfallatlas`
      über `Network.newNetwork()` koppelt und einen End-to-End-Roundtrip
      über `POST /api/location-brief` → `GET /api/location-briefs/by-location/...`
      ausführt. Pattern analog Taxonomie/Photographer.

---

## 3. Schicht-3: testcontainers im Java-Modul `analysis-service/`

Heute benutzen die Spring-Boot-Tests
(`FlywayMigrationsTest`, `AnalysisJobRepositoryTest`,
`LocationBriefRepositoryTest`, `CityPrioritizationJobIntegrationTest`)
**H2** statt eines echten PostgreSQL — die Flyway-Migrationen V1–V4 werden
also nie gegen die Engine validiert, gegen die sie in Produktion laufen.

- [ ] Dependency `org.testcontainers:postgresql` (passend zur Spring-Boot-
      BOM) im `analysis-service/pom.xml` ergänzen. Vorher
      `gh-advisory-database` für die gewählte Version prüfen.
- [ ] `@Testcontainers` + `@Container PostgreSQLContainer<>("postgres:18")`
      in `FlywayMigrationsTest` einsetzen, damit `V1__init_schema.sql`,
      `V2__harden_indexes_and_idempotency.sql`,
      `V3__analysis_job_batch_link.sql`,
      `V4__batch_ranking_artifacts.sql` gegen Postgres 18 laufen.
- [ ] Repository-Tests (`AnalysisJobRepositoryTest`,
      `LocationBriefRepositoryTest`) auf den gleichen Container umstellen,
      damit JSONB-Spalten, Generated Columns und Postgres-spezifische
      Constraints korrekt geprüft werden.
- [ ] Maven-Profil so wählen, dass die testcontainers-Suite **nicht** im
      jedem `mvn test`-Lauf zwingend Docker braucht
      (z. B. eigenes Profil `-Pit` oder `@EnabledIfDockerAvailable`).

Hinweis: Wenn §1 Variante C (Java-Service entfällt) gewählt wird, ist auch
Schicht 3 hinfällig.

---

## 4. Aufräumen rund um die Schicht-1-Suite (kleine Folgeschritte)

- [ ] In `.github/workflows/` einen optionalen Job `integration-tc`
      ergänzen, der `npm run test:integration:tc` mit
      `UNFALLATLAS_IMAGE=ghcr.io/carstenartur/unfallatlas:<sha>` ausführt
      (nach `docker-publish.yml`). Heute laufen die testcontainers-Tests
      nur lokal; in CI würden sie ebenfalls Schutz bieten.
- [ ] README/`docs/` um einen kurzen Abschnitt "Integrationstests mit
      testcontainers" ergänzen, der `npm run test:integration:tc` und die
      Skip-Semantik (`RUN_TESTCONTAINERS=1`, `UNFALLATLAS_IMAGE`)
      dokumentiert.
- [ ] Wenn weitere Endpunkte hinzukommen, sollten sie in
      `apiSmoke.testcontainers.test.js` als zusätzliches `it()` ergänzt
      werden — nicht als neue Datei, damit pro Jest-Lauf weiterhin nur
      **ein** Container hochgefahren wird.
