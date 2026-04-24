package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

/**
 * Spring-Data-Repository für persistierte Maßnahmen-Steckbriefe.
 *
 * <p>Bietet die in der Aufgabenstellung geforderten Standardabfragen
 * (neueste Auswertung je Ort, alle pro Ort, alle pro Profil, alle pro
 * Stadt, alle mit politischer Vorbefassung, Top-N nach Teilscore).</p>
 */
public interface LocationActionBriefRepository extends JpaRepository<LocationActionBriefEntity, String> {

    /** Alle Auswertungen einer Stelle, neueste zuerst. */
    List<LocationActionBriefEntity> findByLocationKeyOrderByCreatedAtDesc(String locationKey);

    /** Neueste Auswertung einer Stelle (egal welches Profil). */
    Optional<LocationActionBriefEntity> findFirstByLocationKeyOrderByCreatedAtDesc(String locationKey);

    /** Neueste Auswertung einer Stelle für ein bestimmtes Profil. */
    Optional<LocationActionBriefEntity> findFirstByLocationKeyAndProfileKeyOrderByCreatedAtDesc(
        String locationKey, String profileKey);

    /** Alle Auswertungen einer Stadt (paginiert, neueste zuerst). */
    Page<LocationActionBriefEntity> findByCityOrderByCreatedAtDesc(String city, Pageable pageable);

    /** Alle Auswertungen einer Stadt mit einem bestimmten Profil (paginiert). */
    Page<LocationActionBriefEntity> findByCityAndProfileKeyOrderByCreatedAtDesc(
        String city, String profileKey, Pageable pageable);

    /** Alle Auswertungen mit politischer Vorbefassung (Bereitschaftsstufe MEDIUM/HIGH). */
    @Query("""
        select b from LocationActionBriefEntity b
        where b.city = :city
          and b.politicalReadiness in (de.unfallatlas.analysis.domain.QualityBand.MEDIUM,
                                       de.unfallatlas.analysis.domain.QualityBand.HIGH)
        order by b.createdAt desc
    """)
    List<LocationActionBriefEntity> findWithPoliticalReadinessByCity(@Param("city") String city);

    /**
     * Top-N Briefs einer Stadt für ein Profil – sortiert nach dem
     * profilspezifischen Gesamt-Score.  Gibt jeweils nur den jüngsten
     * Brief pro {@code locationKey} zurück.
     */
    @Query(value = """
        select b.* from location_action_brief b
        join prioritization_profile_score s on s.brief_id = b.id and s.profile_key = :profileKey
        where b.city = :city
          and b.created_at = (
              select max(b2.created_at) from location_action_brief b2
              where b2.location_key = b.location_key and b2.profile_key = b.profile_key
          )
        order by s.total desc
        limit :limit
    """, nativeQuery = true)
    List<LocationActionBriefEntity> findTopByCityAndProfile(
        @Param("city") String city,
        @Param("profileKey") String profileKey,
        @Param("limit") int limit);

    /** Existierender Brief mit identischem Fingerprint (für Idempotenz). */
    Optional<LocationActionBriefEntity> findFirstByLocationKeyAndProfileKeyAndSourceFingerprint(
        String locationKey, String profileKey, String sourceFingerprint);
}
