package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.domain.BatchRankingArtifactEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

/**
 * Repository für persistierte Lauf-Artefakte (Top-N pro Spring-Batch-Lauf).
 *
 * <p>Liefert die zwei Lese-Pfade, die UI und API brauchen:</p>
 * <ul>
 *   <li>{@link #findByJobExecutionIdOrderByRankPositionAsc(Long)} –
 *       Top-N für eine konkrete {@code executionId} (Lauf-Detail).</li>
 *   <li>{@link #findRecentByCityAndProfile(String, String, int)} –
 *       jüngste Lauf-Artefakte je {@code city} + {@code profile}, damit
 *       das UI „Aus Batch-Lauf laden" anbieten kann, ohne auf die
 *       BATCH_*-Metadaten direkt zugreifen zu müssen.</li>
 * </ul>
 *
 * <p>{@link #deleteByJobExecutionId(Long)} ist explizit, damit ein
 * Restart-Pfad ({@code persistResultsStep} oder
 * {@code buildRankingArtifactsStep}) die alten Artefakte einer
 * Execution sauber löschen und neu schreiben kann – ohne die
 * historische Lauf-Liste der anderen Executions zu berühren.</p>
 */
public interface BatchRankingArtifactRepository extends JpaRepository<BatchRankingArtifactEntity, Long> {

    List<BatchRankingArtifactEntity> findByJobExecutionIdOrderByRankPositionAsc(Long jobExecutionId);

    @Modifying
    @Query("delete from BatchRankingArtifactEntity a where a.jobExecutionId = :jobExecutionId")
    int deleteByJobExecutionId(@Param("jobExecutionId") Long jobExecutionId);

    /**
     * Liefert die jüngsten Lauf-Artefakte für eine Stadt + Profil.
     * Sortiert nach {@code createdAt DESC, rankPosition ASC}, damit
     * frische Läufe oben stehen und innerhalb eines Laufs der Top-1
     * vor dem Top-2 erscheint.
     */
    @Query("""
        select a from BatchRankingArtifactEntity a
        where a.targetCity = :city and a.targetProfileKey = :profile
        order by a.createdAt desc, a.rankPosition asc
    """)
    List<BatchRankingArtifactEntity> findRecentByCityAndProfile(
        @Param("city") String city,
        @Param("profile") String profile,
        @Param("limit") int limit);
}
