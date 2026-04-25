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
        public RankedLocation(String locationKey, String briefId, double profileScore) {
            this.locationKey = locationKey;
            this.briefId = briefId;
            this.profileScore = profileScore;
        }
    }

    private final List<String> candidateLocationKeys = Collections.synchronizedList(new ArrayList<>());
    private final List<String> processedBriefIds     = Collections.synchronizedList(new ArrayList<>());
    private final List<RankedLocation> ranking       = Collections.synchronizedList(new ArrayList<>());

    public List<String> getCandidateLocationKeys() { return candidateLocationKeys; }
    public List<String> getProcessedBriefIds()     { return processedBriefIds; }
    public List<RankedLocation> getRanking()       { return ranking; }

    public void reset() {
        candidateLocationKeys.clear();
        processedBriefIds.clear();
        ranking.clear();
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
