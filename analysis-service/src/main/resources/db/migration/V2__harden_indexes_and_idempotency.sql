-- ─────────────────────────────────────────────────────────────────────────────
-- V2 – Härtung des Schemas:
--   * Zusammengesetzte Indizes für die häufigsten Abfragen
--     (Stadt + Profil + neueste, Stelle + Profil + neueste).
--   * Eindeutigkeitsregel für die Idempotenz beim Ingest
--     (locationKey + profileKey + sourceFingerprint).  Das Service stellt
--     Idempotenz bereits anwendungsseitig sicher; mit dem Constraint wird
--     auch ein paralleler Doppel-Ingest in der DB sauber abgewiesen.
--
-- Die Indizes sind redundant zu einigen Einzelindizes aus V1, decken aber
-- die typischen WHERE+ORDER-BY-Pfade besser ab und vermeiden zusätzliche
-- Sortierschritte.  Einzelindizes aus V1 bleiben erhalten – Postgres und
-- H2 wählen automatisch den passenden Index.
-- ─────────────────────────────────────────────────────────────────────────────

-- Stadt + Profil + neueste zuerst (typisch: GET /api/location-briefs?city=&profile=)
CREATE INDEX idx_lab_city_profile_created
    ON location_action_brief (city, profile_key, created_at DESC);

-- Stelle + Profil + neueste (typisch: by-location/{key} mit Profilfilter)
CREATE INDEX idx_lab_location_profile_created
    ON location_action_brief (location_key, profile_key, created_at DESC);

-- Idempotenz-Constraint: identische Quelle für gleiche Stelle+Profil bleibt
-- genau ein Brief.  Spring-Batch-Re-Ingest kann sich darauf verlassen.
ALTER TABLE location_action_brief
    ADD CONSTRAINT uq_lab_location_profile_fingerprint
    UNIQUE (location_key, profile_key, source_fingerprint);

-- Ein zusammengesetzter Index für das häufige "neueste Score je Brief
-- für ein Profil"-Pattern im Top-N-Ranking.
CREATE INDEX idx_pps_profile_total_brief
    ON prioritization_profile_score (profile_key, total DESC, brief_id);
