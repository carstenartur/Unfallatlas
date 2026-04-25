package de.unfallatlas.analysis.batch;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Eingabevertrag für den {@code city-prioritization-job}.
 *
 * <p>Wird vom Controller validiert und in
 * {@link org.springframework.batch.core.JobParameters} übersetzt.
 * Die Job-Parameter sind so geschnitten, dass jeder Lauf eindeutig
 * identifizierbar ist (Spring-Batch ordnet pro identifizierender
 * Parameter-Kombination eine {@code JobInstance} zu):</p>
 *
 * <ul>
 *   <li><b>city</b> (identifizierend): Stadt, deren Briefs neu priorisiert
 *       werden sollen.</li>
 *   <li><b>profile</b> (identifizierend): Bewertungsprofil
 *       (z. B. {@code bicycle_safety_priority}).</li>
 *   <li><b>recomputeExisting</b> (identifizierend): {@code true} =
 *       bestehende Briefs werden neu eingelesen und neu bewertet,
 *       {@code false} = nur fehlende werden nachgezogen.</li>
 *   <li><b>limit</b> (nicht identifizierend, default {@code 100}):
 *       Begrenzung der zu verarbeitenden Stellen.</li>
 *   <li><b>runLabel</b> (nicht identifizierend): Frei wählbarer Lauf-Label
 *       (z. B. {@code "monatlich-2026-04"}).  Wird im
 *       {@link de.unfallatlas.analysis.domain.AnalysisJobEntity} gespeichert
 *       und erscheint in der Lauf-Zusammenfassung, ändert die JobInstance
 *       aber nicht.</li>
 * </ul>
 */
public class CityPrioritizationJobRequest {

    @NotBlank
    @Size(max = 100)
    public String city;

    @NotBlank
    @Size(max = 60)
    public String profile;

    public Boolean recomputeExisting;
    public Integer limit;

    @Size(max = 120)
    public String runLabel;

    /**
     * Optionaler „AI-Polish"-Schalter: aktiviert in einer späteren
     * Iteration die KI-gestützte Nachformulierung der deterministischen
     * Maßnahmen-Karten.  Aktuell wird der Wert vom Job nur mitgeführt,
     * in der Lauf-Zusammenfassung sichtbar gemacht und an die
     * Persistenzschicht weitergereicht – die deterministische Pipeline
     * ist davon unbeeinflusst.  Default: {@code false}.
     */
    public Boolean useAiPolish;

    public boolean recomputeExistingOrDefault() {
        return recomputeExisting != null && recomputeExisting;
    }

    public boolean useAiPolishOrDefault() {
        return useAiPolish != null && useAiPolish;
    }

    public int limitOrDefault() {
        if (limit == null) return 100;
        return Math.min(Math.max(1, limit), 1000);
    }
}
