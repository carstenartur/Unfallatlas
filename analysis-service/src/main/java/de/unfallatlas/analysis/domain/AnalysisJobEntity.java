package de.unfallatlas.analysis.domain;

import jakarta.persistence.*;
import jakarta.validation.constraints.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.Objects;

/**
 * Persistierbares Job-Modell als <em>Vorbereitung</em> für eine spätere
 * Batch- bzw. Queue-Verarbeitung im Analysis Service (z. B. stadtweite
 * Neuberechnung, asynchrone Top-N-Aktualisierung, Hibernate-Search-
 * Reindex).
 *
 * <p>In dieser Iteration werden Jobs lediglich persistiert und über
 * {@link de.unfallatlas.analysis.persistence.AnalysisJobRepository} gelesen –
 * die eigentliche Verarbeitung (Worker, Locking, Backoff, verteilte
 * Ausführung) kommt im Folge-PR. Das Modell ist absichtlich klein und
 * stabil gehalten, damit die Schnittstelle ohne Bruch erweitert werden
 * kann.</p>
 */
@Entity
@Table(
    name = "analysis_job",
    indexes = {
        @Index(name = "idx_aj_status",     columnList = "status"),
        @Index(name = "idx_aj_job_type",   columnList = "job_type"),
        @Index(name = "idx_aj_created_at", columnList = "created_at")
    }
)
public class AnalysisJobEntity {

    /** Lebenszyklus eines Jobs. */
    public enum Status { PENDING, RUNNING, SUCCEEDED, FAILED, CANCELLED }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /**
     * Frei wählbarer Typ-Diskriminator (z. B.
     * {@code "city.recompute"}, {@code "city.topN.refresh"},
     * {@code "search.reindex"}).
     */
    @NotBlank
    @Size(max = 60)
    @Column(name = "job_type", nullable = false, length = 60)
    private String jobType;

    @NotNull
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 12)
    private Status status = Status.PENDING;

    @Size(max = 100)
    @Column(name = "target_city", length = 100)
    private String targetCity;

    @Size(max = 60)
    @Column(name = "target_profile_key", length = 60)
    private String targetProfileKey;

    /** Optionaler frei verwendbarer JSON-/Textpayload. */
    @Size(max = 4000)
    @Column(length = 4000)
    private String payload;

    @Size(max = 2000)
    @Column(name = "last_error", length = 2000)
    private String lastError;

    @Min(0)
    @Column(nullable = false)
    private int attempts = 0;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getJobType() { return jobType; }
    public void setJobType(String jobType) { this.jobType = jobType; }
    public Status getStatus() { return status; }
    public void setStatus(Status status) { this.status = status; }
    public String getTargetCity() { return targetCity; }
    public void setTargetCity(String targetCity) { this.targetCity = targetCity; }
    public String getTargetProfileKey() { return targetProfileKey; }
    public void setTargetProfileKey(String targetProfileKey) { this.targetProfileKey = targetProfileKey; }
    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }
    public String getLastError() { return lastError; }
    public void setLastError(String lastError) { this.lastError = lastError; }
    public int getAttempts() { return attempts; }
    public void setAttempts(int attempts) { this.attempts = attempts; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
    public Instant getStartedAt() { return startedAt; }
    public void setStartedAt(Instant startedAt) { this.startedAt = startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public void setFinishedAt(Instant finishedAt) { this.finishedAt = finishedAt; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof AnalysisJobEntity that)) return false;
        return Objects.equals(id, that.id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
