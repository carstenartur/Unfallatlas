-- ─────────────────────────────────────────────────────────────────────────────
-- V3 – Spring-Batch-Metadatentabellen + Verlinkung mit fachlichem
--      Job-Modell (`analysis_job`).
--
-- Spring Boot 4 hat den Auto-Initializer für Spring-Batch-Tabellen
-- entfernt (keine `spring.batch.jdbc.initialize-schema`-Property mehr in
-- `BatchProperties`).  Wir legen die Tabellen daher explizit über Flyway
-- an, damit Test- und Prod-Umgebungen identisch sind und die Migrations-
-- historie konsistent bleibt.
--
-- Die Tabellen-/Sequenzdefinition entspricht 1:1 der von Spring Batch 6
-- bereitgestellten PostgreSQL-Schemavorlage
-- ({@code spring-batch-core/org/springframework/batch/core/schema-postgresql.sql}).
-- Das Schema funktioniert sowohl unter PostgreSQL (Prod) als auch unter
-- H2 im PostgreSQL-Kompatibilitätsmodus (Test), weil
-- {@code BIGINT NOT NULL PRIMARY KEY} + {@code CREATE SEQUENCE} portabel
-- sind und die DAOs in Spring Batch ihre IDs ausschließlich über
-- Sequenz-Incrementer beziehen.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Spring-Batch-Metadaten ──────────────────────────────────────────────────

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
    JOB_EXECUTION_ID BIGINT  NOT NULL,
    PARAMETER_NAME   VARCHAR(100) NOT NULL,
    PARAMETER_TYPE   VARCHAR(100) NOT NULL,
    PARAMETER_VALUE  VARCHAR(2500),
    IDENTIFYING      CHAR(1) NOT NULL,
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
    STEP_EXECUTION_ID  BIGINT  NOT NULL PRIMARY KEY,
    SHORT_CONTEXT      VARCHAR(2500) NOT NULL,
    SERIALIZED_CONTEXT TEXT,
    CONSTRAINT STEP_EXEC_CTX_FK FOREIGN KEY (STEP_EXECUTION_ID)
        REFERENCES BATCH_STEP_EXECUTION (STEP_EXECUTION_ID)
);

CREATE TABLE BATCH_JOB_EXECUTION_CONTEXT (
    JOB_EXECUTION_ID   BIGINT  NOT NULL PRIMARY KEY,
    SHORT_CONTEXT      VARCHAR(2500) NOT NULL,
    SERIALIZED_CONTEXT TEXT,
    CONSTRAINT JOB_EXEC_CTX_FK FOREIGN KEY (JOB_EXECUTION_ID)
        REFERENCES BATCH_JOB_EXECUTION (JOB_EXECUTION_ID)
);

CREATE SEQUENCE BATCH_STEP_EXECUTION_SEQ MAXVALUE 9223372036854775807 NO CYCLE;
CREATE SEQUENCE BATCH_JOB_EXECUTION_SEQ  MAXVALUE 9223372036854775807 NO CYCLE;
CREATE SEQUENCE BATCH_JOB_INSTANCE_SEQ   MAXVALUE 9223372036854775807 NO CYCLE;

-- ── Erweiterung des fachlichen Job-Modells ──────────────────────────────────
-- Verlinkt das fachliche {@code AnalysisJobEntity} mit einer optionalen
-- Spring-Batch-{@code JobExecution} und ergänzt zwei weitere Felder, die
-- der `AnalysisJobLinkListener` bei Lauf-Ende befüllt:
--   * job_execution_id – Spring-Batch-Execution-ID (lockerer Verweis,
--                        ohne harten FK auf BATCH_JOB_EXECUTION; die
--                        Spring-Batch-Tabellen sollen unabhängig
--                        aufgeräumt werden können).
--   * run_label        – frei wählbarer Lauf-Label (z. B. "monatlich-2026-04").
--   * summary          – kompaktes JSON mit Top-N + Counts.

ALTER TABLE analysis_job ADD COLUMN job_execution_id BIGINT;
ALTER TABLE analysis_job ADD COLUMN run_label        VARCHAR(120);
ALTER TABLE analysis_job ADD COLUMN summary          VARCHAR(4000);

CREATE INDEX idx_aj_job_execution_id ON analysis_job (job_execution_id);

