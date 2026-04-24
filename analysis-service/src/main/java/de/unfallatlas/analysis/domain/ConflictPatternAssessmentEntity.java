package de.unfallatlas.analysis.domain;

import jakarta.persistence.*;
import jakarta.validation.constraints.*;

import java.util.Objects;

/**
 * Persistente Form eines erkannten Konfliktmusters (siehe
 * {@code conflictPatternAliases.js} und {@code conflictPatterns.js}
 * aus PR #199).
 */
@Entity
@Table(
    name = "conflict_pattern_assessment",
    indexes = {
        @Index(name = "idx_cpa_pattern_id",  columnList = "pattern_id"),
        @Index(name = "idx_cpa_alias_id",    columnList = "alias_id")
    }
)
// Hibernate-Search-Hook (vorbereitet, noch nicht aktiv)
public class ConflictPatternAssessmentEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "brief_id", nullable = false)
    private LocationActionBriefEntity brief;

    /** Deutsche, kanonische ID (z. B. {@code "kfz_rad_abbiegekonflikt"}). */
    @NotBlank
    @Size(max = 80)
    @Column(name = "pattern_id", nullable = false, length = 80)
    private String patternId;

    /** Englische Alias-ID (z. B. {@code "bicycle_turning_conflict"}). */
    @Size(max = 80)
    @Column(name = "alias_id", length = 80)
    private String aliasId;

    @NotBlank
    @Size(max = 200)
    @Column(nullable = false, length = 200)
    private String label;

    @NotNull
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 12)
    private Classification classification;

    @NotNull
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private QualityBand confidence;

    @Size(max = 1000)
    @Column(length = 1000)
    private String rationale;

    /**
     * Pipe-getrennte Evidenz-Tokens (kompakt persistiert, damit kein
     * separates Element-Collection-Joining für simple Listen nötig ist).
     */
    @Size(max = 2000)
    @Column(length = 2000)
    private String evidenceJoined;

    @Size(max = 2000)
    @Column(length = 2000)
    private String requiresOnSiteCheckJoined;

    public enum Classification { PRIMARY, SECONDARY }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public LocationActionBriefEntity getBrief() { return brief; }
    public void setBrief(LocationActionBriefEntity brief) { this.brief = brief; }
    public String getPatternId() { return patternId; }
    public void setPatternId(String patternId) { this.patternId = patternId; }
    public String getAliasId() { return aliasId; }
    public void setAliasId(String aliasId) { this.aliasId = aliasId; }
    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }
    public Classification getClassification() { return classification; }
    public void setClassification(Classification classification) { this.classification = classification; }
    public QualityBand getConfidence() { return confidence; }
    public void setConfidence(QualityBand confidence) { this.confidence = confidence; }
    public String getRationale() { return rationale; }
    public void setRationale(String rationale) { this.rationale = rationale; }
    public String getEvidenceJoined() { return evidenceJoined; }
    public void setEvidenceJoined(String evidenceJoined) { this.evidenceJoined = evidenceJoined; }
    public String getRequiresOnSiteCheckJoined() { return requiresOnSiteCheckJoined; }
    public void setRequiresOnSiteCheckJoined(String requiresOnSiteCheckJoined) { this.requiresOnSiteCheckJoined = requiresOnSiteCheckJoined; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof ConflictPatternAssessmentEntity that)) return false;
        return Objects.equals(id, that.id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
