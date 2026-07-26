package de.unfallatlas.analysis.search;

import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import jakarta.persistence.EntityManager;
import org.hibernate.search.engine.search.query.SearchResult;
import org.hibernate.search.mapper.orm.Search;
import org.hibernate.search.mapper.orm.massindexing.MassIndexer;
import org.hibernate.search.mapper.orm.session.SearchSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Führt den Hibernate-Search-Bootstrap innerhalb einer echten, durch Spring
 * verwalteten Transaktion aus.
 *
 * <p>Die Trennung vom {@link SearchBootstrapRunner} ist bewusst: ein
 * {@code @Transactional}-Aufruf innerhalb desselben Objekts würde den
 * Spring-AOP-Proxy umgehen und deshalb keine Transaktion öffnen.</p>
 */
@Service
public class SearchBootstrapService {

    private static final Logger LOG = LoggerFactory.getLogger(SearchBootstrapService.class);

    private final EntityManager entityManager;

    public SearchBootstrapService(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Transactional(readOnly = true)
    public void bootstrapIfEmpty() {
        SearchSession session = Search.session(entityManager);
        SearchResult<LocationActionBriefEntity> probe = session.search(LocationActionBriefEntity.class)
            .where(f -> f.matchAll())
            .fetch(0, 1);
        long indexed = probe.total().hitCount();
        if (indexed > 0) {
            LOG.info("[search][bootstrap] Index enthält bereits {} Briefs – kein Reindex nötig.", indexed);
            return;
        }

        long persisted = (Long) entityManager
            .createQuery("select count(b) from LocationActionBriefEntity b")
            .getSingleResult();
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
