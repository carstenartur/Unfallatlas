package de.unfallatlas.analysis.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.Objects;

/**
 * Versionierungs-Metadaten, die bei jedem persistierten Brief mitgeführt
 * werden.  Damit lässt sich später nachvollziehen, warum zwei Läufe
 * unterschiedliche Ergebnisse liefern.
 *
 * <p>Diese Felder gehören fachlich zum Brief und sind daher als
 * {@link Embeddable} eingebettet.</p>
 */
@Embeddable
public class VersioningInfo {

    /** Version der Erkennungsregeln (z. B. {@code "conflictPatterns.v1"}). */
    @NotBlank
    @Size(max = 60)
    @Column(name = "rules_version", nullable = false, length = 60)
    private String rulesVersion;

    /** Version des Scoring-Modells (z. B. {@code "scoring.v1"}). */
    @NotBlank
    @Size(max = 60)
    @Column(name = "scoring_version", nullable = false, length = 60)
    private String scoringVersion;

    /** Version der Profilgewichte (z. B. {@code "profiles.v1"}). */
    @NotBlank
    @Size(max = 60)
    @Column(name = "profile_version", nullable = false, length = 60)
    private String profileVersion;

    @Column(name = "generated_at", nullable = false)
    private Instant generatedAt = Instant.now();

    public VersioningInfo() {}

    public VersioningInfo(String rulesVersion, String scoringVersion, String profileVersion, Instant generatedAt) {
        this.rulesVersion = rulesVersion;
        this.scoringVersion = scoringVersion;
        this.profileVersion = profileVersion;
        this.generatedAt = generatedAt != null ? generatedAt : Instant.now();
    }

    public String getRulesVersion() { return rulesVersion; }
    public void setRulesVersion(String rulesVersion) { this.rulesVersion = rulesVersion; }
    public String getScoringVersion() { return scoringVersion; }
    public void setScoringVersion(String scoringVersion) { this.scoringVersion = scoringVersion; }
    public String getProfileVersion() { return profileVersion; }
    public void setProfileVersion(String profileVersion) { this.profileVersion = profileVersion; }
    public Instant getGeneratedAt() { return generatedAt; }
    public void setGeneratedAt(Instant generatedAt) { this.generatedAt = generatedAt; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof VersioningInfo that)) return false;
        return Objects.equals(rulesVersion, that.rulesVersion)
            && Objects.equals(scoringVersion, that.scoringVersion)
            && Objects.equals(profileVersion, that.profileVersion)
            && Objects.equals(generatedAt, that.generatedAt);
    }
    @Override public int hashCode() {
        return Objects.hash(rulesVersion, scoringVersion, profileVersion, generatedAt);
    }
}
