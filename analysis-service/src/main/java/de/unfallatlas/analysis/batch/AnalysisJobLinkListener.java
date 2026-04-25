package de.unfallatlas.analysis.batch;

import de.unfallatlas.analysis.batch.CityPrioritizationContext.RankedLocation;
import de.unfallatlas.analysis.domain.AnalysisJobEntity;
import de.unfallatlas.analysis.persistence.AnalysisJobRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.batch.core.job.JobExecution;
import org.springframework.batch.core.job.parameters.JobParameters;
import org.springframework.batch.core.listener.JobExecutionListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Hängt jede Spring-Batch-Ausführung an einen passenden
 * {@link AnalysisJobEntity}-Datensatz an.
 *
 * <p>So bleiben Spring-Batch-Metadaten ({@code BATCH_*}) und das fachliche
 * Job-Modell sauber getrennt, lassen sich aber über
 * {@link AnalysisJobEntity#getJobExecutionId()} verknüpfen.  Das fachliche
 * Modell ist die Antwort auf "Was war das fachliche Ergebnis dieses Laufs?"
 * (Top-N, Anzahl bewerteter Stellen, Fehlertext); die {@code BATCH_*}-Tabellen
 * antworten "Wie ist der Lauf technisch gelaufen?" (Step-Status, ExitCode,
 * Restart).</p>
 */
@Component
public class AnalysisJobLinkListener implements JobExecutionListener {

    private static final Logger LOG = LoggerFactory.getLogger(AnalysisJobLinkListener.class);

    private final AnalysisJobRepository jobRepo;
    private final CityPrioritizationContext context;

    public AnalysisJobLinkListener(AnalysisJobRepository jobRepo, CityPrioritizationContext context) {
        this.jobRepo = jobRepo;
        this.context = context;
    }

    @Override
    @Transactional
    public void beforeJob(JobExecution jobExecution) {
        JobParameters p = jobExecution.getJobParameters();
        AnalysisJobEntity job = new AnalysisJobEntity();
        job.setJobType(CityPrioritizationJobConfig.JOB_NAME);
        job.setStatus(AnalysisJobEntity.Status.RUNNING);
        job.setTargetCity(p.getString("city"));
        job.setTargetProfileKey(p.getString("profile"));
        job.setRunLabel(p.getString("runLabel"));
        job.setJobExecutionId(jobExecution.getId());
        job.setStartedAt(Instant.now());
        jobRepo.save(job);
        LOG.info("[batch][listener] Job {} gestartet (executionId={}, city={}, profile={})",
            CityPrioritizationJobConfig.JOB_NAME, jobExecution.getId(),
            p.getString("city"), p.getString("profile"));
    }

    @Override
    @Transactional
    public void afterJob(JobExecution jobExecution) {
        AnalysisJobEntity job = jobRepo.findFirstByJobExecutionIdOrderByCreatedAtDesc(jobExecution.getId())
            .orElseGet(() -> {
                LOG.warn("[batch][listener] kein AnalysisJob für executionId={} – wird nachträglich angelegt",
                    jobExecution.getId());
                AnalysisJobEntity placeholder = new AnalysisJobEntity();
                placeholder.setJobType(CityPrioritizationJobConfig.JOB_NAME);
                placeholder.setStatus(AnalysisJobEntity.Status.RUNNING);
                placeholder.setJobExecutionId(jobExecution.getId());
                return jobRepo.save(placeholder);
            });

        boolean ok = !jobExecution.getStatus().isUnsuccessful()
            && jobExecution.getStatus() == org.springframework.batch.core.BatchStatus.COMPLETED;
        job.setStatus(ok ? AnalysisJobEntity.Status.SUCCEEDED : AnalysisJobEntity.Status.FAILED);
        job.setFinishedAt(Instant.now());
        job.setAttempts(job.getAttempts() + 1);
        if (!ok) {
            String err = jobExecution.getAllFailureExceptions().stream()
                .map(Throwable::toString)
                .collect(Collectors.joining(" | "));
            if (err.isBlank()) {
                err = "exitStatus=" + jobExecution.getExitStatus().getExitCode();
            }
            job.setLastError(truncate(err, 2000));
        }
        job.setSummary(buildSummary(jobExecution));
        jobRepo.save(job);
        LOG.info("[batch][listener] Job {} beendet: status={}, executionId={}",
            CityPrioritizationJobConfig.JOB_NAME,
            job.getStatus(), jobExecution.getId());
    }

    private String buildSummary(JobExecution jobExecution) {
        // Kompaktes JSON ohne externe Bibliothek-Abhängigkeit – die
        // Felder sind klein und kontrolliert, ein full-Jackson-Roundtrip
        // wäre Overkill.
        StringBuilder sb = new StringBuilder(384);
        sb.append('{');
        sb.append("\"executionId\":").append(jobExecution.getId());
        sb.append(",\"status\":\"").append(jobExecution.getStatus()).append('"');
        sb.append(",\"exitCode\":\"").append(escape(jobExecution.getExitStatus().getExitCode())).append('"');
        sb.append(",\"processed\":").append(context.getProcessedBriefIds().size());
        sb.append(",\"candidates\":").append(context.getCandidateLocationKeys().size());
        sb.append(",\"politicalReferenceTotal\":").append(context.getPoliticalReferenceTotal());
        sb.append(",\"useAiPolish\":").append(context.isUseAiPolish());
        sb.append(",\"scoringVersion\":\"").append(escape(context.getScoringVersion())).append('"');
        sb.append(",\"top\":[");
        List<RankedLocation> ranking = context.getRanking();
        for (int i = 0; i < ranking.size(); i++) {
            if (i > 0) sb.append(',');
            RankedLocation r = ranking.get(i);
            sb.append("{\"locationKey\":\"").append(escape(r.locationKey)).append('"');
            sb.append(",\"briefId\":\"").append(escape(r.briefId)).append('"');
            sb.append(",\"score\":").append(formatScore(r.profileScore));
            sb.append(",\"politicalReferenceCount\":").append(r.politicalReferenceCount);
            sb.append(",\"shortTermMeasures\":").append(r.shortTermMeasures);
            sb.append(",\"structuralMeasures\":").append(r.structuralMeasures);
            sb.append('}');
        }
        sb.append(']');
        sb.append('}');
        return truncate(sb.toString(), 4000);
    }

    private static String formatScore(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "0";
        return String.format(java.util.Locale.ROOT, "%.4f", v);
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String truncate(String s, int max) {
        return (s != null && s.length() > max) ? s.substring(0, max) : s;
    }
}
