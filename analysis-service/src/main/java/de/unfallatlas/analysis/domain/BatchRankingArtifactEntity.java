package de.unfallatlas.analysis.domain;

import jakarta.persistence.*;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.Objects;

/**
 * Persistierter Top-N-Eintrag eines abgeschlossenen Spring-Batch-Laufs.
 *
 * <p>Zweck: Ein Batch-Lauf produziert ein Stadt-/Profil-Ranking, das im
 * UI ("Aus Batch laden", Vergleichsmodus) und in
 * Wiederverwendungs-Workflows (Antrag/Export) jederzeit reproduzierbar
 * verfügbar sein muss.  Ein flüchtiger In-Memory-Listenzustand reicht
 * dafür nicht aus.</p>
 *
 * <p>Beziehung zum Spring-Batch-Modell:
 * {@link #jobExecutionId} verweist locker (ohne harten Foreign Key) auf
 * {@code BATCH_JOB_EXECUTION.JOB_EXECUTION_ID}, damit die Spring-Batch-
 * Tabellen unabhängig aufgeräumt werden können.  Die fachliche
 * Verknüpfung läuft über {@link #targetCity} / {@link #targetProfileKey}
 * + {@link #createdAt}, was sich gut über die zusammengesetzten Indizes
 * abfragen lässt.</p>
 *
 * <p>Beziehung zu {@link LocationActionBriefEntity}:
 * {@link #briefId} ist die ID des zur Lauf-Zeit verwendeten Briefs.  Wir
 * verwenden bewusst <em>keinen</em> harten FK – ein Brief kann später
 * gelöscht oder neu berechnet werden, ohne dass die historischen
 * Lauf-Artefakte verloren gehen.  Im UI laden wir den aktuell jüngsten
 * Brief je {@link #locationKey}.</p>
 */
@Entity
@Table(
    name = "batch_ranking_artifact",
    indexes = {
        @Index(name = "idx_bra_execution",        columnList = "job_execution_id"),
        @Index(name = "idx_bra_city_profile_at",  columnList = "target_city, target_profile_key, created_at DESC"),
        @Index(name = "idx_bra_brief_id",         columnList = "brief_id")
    },
    uniqueConstraints = @UniqueConstraint(name = "uq_bra_exec_rank",
        columnNames = { "job_execution_id", "rank_position" })
)
public class BatchRankingArtifactEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "batch_ranking_artifact_seq")
    @SequenceGenerator(name = "batch_ranking_artifact_seq", sequenceName = "batch_ranking_artifact_seq",
        allocationSize = 50)
    private Long id;

    @Column(name = "job_execution_id", nullable = false)
    private Long jobExecutionId;

    @NotBlank
    @Size(max = 100)
    @Column(name = "job_name", nullable = false, length = 100)
    private String jobName;

    @NotBlank
    @Size(max = 100)
    @Column(name = "target_city", nullable = false, length = 100)
    private String targetCity;

    @NotBlank
    @Size(max = 60)
    @Column(name = "target_profile_key", nullable = false, length = 60)
    private String targetProfileKey;

    @Min(1)
    @Column(name = "rank_position", nullable = false)
    private int rankPosition;

    @NotBlank
    @Size(max = 120)
    @Column(name = "location_key", nullable = false, length = 120)
    private String locationKey;

    @NotBlank
    @Size(max = 36)
    @Column(name = "brief_id", nullable = false, length = 36)
    private String briefId;

    @Column(name = "profile_score", nullable = false)
    private double profileScore;

    @Min(0)
    @Column(name = "political_reference_count", nullable = false)
    private int politicalReferenceCount;

    @Min(0)
    @Column(name = "short_term_measures", nullable = false)
    private int shortTermMeasures;

    @Min(0)
    @Column(name = "structural_measures", nullable = false)
    private int structuralMeasures;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    void onCreate() {
        if (createdAt == null) createdAt = Instant.now();
    }

    public Long   getId()                       { return id; }
    public Long   getJobExecutionId()           { return jobExecutionId; }
    public void   setJobExecutionId(Long v)     { this.jobExecutionId = v; }
    public String getJobName()                  { return jobName; }
    public void   setJobName(String v)          { this.jobName = v; }
    public String getTargetCity()               { return targetCity; }
    public void   setTargetCity(String v)       { this.targetCity = v; }
    public String getTargetProfileKey()         { return targetProfileKey; }
    public void   setTargetProfileKey(String v) { this.targetProfileKey = v; }
    public int    getRankPosition()             { return rankPosition; }
    public void   setRankPosition(int v)        { this.rankPosition = v; }
    public String getLocationKey()              { return locationKey; }
    public void   setLocationKey(String v)      { this.locationKey = v; }
    public String getBriefId()                  { return briefId; }
    public void   setBriefId(String v)          { this.briefId = v; }
    public double getProfileScore()             { return profileScore; }
    public void   setProfileScore(double v)     { this.profileScore = v; }
    public int    getPoliticalReferenceCount()  { return politicalReferenceCount; }
    public void   setPoliticalReferenceCount(int v) { this.politicalReferenceCount = v; }
    public int    getShortTermMeasures()        { return shortTermMeasures; }
    public void   setShortTermMeasures(int v)   { this.shortTermMeasures = v; }
    public int    getStructuralMeasures()       { return structuralMeasures; }
    public void   setStructuralMeasures(int v)  { this.structuralMeasures = v; }
    public Instant getCreatedAt()               { return createdAt; }
    public void   setCreatedAt(Instant v)       { this.createdAt = v; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof BatchRankingArtifactEntity that)) return false;
        return Objects.equals(id, that.id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
