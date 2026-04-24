package de.unfallatlas.analysis.domain;

import jakarta.persistence.*;
import jakarta.validation.constraints.*;

import java.util.Objects;

/**
 * Persistierter Auszug aus dem politischen Kontext eines Briefs (siehe
 * {@code politicalContextSummary.js} aus PR #199).  Pro Brief werden die
 * Top-N relevanten Treffer als Sub-Entitäten gespeichert; die aggregierten
 * Felder ({@code previousPoliticalAttention}, {@code policyReadiness}, …)
 * leben am Brief selbst bzw. an einem optionalen Aggregat.
 */
@Entity
@Table(
    name = "political_reference_summary",
    indexes = {
        @Index(name = "idx_prs_topic", columnList = "topic")
    }
)
// Hibernate-Search-Hook (vorbereitet, noch nicht aktiv)
public class PoliticalReferenceSummaryEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "brief_id", nullable = false)
    private LocationActionBriefEntity brief;

    @NotBlank
    @Size(max = 250)
    @Column(nullable = false, length = 250)
    private String title;

    @Size(max = 500)
    @Column(length = 500)
    private String url;

    @Size(max = 60)
    @Column(length = 60)
    private String type;

    /** Optionaler Themenslug, wie ihn die Node-Komponente vergibt. */
    @Size(max = 60)
    @Column(length = 60)
    private String topic;

    @Min(0) @Max(1)
    @Column(nullable = false)
    private double relevance;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public LocationActionBriefEntity getBrief() { return brief; }
    public void setBrief(LocationActionBriefEntity brief) { this.brief = brief; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getUrl() { return url; }
    public void setUrl(String url) { this.url = url; }
    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
    public String getTopic() { return topic; }
    public void setTopic(String topic) { this.topic = topic; }
    public double getRelevance() { return relevance; }
    public void setRelevance(double relevance) { this.relevance = relevance; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof PoliticalReferenceSummaryEntity that)) return false;
        return Objects.equals(id, that.id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
