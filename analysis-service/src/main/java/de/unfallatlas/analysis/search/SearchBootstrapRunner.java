package de.unfallatlas.analysis.search;

import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import jakarta.persistence.EntityManager;
import org.hibernate.search.engine.search.query.SearchResult;
import org.hibernate.search.mapper.orm.Search;
import org.hibernate.search.mapper.orm.massindexing.MassIndexer;
import org.hibernate.search.mapper.orm.session.SearchSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.transaction.annotation.Transactional;

/**
 * Stellt sicher, dass der Hibernate-Search-Index beim Boot mit bereits
 * vorhandenen Datensätzen befüllt ist.
 *
 * <p>Hintergrund: Auto-Indexing greift nur für <em>neue/geänderte</em>
 * Entitäten.  Wenn der Service auf einer bestehenden Datenbank gestartet
 * wird (z. B. nach einem Versions-Upgrade, der Hibernate Search neu
 * einführt), ist der Lucene-Index initial leer.  Ohne Reindex würden
 * Suchen nichts liefern, obwohl Daten persistiert sind.</p>
 *
 * <p>Strategie: Wir prüfen einmalig nach dem Boot, ob der Brief-Index
 * leer ist.  Wenn ja, starten wir einen {@link MassIndexer}, der die
 * indizierten Entitäten neu hochzieht.  Wenn der Index bereits Treffer
 * hat (typisch im Steady-State), passiert nichts.  Damit ist der
 * Bootstrap idempotent und im Hot-Path neutral.</p>
 *
 * <p>Schalter:</p>
 * <ul>
 *   <li>{@code analysis.search.enabled=false} – schaltet die ganze
 *       Suchschicht ab; der Runner tut nichts.</li>
 *   <li>{@code analysis.search.bootstrap-reindex=false} – behält das
 *       Auto-Indexing aktiv, deaktiviert aber den initialen Reindex
 *       (nützlich, wenn das Befüllen extern gesteuert werden soll).</li>
 * </ul>
 */
@Configuration
public class SearchBootstrapRunner {

    private static final Logger LOG = LoggerFactory.getLogger(SearchBootstrapRunner.class);

    @Bean
    public ApplicationRunner hibernateSearchBootstrapRunner(
            EntityManager entityManager,
            @Value("${analysis.search.enabled:true}") boolean enabled,
            @Value("${analysis.search.bootstrap-reindex:true}") boolean bootstrapReindex) {
        return args -> {
            if (!enabled) {
                LOG.info("[search][bootstrap] Suchschicht deaktiviert (analysis.search.enabled=false) – kein Reindex.");
                return;
            }
            if (!bootstrapReindex) {
                LOG.info("[search][bootstrap] Bootstrap-Reindex deaktiviert (analysis.search.bootstrap-reindex=false).");
                return;
            }
            try {
                bootstrapIfEmpty(entityManager);
            } catch (RuntimeException e) {
                // Bewusste Soft-Failure: ein nicht erfolgreicher Reindex
                // darf den Service-Boot nicht kippen – Suche degradiert
                // zu „leere Treffer", alle anderen Funktionen laufen
                // unverändert weiter.
                LOG.warn("[search][bootstrap] Reindex fehlgeschlagen ({}): {}",
                    e.getClass().getSimpleName(), e.getMessage());
            }
        };
    }

    @Transactional(readOnly = true)
    void bootstrapIfEmpty(EntityManager em) {
        SearchSession session = Search.session(em);
        SearchResult<LocationActionBriefEntity> probe = session.search(LocationActionBriefEntity.class)
            .where(f -> f.matchAll())
            .fetch(0, 1);
        long indexed = probe.total().hitCount();
        if (indexed > 0) {
            LOG.info("[search][bootstrap] Index enthält bereits {} Briefs – kein Reindex nötig.", indexed);
            return;
        }
        long persisted = (Long) em.createQuery("select count(b) from LocationActionBriefEntity b").getSingleResult();
        if (persisted == 0) {
            LOG.info("[search][bootstrap] Datenbank enthält keine Briefs – Reindex unnötig.");
            return;
        }
        LOG.info("[search][bootstrap] Index leer, {} persistierte Briefs vorhanden – starte MassIndexer.", persisted);
        try {
            MassIndexer indexer = session.massIndexer(LocationActionBriefEntity.class)
                .threadsToLoadObjects(2);
            indexer.startAndWait();
            LOG.info("[search][bootstrap] Reindex abgeschlossen.");
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            LOG.warn("[search][bootstrap] Reindex unterbrochen.");
        }
    }
}
