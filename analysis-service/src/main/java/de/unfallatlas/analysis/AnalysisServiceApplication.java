package de.unfallatlas.analysis;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.batch.autoconfigure.BatchJobLauncherAutoConfiguration;

/**
 * Bootstrap der separaten Analyse- und Persistenzanwendung für die
 * Kernobjekte aus PR #199 (Location Action Brief).
 *
 * <p>Dieser Dienst ersetzt die bestehende Node.js-Anwendung NICHT.  Er
 * bietet zusätzlich eine persistente Schicht und erste REST-Endpunkte für
 * die strukturierten Steckbriefe, Konfliktmuster, Maßnahmenbewertungen und
 * Profil-Scores.</p>
 *
 * <p>Standard-Profil ist {@code dev} (H2 in-memory).  Für Produktion bitte
 * {@code SPRING_PROFILES_ACTIVE=prod} setzen und die PostgreSQL-Variablen
 * (siehe {@code application-prod.properties} und README) liefern.</p>
 *
 * <p><b>Spring Batch:</b> {@link BatchJobLauncherAutoConfiguration} wird
 * bewusst ausgeschlossen, damit beim Start des Dienstes keine Batch-Jobs
 * automatisch ausgeführt werden.  Spring Boot 4 hat die alte Property
 * {@code spring.batch.job.enabled} entfernt; ein leerer
 * {@code spring.batch.job.name} verhindert den Auto-Run nicht zuverlässig
 * und führt im Test- und Single-Job-Setup zu
 * {@code JobInstanceAlreadyCompleteException}.  Die einzige unterstützte
 * Auslösung ist die explizite Ansteuerung über die REST-Endpunkte
 * unter {@code /api/batch/jobs/*}.</p>
 */
@SpringBootApplication(exclude = { BatchJobLauncherAutoConfiguration.class })
public class AnalysisServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(AnalysisServiceApplication.class, args);
    }
}
