package de.unfallatlas.analysis.batch;

import org.springframework.batch.core.scope.context.StepSynchronizationManager;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * JobScope-Container für gemeinsamen, in-memory gehaltenen Zwischenstand
 * eines {@code city-prioritization-job}-Laufs.
 *
 * <p>Bewusst klein gehalten:</p>
 * <ul>
 *   <li>{@link #candidateLocationKeys} – Ergebnis von {@code loadCandidatesStep},
 *       Eingabe von {@code computeBriefsStep}.</li>
 *   <li>{@link #processedBriefIds} – Ergebnis von {@code persistResultsStep}
 *       (IDs der upgedateten/neu geschriebenen Briefs); Eingabe von
 *       {@code buildRankingStep}.</li>
 *   <li>{@link #ranking} – Ergebnis von {@code buildRankingStep},
 *       Grundlage der fachlichen Job-Zusammenfassung.</li>
 * </ul>
 *
 * <p>Wir halten dies bewusst <strong>nicht</strong> im
 * {@code ExecutionContext}, weil der Inhalt rein laufzeitintern ist und
 * über mehrere Jobläufe nicht überleben soll.  Das vereinfacht zudem die
 * Restart-Semantik: ein Restart fängt sauber bei
 * {@code loadCandidatesStep} an.</p>
 */
@Component
public class CityPrioritizationContext {

    public static class RankedLocation {
        public final String locationKey;
        public final String briefId;
        public final double profileScore;
        public final int politicalReferenceCount;
        public final int shortTermMeasures;
        public final int structuralMeasures;
        public RankedLocation(String locationKey, String briefId, double profileScore,
                              int politicalReferenceCount, int shortTermMeasures, int structuralMeasures) {
            this.locationKey = locationKey;
            this.briefId = briefId;
            this.profileScore = profileScore;
            this.politicalReferenceCount = politicalReferenceCount;
            this.shortTermMeasures = shortTermMeasures;
            this.structuralMeasures = structuralMeasures;
        }
    }

    private final List<String> candidateLocationKeys = Collections.synchronizedList(new ArrayList<>());
    private final List<String> processedBriefIds     = Collections.synchronizedList(new ArrayList<>());
    private final List<RankedLocation> ranking       = Collections.synchronizedList(new ArrayList<>());
    /** Aggregierte Kennzahl: Summe aller politischen Referenzen über alle Kandidaten. */
    private volatile int politicalReferenceTotal;
    /** Effektiv aktiver „AI-Polish"-Schalter (in Job-Summary protokolliert). */
    private volatile boolean useAiPolish;
    /** Versions-Pin der Scoring-Logik – bislang konstant, wird über die Konfig steuerbar. */
    private volatile String scoringVersion = "v1";

    public List<String> getCandidateLocationKeys() { return candidateLocationKeys; }
    public List<String> getProcessedBriefIds()     { return processedBriefIds; }
    public List<RankedLocation> getRanking()       { return ranking; }
    public int getPoliticalReferenceTotal()        { return politicalReferenceTotal; }
    public void setPoliticalReferenceTotal(int v)  { this.politicalReferenceTotal = v; }
    public boolean isUseAiPolish()                 { return useAiPolish; }
    public void setUseAiPolish(boolean v)          { this.useAiPolish = v; }
    public String getScoringVersion()              { return scoringVersion; }
    public void setScoringVersion(String v)        { if (v != null && !v.isBlank()) this.scoringVersion = v; }

    public void reset() {
        candidateLocationKeys.clear();
        processedBriefIds.clear();
        ranking.clear();
        politicalReferenceTotal = 0;
        useAiPolish = false;
        scoringVersion = "v1";
    }

    /** Liefert den aktiven Step-Namen (rein für Logs/Diagnose). */
    public static String currentStepName() {
        return Objects.toString(
            StepSynchronizationManager.getContext() != null
                && StepSynchronizationManager.getContext().getStepExecution() != null
                ? StepSynchronizationManager.getContext().getStepExecution().getStepName()
                : "(kein Step)",
            "(unbekannt)");
    }
}
