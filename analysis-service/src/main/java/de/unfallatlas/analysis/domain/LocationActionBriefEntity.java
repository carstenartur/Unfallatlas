package de.unfallatlas.analysis.domain;

import jakarta.persistence.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.search.mapper.pojo.mapping.definition.annotation.FullTextField;
import org.hibernate.search.mapper.pojo.mapping.definition.annotation.GenericField;
import org.hibernate.search.mapper.pojo.mapping.definition.annotation.IndexedEmbedded;
import org.hibernate.search.mapper.pojo.mapping.definition.annotation.KeywordField;
import org.hibernate.search.mapper.pojo.mapping.definition.annotation.Indexed;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * Aggregat-Wurzel: ein gespeicherter Maßnahmen-Steckbrief für eine Stelle.
 *
 * <p>Spiegelt die Kernfelder des {@code LocationActionBrief} aus PR #199
 * (siehe {@code server/location-brief/briefService.js}).  Nicht alle
 * Detailfelder werden 1:1 als Spalten gemappt – große, unstrukturierte
 * Bestandteile wandern in Sub-Entitäten oder bleiben als deterministische
 * Zusammenfassung in {@code deterministicSummary}.</p>
 *
 * <p>Versionierungsfelder ermöglichen späteres Vergleichen und
 * Wiederberechnen (siehe {@code sourceFingerprint}, {@code rulesVersion},
 * {@code scoringVersion}, {@code profileVersion}).</p>
 *
 * <p>Hibernate-Search-Vorbereitung: Klasse und Felder sind so geschnitten,
 * dass {@code @Indexed} / {@code @FullTextField} später ohne Strukturumbau
 * ergänzt werden können.  Aktuell ist Hibernate Search noch nicht
 * eingebunden, um den PR überschaubar zu halten.</p>
 */
@Entity
@Table(
    name = "location_action_brief",
    indexes = {
        @Index(name = "idx_lab_location_key", columnList = "location_key"),
        @Index(name = "idx_lab_city",         columnList = "city"),
        @Index(name = "idx_lab_profile_key",  columnList = "profile_key"),
        @Index(name = "idx_lab_created_at",   columnList = "created_at")
    }
)
@Indexed(index = "location_action_brief")
public class LocationActionBriefEntity {

    @Id
    @Column(length = 36, nullable = false, updatable = false)
    @KeywordField(name = "id_kw")
    private String id;

    /** Stabiler Schlüssel der Stelle (z. B. {@code "hannover::altenbekener_damm"}). */
    @NotBlank
    @Size(max = 200)
    @Column(nullable = false, length = 200)
    @KeywordField(sortable = org.hibernate.search.engine.backend.types.Sortable.YES)
    private String locationKey;

    /** Externe ID, falls aus einem anderen System übergeben (frei). */
    @Size(max = 200)
    @Column(length = 200)
    private String externalLocationId;

    @NotBlank
    @Size(max = 100)
    @Column(nullable = false, length = 100)
    @KeywordField(sortable = org.hibernate.search.engine.backend.types.Sortable.YES)
    @KeywordField(name = "city_lc", normalizer = "lowercase")
    private String city;

    @NotBlank
    @Size(max = 250)
    @Column(nullable = false, length = 250)
    @FullTextField(analyzer = "standard")
    private String title;

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    @GenericField(sortable = org.hibernate.search.engine.backend.types.Sortable.YES)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(nullable = false)
    private Instant updatedAt;

    /** Schema-Version des Briefs (z. B. {@code "locationActionBrief.v1"}). */
    @NotBlank
    @Size(max = 60)
    @Column(nullable = false, length = 60)
    private String schemaVersion;

    /** Hash über die für die Berechnung relevanten Eingabedaten. */
    @NotBlank
    @Size(min = 8, max = 128)
    @Column(nullable = false, length = 128)
    private String sourceFingerprint;

    @NotBlank
    @Size(max = 60)
    @Column(nullable = false, length = 60)
    @KeywordField(sortable = org.hibernate.search.engine.backend.types.Sortable.YES)
    private String profileKey;

    /**
     * Deterministische Kurzzusammenfassung (problemSummary o. ä.) – als
     * lesbarer Text persistiert, damit Listen ohne Join brauchbar sind.
     */
    @Size(max = 4000)
    @Column(length = 4000)
    @FullTextField(analyzer = "standard")
    private String deterministicSummary;

    @Min(0)
    @Max(1)
    @Column(nullable = false)
    private double confidence;

    /** {@code low|medium|high} – Aggregierter Datenqualitäts-Hinweis. */
    @NotNull
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private QualityBand dataQuality;

    /** {@code low|medium|high} – aus politischem Kontext abgeleitet. */
    @NotNull
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private QualityBand politicalReadiness;

    @Column(nullable = false)
    private boolean aiUsed;

    @Embedded
    @Valid
    private VersioningInfo versioning = new VersioningInfo();

    @Embedded
    @Valid
    private AiAssessmentMetadata aiMetadata;

    // ── Aggregations-Beziehungen ────────────────────────────────────────────

    @OneToMany(mappedBy = "brief", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @IndexedEmbedded(includePaths = { "patternId", "patternId_lc", "label", "classification" })
    private List<@Valid ConflictPatternAssessmentEntity> conflictPatterns = new ArrayList<>();

    @OneToMany(mappedBy = "brief", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @IndexedEmbedded(includePaths = { "measureId", "measureId_lc", "title", "category" })
    private List<@Valid CandidateMeasureAssessmentEntity> candidateMeasures = new ArrayList<>();

    @OneToMany(mappedBy = "brief", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    private List<@Valid PrioritizationProfileScoreEntity> profileScores = new ArrayList<>();

    @OneToMany(mappedBy = "brief", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @IndexedEmbedded(includePaths = { "type", "topic", "title" })
    private List<@Valid PoliticalReferenceSummaryEntity> politicalReferences = new ArrayList<>();

    // ── Lifecycle ───────────────────────────────────────────────────────────

    @PrePersist
    void prePersist() {
        if (id == null) {
            id = UUID.randomUUID().toString();
        }
    }

    // ── Convenience adders that keep both sides in sync ─────────────────────

    public void addConflictPattern(ConflictPatternAssessmentEntity p) {
        p.setBrief(this); conflictPatterns.add(p);
    }
    public void addCandidateMeasure(CandidateMeasureAssessmentEntity m) {
        m.setBrief(this); candidateMeasures.add(m);
    }
    public void addProfileScore(PrioritizationProfileScoreEntity s) {
        s.setBrief(this); profileScores.add(s);
    }
    public void addPoliticalReference(PoliticalReferenceSummaryEntity r) {
        r.setBrief(this); politicalReferences.add(r);
    }

    // ── Getters / setters ───────────────────────────────────────────────────

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getLocationKey() { return locationKey; }
    public void setLocationKey(String locationKey) { this.locationKey = locationKey; }
    public String getExternalLocationId() { return externalLocationId; }
    public void setExternalLocationId(String externalLocationId) { this.externalLocationId = externalLocationId; }
    public String getCity() { return city; }
    public void setCity(String city) { this.city = city; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
    public String getSchemaVersion() { return schemaVersion; }
    public void setSchemaVersion(String schemaVersion) { this.schemaVersion = schemaVersion; }
    public String getSourceFingerprint() { return sourceFingerprint; }
    public void setSourceFingerprint(String sourceFingerprint) { this.sourceFingerprint = sourceFingerprint; }
    public String getProfileKey() { return profileKey; }
    public void setProfileKey(String profileKey) { this.profileKey = profileKey; }
    public String getDeterministicSummary() { return deterministicSummary; }
    public void setDeterministicSummary(String deterministicSummary) { this.deterministicSummary = deterministicSummary; }
    public double getConfidence() { return confidence; }
    public void setConfidence(double confidence) { this.confidence = confidence; }
    public QualityBand getDataQuality() { return dataQuality; }
    public void setDataQuality(QualityBand dataQuality) { this.dataQuality = dataQuality; }
    public QualityBand getPoliticalReadiness() { return politicalReadiness; }
    public void setPoliticalReadiness(QualityBand politicalReadiness) { this.politicalReadiness = politicalReadiness; }
    public boolean isAiUsed() { return aiUsed; }
    public void setAiUsed(boolean aiUsed) { this.aiUsed = aiUsed; }
    public VersioningInfo getVersioning() { return versioning; }
    public void setVersioning(VersioningInfo versioning) { this.versioning = versioning; }
    public AiAssessmentMetadata getAiMetadata() { return aiMetadata; }
    public void setAiMetadata(AiAssessmentMetadata aiMetadata) { this.aiMetadata = aiMetadata; }
    public List<ConflictPatternAssessmentEntity> getConflictPatterns() { return conflictPatterns; }
    public void setConflictPatterns(List<ConflictPatternAssessmentEntity> conflictPatterns) { this.conflictPatterns = conflictPatterns; }
    public List<CandidateMeasureAssessmentEntity> getCandidateMeasures() { return candidateMeasures; }
    public void setCandidateMeasures(List<CandidateMeasureAssessmentEntity> candidateMeasures) { this.candidateMeasures = candidateMeasures; }
    public List<PrioritizationProfileScoreEntity> getProfileScores() { return profileScores; }
    public void setProfileScores(List<PrioritizationProfileScoreEntity> profileScores) { this.profileScores = profileScores; }
    public List<PoliticalReferenceSummaryEntity> getPoliticalReferences() { return politicalReferences; }
    public void setPoliticalReferences(List<PoliticalReferenceSummaryEntity> politicalReferences) { this.politicalReferences = politicalReferences; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof LocationActionBriefEntity that)) return false;
        return Objects.equals(id, that.id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
