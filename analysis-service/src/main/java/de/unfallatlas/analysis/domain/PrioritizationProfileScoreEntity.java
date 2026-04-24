package de.unfallatlas.analysis.domain;

import jakarta.persistence.*;
import jakarta.validation.constraints.*;

import java.util.Objects;

/**
 * Persistente Form eines Profil-Scores aus
 * {@code prioritization/scoring.js#applyAllProfiles} (PR #199).
 *
 * <p>Speichert sowohl die 8 Sub-Scores als Snapshot pro Brief, als auch
 * den profilspezifischen normierten Gesamt-Score ({@code total}) – damit
 * Top-N-Listen pro Profil mit reinen Index-Lookups beantwortet werden
 * können.</p>
 */
@Entity
@Table(
    name = "prioritization_profile_score",
    indexes = {
        @Index(name = "idx_pps_profile_key", columnList = "profile_key"),
        @Index(name = "idx_pps_total",       columnList = "total")
    },
    uniqueConstraints = {
        @UniqueConstraint(name = "uq_pps_brief_profile", columnNames = {"brief_id", "profile_key"})
    }
)
public class PrioritizationProfileScoreEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "brief_id", nullable = false)
    private LocationActionBriefEntity brief;

    @NotBlank
    @Size(max = 60)
    @Column(name = "profile_key", nullable = false, length = 60)
    private String profileKey;

    @Min(0) @Max(1)
    @Column(nullable = false)
    private double total;

    // ── 8 Sub-Scores aus dem deterministischen Modell ───────────────────────

    @Min(0) @Max(1) @Column(nullable = false) private double safetyImpactScore;
    @Min(0) @Max(1) @Column(nullable = false) private double severeAccidentReductionScore;
    @Min(0) @Max(1) @Column(nullable = false) private double bicycleSafetyScore;
    @Min(0) @Max(1) @Column(nullable = false) private double quickWinScore;
    @Min(0) @Max(1) @Column(nullable = false) private double implementationFeasibilityScore;
    @Min(0) @Max(1) @Column(nullable = false) private double policyReadinessScore;
    @Min(0) @Max(1) @Column(nullable = false) private double costEfficiencyScore;
    @Min(0) @Max(1) @Column(nullable = false) private double dataConfidenceScore;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public LocationActionBriefEntity getBrief() { return brief; }
    public void setBrief(LocationActionBriefEntity brief) { this.brief = brief; }
    public String getProfileKey() { return profileKey; }
    public void setProfileKey(String profileKey) { this.profileKey = profileKey; }
    public double getTotal() { return total; }
    public void setTotal(double total) { this.total = total; }
    public double getSafetyImpactScore() { return safetyImpactScore; }
    public void setSafetyImpactScore(double v) { this.safetyImpactScore = v; }
    public double getSevereAccidentReductionScore() { return severeAccidentReductionScore; }
    public void setSevereAccidentReductionScore(double v) { this.severeAccidentReductionScore = v; }
    public double getBicycleSafetyScore() { return bicycleSafetyScore; }
    public void setBicycleSafetyScore(double v) { this.bicycleSafetyScore = v; }
    public double getQuickWinScore() { return quickWinScore; }
    public void setQuickWinScore(double v) { this.quickWinScore = v; }
    public double getImplementationFeasibilityScore() { return implementationFeasibilityScore; }
    public void setImplementationFeasibilityScore(double v) { this.implementationFeasibilityScore = v; }
    public double getPolicyReadinessScore() { return policyReadinessScore; }
    public void setPolicyReadinessScore(double v) { this.policyReadinessScore = v; }
    public double getCostEfficiencyScore() { return costEfficiencyScore; }
    public void setCostEfficiencyScore(double v) { this.costEfficiencyScore = v; }
    public double getDataConfidenceScore() { return dataConfidenceScore; }
    public void setDataConfidenceScore(double v) { this.dataConfidenceScore = v; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof PrioritizationProfileScoreEntity that)) return false;
        return Objects.equals(id, that.id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
