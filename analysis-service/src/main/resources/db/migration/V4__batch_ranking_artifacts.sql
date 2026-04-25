-- ─────────────────────────────────────────────────────────────────────────────
-- V4 – Persistente Lauf-Artefakte für den `city-prioritization-job`.
--
-- Hintergrund: Die Lauf-Zusammenfassung (`analysis_job.summary`) bleibt
-- ein kompaktes JSON für Übersichtszwecke.  Für ein echtes
-- Vergleichs-/Wiederverwendungs-Szenario brauchen wir aber eine
-- abfragbare Tabelle, in der die gerankten Top-N pro Lauf
-- nachvollziehbar abliegen – getrennt vom JSON-Blob, damit:
--
--   * SQL-/Index-Zugriffe pro `executionId` möglich sind,
--   * die Tabelle wachstumsstabil bleibt (keine TEXT-Roundtrips),
--   * Spring Batch die Daten bei einem Restart sauber neu schreiben kann
--     (DELETE + INSERT in `persistResultsStep`/`buildRankingArtifactsStep`).
--
-- Die Tabelle ist absichtlich locker an Spring-Batch gekoppelt:
-- `job_execution_id` ist eine BIGINT-Referenz ohne harten Foreign Key,
-- damit Aufräum-/Archivierungsläufe der BATCH_*-Tabellen unabhängig
-- möglich sind (analog zu `analysis_job.job_execution_id`).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE batch_ranking_artifact (
    id                  BIGINT       NOT NULL PRIMARY KEY,
    job_execution_id    BIGINT       NOT NULL,
    job_name            VARCHAR(100) NOT NULL,
    target_city         VARCHAR(100) NOT NULL,
    target_profile_key  VARCHAR(60)  NOT NULL,
    rank_position       INTEGER      NOT NULL,
    location_key        VARCHAR(120) NOT NULL,
    brief_id            VARCHAR(36)  NOT NULL,
    profile_score       DOUBLE PRECISION NOT NULL,
    political_reference_count INTEGER NOT NULL DEFAULT 0,
    short_term_measures INTEGER NOT NULL DEFAULT 0,
    structural_measures INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_bra_exec_rank UNIQUE (job_execution_id, rank_position)
);

CREATE SEQUENCE batch_ranking_artifact_seq INCREMENT BY 50 MAXVALUE 9223372036854775807 NO CYCLE;

-- Häufige Lese-Pfade:
--   * Top-N für eine konkrete Execution (Lauf-Detail-Ansicht im UI),
--   * "letzte Läufe einer Stadt + Profil" als Vergleichsbasis,
--   * Brief-Lookup ("In welchen Läufen taucht dieser Brief auf?").
CREATE INDEX idx_bra_execution        ON batch_ranking_artifact (job_execution_id);
CREATE INDEX idx_bra_city_profile_at  ON batch_ranking_artifact (target_city, target_profile_key, created_at DESC);
CREATE INDEX idx_bra_brief_id         ON batch_ranking_artifact (brief_id);

-- Ergänzende Indizes für häufige Search-/Top-N-Lesepfade auf den
-- bereits bestehenden fachlichen Tabellen.  Die einzelnen Spalten
-- haben bereits Indizes aus V1; wir ergänzen hier zusammengesetzte
-- Indizes, die bei den interaktiven Top-N-Abfragen
-- (`/api/location-briefs/top?city=&profile=`) und bei den Search-
-- Forwarder-Endpunkten (`/api/search/briefs?city=&profile=`)
-- konsistent gefragt sind.
CREATE INDEX IF NOT EXISTS idx_lab_city_profile_created
    ON location_action_brief (city, profile_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_location_profile_created
    ON location_action_brief (location_key, profile_key, created_at DESC);
