package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.domain.PoliticalReferenceSummaryEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface PoliticalReferenceSummaryRepository
        extends JpaRepository<PoliticalReferenceSummaryEntity, Long> {

    List<PoliticalReferenceSummaryEntity> findByBrief_IdOrderByRelevanceDesc(String briefId);

    List<PoliticalReferenceSummaryEntity> findByTopic(String topic);
}
