package de.unfallatlas.analysis.batch;

import org.springframework.batch.core.configuration.support.JdbcDefaultBatchConfiguration;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.transaction.PlatformTransactionManager;

import javax.sql.DataSource;

/**
 * Aktiviert die <em>JDBC-gestützte</em> Spring-Batch-Konfiguration.
 *
 * <p>Spring Batch 6 verwendet im {@link
 * org.springframework.batch.core.configuration.support.DefaultBatchConfiguration
 * DefaultBatchConfiguration} (das von Spring Boot 4 als Default
 * eingebunden wird) standardmäßig die in-memory
 * {@code ResourcelessJobRepository}.  Dadurch werden Jobs zwar
 * ausgeführt, aber {@code BATCH_*}-Tabellen bleiben leer, JobInstances
 * werden nicht persistiert und Restarts sind nicht möglich.</p>
 *
 * <p>Diese Klasse erbt von {@link JdbcDefaultBatchConfiguration} und
 * sorgt dafür, dass:</p>
 * <ul>
 *   <li>der vorhandene Anwendungs-{@link DataSource} für Spring Batch
 *       genutzt wird,</li>
 *   <li>derselbe {@link PlatformTransactionManager} wie in der JPA-Welt
 *       benutzt wird (damit Batch-Metadaten und fachliche Schreibvorgänge
 *       in einer kohärenten Sicht enden),</li>
 *   <li>JobRepository, JobLauncher und JobExplorer JDBC-basiert
 *       arbeiten – also auf den per Flyway-V3 angelegten BATCH-Tabellen.</li>
 * </ul>
 *
 * <p>Wir markieren die Bean mit {@link Primary}, damit sie der von
 * {@code BatchAutoConfiguration} ggf. registrierten DefaultBatchConfiguration
 * vorgezogen wird.</p>
 */
@Configuration
@Primary
public class BatchJdbcConfig extends JdbcDefaultBatchConfiguration {

    private final DataSource dataSource;
    private final PlatformTransactionManager transactionManager;

    public BatchJdbcConfig(DataSource dataSource, PlatformTransactionManager transactionManager) {
        this.dataSource = dataSource;
        this.transactionManager = transactionManager;
    }

    @Override
    protected DataSource getDataSource() {
        return dataSource;
    }

    @Override
    protected PlatformTransactionManager getTransactionManager() {
        return transactionManager;
    }
}
