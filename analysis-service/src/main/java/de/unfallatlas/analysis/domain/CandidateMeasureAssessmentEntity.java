package de.unfallatlas.analysis.domain;

import jakarta.persistence.*;
import jakarta.validation.constraints.*;

import java.util.Objects;

/**
 * Persistente Form einer bewerteten Maßnahme aus der deterministischen
 * Vorselektion (siehe {@code preselectMeasures.js}, {@code scoring.js}).
 */
@Entity
@Table(
    name = "candidate_measure_assessment",
    indexes = {
        @Index(name = "idx_cma_measure_id", columnList = "measureId"),
        @Index(name = "idx_cma_fit_score",  columnList = "fitScore")
    }
)
public class CandidateMeasureAssessmentEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "brief_id", nullable = false)
    private LocationActionBriefEntity brief;

    @NotBlank
    @Size(max = 80)
    @Column(name = "measure_id", nullable = false, length = 80)
    private String measureId;

    @NotBlank
    @Size(max = 200)
    @Column(nullable = false, length = 200)
    private String title;

    @Size(max = 60)
    @Column(length = 60)
    private String category;

    @Size(max = 60)
    @Column(name = "source_category", length = 60)
    private String sourceCategory;

    @Min(0) @Max(1)
    @Column(name = "fit_score", nullable = false)
    private double fitScore;

    @Min(0) @Max(1)
    @Column(name = "quick_win_potential", nullable = false)
    private double quickWinPotential;

    @Size(max = 12)
    @Column(name = "implementation_effort", length = 12)
    private String implementationEffort; // low|medium|high

    @Size(max = 12)
    @Column(name = "cost_band", length = 12)
    private String costBand; // low|medium|high

    @Size(max = 1000)
    @Column(name = "why_preselected", length = 1000)
    private String whyPreselected;

    @Size(max = 2000)
    @Column(name = "matched_conflict_patterns_joined", length = 2000)
    private String matchedConflictPatternsJoined;

    @Size(max = 2000)
    @Column(name = "matched_risk_factors_joined", length = 2000)
    private String matchedRiskFactorsJoined;

    @Size(max = 2000)
    @Column(name = "expected_target_accident_types_joined", length = 2000)
    private String expectedTargetAccidentTypesJoined;

    /**
     * Position innerhalb der vorselektierten Liste (0-basiert).  Wird beim
     * Schreiben gesetzt und ermöglicht stabile Reihenfolgen beim Auslesen.
     */
    @Min(0)
    @Column(name = "position", nullable = false)
    private int position;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public LocationActionBriefEntity getBrief() { return brief; }
    public void setBrief(LocationActionBriefEntity brief) { this.brief = brief; }
    public String getMeasureId() { return measureId; }
    public void setMeasureId(String measureId) { this.measureId = measureId; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }
    public String getSourceCategory() { return sourceCategory; }
    public void setSourceCategory(String sourceCategory) { this.sourceCategory = sourceCategory; }
    public double getFitScore() { return fitScore; }
    public void setFitScore(double fitScore) { this.fitScore = fitScore; }
    public double getQuickWinPotential() { return quickWinPotential; }
    public void setQuickWinPotential(double quickWinPotential) { this.quickWinPotential = quickWinPotential; }
    public String getImplementationEffort() { return implementationEffort; }
    public void setImplementationEffort(String implementationEffort) { this.implementationEffort = implementationEffort; }
    public String getCostBand() { return costBand; }
    public void setCostBand(String costBand) { this.costBand = costBand; }
    public String getWhyPreselected() { return whyPreselected; }
    public void setWhyPreselected(String whyPreselected) { this.whyPreselected = whyPreselected; }
    public String getMatchedConflictPatternsJoined() { return matchedConflictPatternsJoined; }
    public void setMatchedConflictPatternsJoined(String s) { this.matchedConflictPatternsJoined = s; }
    public String getMatchedRiskFactorsJoined() { return matchedRiskFactorsJoined; }
    public void setMatchedRiskFactorsJoined(String s) { this.matchedRiskFactorsJoined = s; }
    public String getExpectedTargetAccidentTypesJoined() { return expectedTargetAccidentTypesJoined; }
    public void setExpectedTargetAccidentTypesJoined(String s) { this.expectedTargetAccidentTypesJoined = s; }
    public int getPosition() { return position; }
    public void setPosition(int position) { this.position = position; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof CandidateMeasureAssessmentEntity that)) return false;
        return Objects.equals(id, that.id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
