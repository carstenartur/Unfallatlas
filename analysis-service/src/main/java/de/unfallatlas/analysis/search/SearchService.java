package de.unfallatlas.analysis.search;

import de.unfallatlas.analysis.domain.CandidateMeasureAssessmentEntity;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import de.unfallatlas.analysis.domain.PoliticalReferenceSummaryEntity;
import jakarta.persistence.EntityManager;
import org.hibernate.search.engine.search.predicate.dsl.SearchPredicateFactory;
import org.hibernate.search.engine.search.query.SearchResult;
import org.hibernate.search.mapper.orm.Search;
import org.hibernate.search.mapper.orm.session.SearchSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Suchschicht über die persistierten Domänenobjekte.
 *
 * <p>Stellt die drei in der Aufgabenstellung verlangten Suchfälle
 * bereit:</p>
 * <ol>
 *   <li>gespeicherte Briefs nach Stadt / Profil / Konfliktmuster /
 *       Begriff,</li>
 *   <li>politische Referenzen nach Verkehrsbezug / Typ / Topic /
 *       Begriff,</li>
 *   <li>ähnliche Fälle zu einem {@code briefId} – auf Basis seiner
 *       Konfliktmuster und der wichtigsten Maßnahmen-Kategorie.</li>
 * </ol>
 *
 * <p>Die Implementierung verwendet bewusst die <em>einfache</em>
 * Hibernate-Search-Predicate-DSL und vermeidet eine eigene Suchsyntax.
 * Wenn Hibernate Search nicht initialisiert ist (z. B. weil die
 * Property-Verdrahtung deaktiviert wurde), liefert
 * {@link #isAvailable()} {@code false} und alle Suchen geben einen
 * leeren {@code SearchResultPage} zurück, statt 5xx zu werfen.  Damit
 * können Aufrufer sauber degradieren.</p>
 */
@Service
public class SearchService {

    private static final Logger LOG = LoggerFactory.getLogger(SearchService.class);

    /** Obergrenze für jede Suche – schützt vor versehentlich grossen Antworten. */
    private static final int MAX_LIMIT = 100;

    private final EntityManager entityManager;
    private final boolean enabled;

    public SearchService(EntityManager entityManager,
                         @Value("${analysis.search.enabled:true}") boolean enabled) {
        this.entityManager = entityManager;
        this.enabled = enabled;
    }

    /** Liefert {@code true}, wenn die Suchschicht funktional ist (Konfiguration + Bootstrap). */
    public boolean isAvailable() {
        if (!enabled) return false;
        try {
            // SearchSession kann nur gebaut werden, wenn HSearch korrekt
            // bootstrapped wurde.  Wir versuchen es in einer kurzen
            // read-only Probe und behandeln Fehler als „nicht verfügbar".
            Search.session(entityManager);
            return true;
        } catch (RuntimeException e) {
            LOG.debug("[search] nicht verfügbar: {}", e.toString());
            return false;
        }
    }

    /**
     * Suche über persistierte LocationActionBriefs.
     *
     * <p>Alle Filter sind optional; ein leerer Aufruf liefert die
     * {@code limit} jüngsten Briefs.  Begriffssuche ({@code q}) trifft
     * Titel und deterministische Kurzzusammenfassung (Standard-Analyzer
     * mit ASCII-Folding und Lowercasing).</p>
     */
    @Transactional(readOnly = true)
    public SearchResultPage<LocationActionBriefEntity> searchBriefs(BriefSearchRequest req) {
        if (!isAvailable()) return SearchResultPage.empty();
        SearchSession session = Search.session(entityManager);
        int limit = clampLimit(req.limit);

        try {
            SearchResult<LocationActionBriefEntity> hits = session.search(LocationActionBriefEntity.class)
                .where(f -> buildBriefPredicate(f, req))
                .sort(f -> f.field("createdAt").desc())
                .fetch(0, limit);
            return SearchResultPage.of(hits);
        } catch (RuntimeException e) {
            LOG.warn("[search][briefs] Suche fehlgeschlagen ({}): {}", e.getClass().getSimpleName(), e.getMessage());
            return SearchResultPage.empty();
        }
    }

    /**
     * Suche über persistierte politische Referenzen.
     */
    @Transactional(readOnly = true)
    public SearchResultPage<PoliticalReferenceSummaryEntity> searchPoliticalRefs(PoliticalRefSearchRequest req) {
        if (!isAvailable()) return SearchResultPage.empty();
        SearchSession session = Search.session(entityManager);
        int limit = clampLimit(req.limit);

        try {
            SearchResult<PoliticalReferenceSummaryEntity> hits = session.search(PoliticalReferenceSummaryEntity.class)
                .where(f -> buildPoliticalRefPredicate(f, req))
                .sort(f -> f.field("relevance").desc())
                .fetch(0, limit);
            return SearchResultPage.of(hits);
        } catch (RuntimeException e) {
            LOG.warn("[search][political-refs] Suche fehlgeschlagen ({}): {}",
                e.getClass().getSimpleName(), e.getMessage());
            return SearchResultPage.empty();
        }
    }

    /**
     * Findet Briefs, die einem Referenz-Brief in seinen wichtigsten
     * Konfliktmustern oder Maßnahmen-Kategorien ähneln.  Der Referenz-
     * Brief selbst ist aus dem Ergebnis ausgeschlossen.
     *
     * <p>Heuristik:</p>
     * <ul>
     *   <li>OR über alle {@code patternId}s der Konfliktmuster,</li>
     *   <li>OR über alle {@code category}s der Kandidaten-Maßnahmen,</li>
     *   <li>jeweils im IndexedEmbedded-Pfad
     *       {@code conflictPatterns.patternId} bzw.
     *       {@code candidateMeasures.category}.</li>
     * </ul>
     */
    @Transactional(readOnly = true)
    public SearchResultPage<LocationActionBriefEntity> findSimilarBriefs(String briefId, int limit) {
        if (!isAvailable()) return SearchResultPage.empty();
        if (briefId == null || briefId.isBlank()) return SearchResultPage.empty();

        LocationActionBriefEntity ref = entityManager.find(LocationActionBriefEntity.class, briefId);
        if (ref == null) return SearchResultPage.empty();

        List<String> patternIds = ref.getConflictPatterns().stream()
            .map(p -> p.getPatternId())
            .filter(s -> s != null && !s.isBlank())
            .distinct()
            .limit(8)
            .toList();
        List<String> measureCategories = ref.getCandidateMeasures().stream()
            .map(CandidateMeasureAssessmentEntity::getCategory)
            .filter(s -> s != null && !s.isBlank())
            .distinct()
            .limit(8)
            .toList();

        if (patternIds.isEmpty() && measureCategories.isEmpty()) {
            return SearchResultPage.empty();
        }

        int safe = clampLimit(limit);
        SearchSession session = Search.session(entityManager);
        try {
            SearchResult<LocationActionBriefEntity> hits = session.search(LocationActionBriefEntity.class)
                .where(f -> f.bool()
                    .mustNot(f.id().matching(briefId))
                    .must(f.bool(b -> {
                        if (!patternIds.isEmpty()) {
                            b.should(f.terms()
                                .field("conflictPatterns.patternId")
                                .matchingAny(patternIds.toArray()));
                        }
                        if (!measureCategories.isEmpty()) {
                            b.should(f.terms()
                                .field("candidateMeasures.category")
                                .matchingAny(measureCategories.toArray()));
                        }
                        b.minimumShouldMatchNumber(1);
                    })))
                // Sortierung nach Score (=Relevanz), nicht nach createdAt
                .fetch(0, safe);
            return SearchResultPage.of(hits);
        } catch (RuntimeException e) {
            LOG.warn("[search][similar] Suche fehlgeschlagen ({}): {}",
                e.getClass().getSimpleName(), e.getMessage());
            return SearchResultPage.empty();
        }
    }

    // ── Predicate-Builder ────────────────────────────────────────────────────

    private static org.hibernate.search.engine.search.predicate.dsl.PredicateFinalStep buildBriefPredicate(
            SearchPredicateFactory f, BriefSearchRequest req) {
        return f.bool(b -> {
            // Begriff: Volltext über title + deterministicSummary
            if (req.q != null && !req.q.isBlank()) {
                b.must(f.match()
                    .fields("title", "deterministicSummary")
                    .matching(req.q.trim()));
            }
            if (req.city != null && !req.city.isBlank()) {
                b.must(f.match().field("city_lc").matching(req.city.trim().toLowerCase()));
            }
            if (req.profile != null && !req.profile.isBlank()) {
                b.must(f.match().field("profileKey").matching(req.profile.trim()));
            }
            if (req.conflictPattern != null && !req.conflictPattern.isBlank()) {
                b.must(f.match()
                    .field("conflictPatterns.patternId_lc")
                    .matching(req.conflictPattern.trim().toLowerCase()));
            }
            // bool() ohne Klauseln matched per default nichts; wir wollen
            // dann „alles" → matchAll als Fallback.
            if (!hasAnyFilter(req)) {
                b.must(f.matchAll());
            }
        });
    }

    private static boolean hasAnyFilter(BriefSearchRequest req) {
        return (req.q != null && !req.q.isBlank())
            || (req.city != null && !req.city.isBlank())
            || (req.profile != null && !req.profile.isBlank())
            || (req.conflictPattern != null && !req.conflictPattern.isBlank());
    }

    private static org.hibernate.search.engine.search.predicate.dsl.PredicateFinalStep buildPoliticalRefPredicate(
            SearchPredicateFactory f, PoliticalRefSearchRequest req) {
        return f.bool(b -> {
            if (req.q != null && !req.q.isBlank()) {
                b.must(f.match().field("title").matching(req.q.trim()));
            }
            if (req.type != null && !req.type.isBlank()) {
                b.must(f.match().field("type").matching(req.type.trim()));
            }
            if (req.topic != null && !req.topic.isBlank()) {
                b.must(f.match().field("topic").matching(req.topic.trim()));
            }
            if (!hasAnyPolFilter(req)) {
                b.must(f.matchAll());
            }
        });
    }

    private static boolean hasAnyPolFilter(PoliticalRefSearchRequest req) {
        return (req.q != null && !req.q.isBlank())
            || (req.type != null && !req.type.isBlank())
            || (req.topic != null && !req.topic.isBlank());
    }

    private static int clampLimit(Integer limit) {
        if (limit == null || limit <= 0) return 20;
        return Math.min(limit, MAX_LIMIT);
    }

    // ── Request-/Response-Records ────────────────────────────────────────────

    public static class BriefSearchRequest {
        public String q;
        public String city;
        public String profile;
        public String conflictPattern;
        public Integer limit;
    }

    public static class PoliticalRefSearchRequest {
        public String q;
        public String type;
        public String topic;
        public Integer limit;
    }

    /**
     * Schlankes Suchergebnis: Treffer + Gesamtanzahl, ohne Hibernate-Search-
     * spezifische Typen nach außen zu reichen.  Damit kann der Controller
     * frei wählen, was im JSON erscheint.
     */
    public static final class SearchResultPage<T> {
        public final long totalHitCount;
        public final List<T> hits;
        public final boolean truncated;

        private SearchResultPage(long totalHitCount, List<T> hits, boolean truncated) {
            this.totalHitCount = totalHitCount;
            this.hits = hits;
            this.truncated = truncated;
        }

        public static <T> SearchResultPage<T> of(SearchResult<T> r) {
            List<T> list = new ArrayList<>(r.hits());
            return new SearchResultPage<>(r.total().hitCount(), list, list.size() < r.total().hitCount());
        }

        public static <T> SearchResultPage<T> empty() {
            return new SearchResultPage<>(0L, Collections.emptyList(), false);
        }
    }
}
