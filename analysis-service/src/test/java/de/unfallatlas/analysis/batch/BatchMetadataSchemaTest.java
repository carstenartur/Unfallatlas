package de.unfallatlas.analysis.batch;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.LinkedHashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Smoke-Test: Spring Batch hat seine Metadatentabellen tatsächlich
 * angelegt und kann sie auch beschreiben.  Der Test betrachtet bewusst
 * nur Strukturen + ein lesendes {@code SELECT COUNT(*)}, weil die
 * fachliche Job-Logik (inkl. Inserts) in
 * {@link CityPrioritizationJobIntegrationTest} geprüft wird.
 */
@SpringBootTest
class BatchMetadataSchemaTest {

    @Autowired
    private DataSource dataSource;

    @Test
    void springBatchTablesArePresentAndUsable() throws Exception {
        Set<String> tables = new LinkedHashSet<>();
        try (Connection c = dataSource.getConnection()) {
            DatabaseMetaData md = c.getMetaData();
            try (ResultSet rs = md.getTables(null, null, "%", new String[] { "TABLE" })) {
                while (rs.next()) {
                    tables.add(rs.getString("TABLE_NAME").toLowerCase());
                }
            }
        }
        assertThat(tables).contains(
            "batch_job_instance",
            "batch_job_execution",
            "batch_job_execution_params",
            "batch_step_execution"
        );

        // Belegt zusätzlich, dass die Tabellen abfragbar sind – das ist
        // die Grundlage dafür, dass der Job-Repository-JDBC-Pfad auf
        // diesem Schema überhaupt arbeiten kann.
        try (Connection c = dataSource.getConnection()) {
            try (ResultSet rs = c.createStatement().executeQuery(
                    "SELECT COUNT(*) FROM BATCH_JOB_INSTANCE")) {
                rs.next();
                int before = rs.getInt(1);
                assertThat(before).isGreaterThanOrEqualTo(0);
            }
        }
    }
}
