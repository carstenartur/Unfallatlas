package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.domain.PrioritizationProfileScoreEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface PrioritizationProfileScoreRepository
        extends JpaRepository<PrioritizationProfileScoreEntity, Long> {

    List<PrioritizationProfileScoreEntity> findByBrief_Id(String briefId);

    Optional<PrioritizationProfileScoreEntity> findByBrief_IdAndProfileKey(String briefId, String profileKey);

    List<PrioritizationProfileScoreEntity> findByBrief_CityAndProfileKeyOrderByTotalDesc(
        String city, String profileKey);
}
