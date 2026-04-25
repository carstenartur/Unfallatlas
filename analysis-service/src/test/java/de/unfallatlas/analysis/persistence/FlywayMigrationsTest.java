package de.unfallatlas.analysis.persistence;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifiziert, dass die Flyway-Migration (V1__init_schema.sql) gegen die
 * Test-Datenbank (H2 im PostgreSQL-Kompatibilitätsmodus) sauber durchläuft
 * und alle erwarteten Tabellen anlegt.  Damit ist sichergestellt, dass
 * dieselben Skripte auch in Prod (PostgreSQL) funktionieren werden.
 *
 * <p>Der Test prüft bewusst nur Strukturen (Tabellennamen), nicht Inhalte –
 * Inhalts-/Verhaltenstests liegen in den dedizierten Repository- und
 * Controller-Tests.</p>
 */
@SpringBootTest
class FlywayMigrationsTest {

    @Autowired
    private DataSource dataSource;

    @Test
    void schemaContainsAllExpectedTables() throws Exception {
        Set<String> tables = new HashSet<>();
        try (Connection c = dataSource.getConnection()) {
            DatabaseMetaData md = c.getMetaData();
            try (ResultSet rs = md.getTables(null, null, "%", new String[] { "TABLE" })) {
                while (rs.next()) {
                    tables.add(rs.getString("TABLE_NAME").toLowerCase());
                }
            }
        }

        // Kerntabellen aus V1
        assertThat(tables).contains(
            "location_action_brief",
            "conflict_pattern_assessment",
            "candidate_measure_assessment",
            "prioritization_profile_score",
            "political_reference_summary",
            "analysis_job"
        );

        // Spring-Batch-Metadatentabellen aus V3
        assertThat(tables).contains(
            "batch_job_instance",
            "batch_job_execution",
            "batch_job_execution_params",
            "batch_step_execution",
            "batch_step_execution_context",
            "batch_job_execution_context"
        );

        // Lauf-Artefakte aus V4 (persistiertes Top-N pro Spring-Batch-Lauf)
        assertThat(tables).contains("batch_ranking_artifact");

        // Flyway-Bookkeeping-Tabelle muss existieren (Beleg, dass die
        // Migration tatsächlich gelaufen ist und nicht etwa Hibernate
        // ddl-auto=validate ohne Migration "gewonnen" hat).
        assertThat(tables).contains("flyway_schema_history");
    }
}
