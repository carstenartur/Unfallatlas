package de.unfallatlas.analysis;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

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
 */
@SpringBootApplication
public class AnalysisServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(AnalysisServiceApplication.class, args);
    }
}
