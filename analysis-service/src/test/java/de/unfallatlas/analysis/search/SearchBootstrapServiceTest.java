package de.unfallatlas.analysis.search;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * Regressionstest für den transaktionalen Hibernate-Search-Bootstrap.
 *
 * <p>Ohne Aufruf über den Spring-Proxy scheitert {@code Search.session(...)}
 * mit „No transactional EntityManager available“.</p>
 */
@SpringBootTest
class SearchBootstrapServiceTest {

    @Autowired private SearchBootstrapService bootstrapService;

    @Test
    void bootstrapUsesTransactionalEntityManager() {
        assertThatCode(bootstrapService::bootstrapIfEmpty)
            .doesNotThrowAnyException();
    }
}
