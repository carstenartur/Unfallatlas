package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.domain.CandidateMeasureAssessmentEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface CandidateMeasureAssessmentRepository
        extends JpaRepository<CandidateMeasureAssessmentEntity, Long> {

    List<CandidateMeasureAssessmentEntity> findByBrief_IdOrderByPositionAsc(String briefId);

    List<CandidateMeasureAssessmentEntity> findByMeasureIdOrderByFitScoreDesc(String measureId);
}
