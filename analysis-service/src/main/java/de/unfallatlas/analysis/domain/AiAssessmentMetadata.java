package de.unfallatlas.analysis.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.validation.constraints.Size;

import java.util.Objects;

/**
 * Optionale Metadaten zur KI-Veredelung eines Briefs.  Wird nur befüllt,
 * wenn der Brief tatsächlich mit KI-Polish erzeugt wurde
 * (siehe {@code aiUsed} im Aggregat).  Die deterministischen Befunde des
 * Briefs sind davon unabhängig.
 */
@Embeddable
public class AiAssessmentMetadata {

    /** z. B. {@code "gemini-2.0-flash"}. */
    @Size(max = 80)
    @Column(name = "ai_model", length = 80)
    private String aiModel;

    /** z. B. {@code "exportAssessmentPrompt.v1"}. */
    @Size(max = 80)
    @Column(name = "ai_prompt_version", length = 80)
    private String aiPromptVersion;

    /** Optionaler Hash über das genaue Prompt-Input (Reproduzierbarkeit). */
    @Size(max = 128)
    @Column(name = "ai_input_fingerprint", length = 128)
    private String aiInputFingerprint;

    /**
     * Quelle der KI-Antwort: z. B. {@code "ai"}, {@code "ai-repaired"},
     * {@code "fallback"}, {@code "cache"}.  Erlaubt es, später Cache- vs.
     * Fresh-Läufe zu unterscheiden.
     */
    @Size(max = 30)
    @Column(name = "ai_source", length = 30)
    private String aiSource;

    public AiAssessmentMetadata() {}

    public AiAssessmentMetadata(String aiModel, String aiPromptVersion, String aiInputFingerprint, String aiSource) {
        this.aiModel = aiModel;
        this.aiPromptVersion = aiPromptVersion;
        this.aiInputFingerprint = aiInputFingerprint;
        this.aiSource = aiSource;
    }

    public String getAiModel() { return aiModel; }
    public void setAiModel(String aiModel) { this.aiModel = aiModel; }
    public String getAiPromptVersion() { return aiPromptVersion; }
    public void setAiPromptVersion(String aiPromptVersion) { this.aiPromptVersion = aiPromptVersion; }
    public String getAiInputFingerprint() { return aiInputFingerprint; }
    public void setAiInputFingerprint(String aiInputFingerprint) { this.aiInputFingerprint = aiInputFingerprint; }
    public String getAiSource() { return aiSource; }
    public void setAiSource(String aiSource) { this.aiSource = aiSource; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof AiAssessmentMetadata that)) return false;
        return Objects.equals(aiModel, that.aiModel)
            && Objects.equals(aiPromptVersion, that.aiPromptVersion)
            && Objects.equals(aiInputFingerprint, that.aiInputFingerprint)
            && Objects.equals(aiSource, that.aiSource);
    }
    @Override public int hashCode() {
        return Objects.hash(aiModel, aiPromptVersion, aiInputFingerprint, aiSource);
    }
}
