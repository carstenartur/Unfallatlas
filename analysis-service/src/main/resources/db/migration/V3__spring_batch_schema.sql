-- ─────────────────────────────────────────────────────────────────────────────
-- V3 – Spring-Batch-Metadatentabellen.
--
-- Quelle: org/springframework/batch/core/schema-postgresql.sql aus
-- spring-batch-core 6.0.x.  Die Datei liegt hier bewusst als versionierte
-- Flyway-Migration vor (statt sie via `spring.batch.jdbc.initialize-schema`
-- automatisch anlegen zu lassen), damit die Metadaten genauso reproduzier-
-- bar entstehen wie das fachliche Schema.
--
-- Portabilität:
--   * Funktioniert auf PostgreSQL ≥ 12.
--   * Funktioniert auf H2 im PostgreSQL-Kompatibilitätsmodus
--     (Tests/Dev), weil H2 sowohl `BIGINT` als auch `CREATE SEQUENCE`
--     unterstützt.
--
-- Fachentitäten und Batch-Metadaten leben in derselben Datenbank, aber
-- die Tabellen sind klar nach Präfix getrennt:
--   - `location_action_brief`, `analysis_job`, … (fachlich)
--   - `BATCH_*`                                  (Batch-Infrastruktur)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE BATCH_JOB_INSTANCE (
    JOB_INSTANCE_ID BIGINT  NOT NULL PRIMARY KEY,
    VERSION         BIGINT,
    JOB_NAME        VARCHAR(100) NOT NULL,
    JOB_KEY         VARCHAR(32)  NOT NULL,
    CONSTRAINT JOB_INST_UN UNIQUE (JOB_NAME, JOB_KEY)
);

CREATE TABLE BATCH_JOB_EXECUTION (
    JOB_EXECUTION_ID BIGINT  NOT NULL PRIMARY KEY,
    VERSION          BIGINT,
    JOB_INSTANCE_ID  BIGINT  NOT NULL,
    CREATE_TIME      TIMESTAMP NOT NULL,
    START_TIME       TIMESTAMP DEFAULT NULL,
    END_TIME         TIMESTAMP DEFAULT NULL,
    STATUS           VARCHAR(10),
    EXIT_CODE        VARCHAR(2500),
    EXIT_MESSAGE     VARCHAR(2500),
    LAST_UPDATED     TIMESTAMP,
    CONSTRAINT JOB_INST_EXEC_FK FOREIGN KEY (JOB_INSTANCE_ID)
        REFERENCES BATCH_JOB_INSTANCE (JOB_INSTANCE_ID)
);

CREATE TABLE BATCH_JOB_EXECUTION_PARAMS (
    JOB_EXECUTION_ID BIGINT      NOT NULL,
    PARAMETER_NAME   VARCHAR(100) NOT NULL,
    PARAMETER_TYPE   VARCHAR(100) NOT NULL,
    PARAMETER_VALUE  VARCHAR(2500),
    IDENTIFYING      CHAR(1)     NOT NULL,
    CONSTRAINT JOB_EXEC_PARAMS_FK FOREIGN KEY (JOB_EXECUTION_ID)
        REFERENCES BATCH_JOB_EXECUTION (JOB_EXECUTION_ID)
);

CREATE TABLE BATCH_STEP_EXECUTION (
    STEP_EXECUTION_ID  BIGINT  NOT NULL PRIMARY KEY,
    VERSION            BIGINT  NOT NULL,
    STEP_NAME          VARCHAR(100) NOT NULL,
    JOB_EXECUTION_ID   BIGINT  NOT NULL,
    CREATE_TIME        TIMESTAMP NOT NULL,
    START_TIME         TIMESTAMP DEFAULT NULL,
    END_TIME           TIMESTAMP DEFAULT NULL,
    STATUS             VARCHAR(10),
    COMMIT_COUNT       BIGINT,
    READ_COUNT         BIGINT,
    FILTER_COUNT       BIGINT,
    WRITE_COUNT        BIGINT,
    READ_SKIP_COUNT    BIGINT,
    WRITE_SKIP_COUNT   BIGINT,
    PROCESS_SKIP_COUNT BIGINT,
    ROLLBACK_COUNT     BIGINT,
    EXIT_CODE          VARCHAR(2500),
    EXIT_MESSAGE       VARCHAR(2500),
    LAST_UPDATED       TIMESTAMP,
    CONSTRAINT JOB_EXEC_STEP_FK FOREIGN KEY (JOB_EXECUTION_ID)
        REFERENCES BATCH_JOB_EXECUTION (JOB_EXECUTION_ID)
);

CREATE TABLE BATCH_STEP_EXECUTION_CONTEXT (
    STEP_EXECUTION_ID  BIGINT NOT NULL PRIMARY KEY,
    SHORT_CONTEXT      VARCHAR(2500) NOT NULL,
    SERIALIZED_CONTEXT TEXT,
    CONSTRAINT STEP_EXEC_CTX_FK FOREIGN KEY (STEP_EXECUTION_ID)
        REFERENCES BATCH_STEP_EXECUTION (STEP_EXECUTION_ID)
);

CREATE TABLE BATCH_JOB_EXECUTION_CONTEXT (
    JOB_EXECUTION_ID   BIGINT NOT NULL PRIMARY KEY,
    SHORT_CONTEXT      VARCHAR(2500) NOT NULL,
    SERIALIZED_CONTEXT TEXT,
    CONSTRAINT JOB_EXEC_CTX_FK FOREIGN KEY (JOB_EXECUTION_ID)
        REFERENCES BATCH_JOB_EXECUTION (JOB_EXECUTION_ID)
);

CREATE SEQUENCE BATCH_STEP_EXECUTION_SEQ MAXVALUE 9223372036854775807 NO CYCLE;
CREATE SEQUENCE BATCH_JOB_EXECUTION_SEQ  MAXVALUE 9223372036854775807 NO CYCLE;
CREATE SEQUENCE BATCH_JOB_INSTANCE_SEQ   MAXVALUE 9223372036854775807 NO CYCLE;

-- ─── Verbindung zum fachlichen Job-Modell ──────────────────────────────────
--
-- AnalysisJobEntity (fachlich) speichert weiterhin den
-- Job-Status aus Sicht der Anwendung; zusätzlich verlinken wir
-- jetzt eine optionale Spring-Batch-Execution-ID, sodass eine
-- fachliche Lauf-Zusammenfassung (Top-N, Anzahl bewerteter
-- Stellen, Fehler) und die Batch-Metadaten reibungslos
-- nebeneinander existieren.

ALTER TABLE analysis_job
    ADD COLUMN job_execution_id BIGINT;
ALTER TABLE analysis_job
    ADD COLUMN run_label VARCHAR(120);
ALTER TABLE analysis_job
    ADD COLUMN summary VARCHAR(4000);

CREATE INDEX idx_aj_job_execution_id ON analysis_job (job_execution_id);
