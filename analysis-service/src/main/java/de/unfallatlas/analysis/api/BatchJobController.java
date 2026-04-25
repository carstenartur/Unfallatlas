package de.unfallatlas.analysis.api;

import de.unfallatlas.analysis.batch.CityPrioritizationJobConfig;
import de.unfallatlas.analysis.batch.CityPrioritizationJobRequest;
import de.unfallatlas.analysis.domain.AnalysisJobEntity;
import de.unfallatlas.analysis.persistence.AnalysisJobRepository;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.batch.core.job.Job;
import org.springframework.batch.core.job.JobExecution;
import org.springframework.batch.core.job.JobInstance;
import org.springframework.batch.core.job.parameters.InvalidJobParametersException;
import org.springframework.batch.core.job.parameters.JobParameters;
import org.springframework.batch.core.job.parameters.JobParametersBuilder;
import org.springframework.batch.core.repository.explore.JobExplorer;
import org.springframework.batch.core.launch.JobExecutionAlreadyRunningException;
import org.springframework.batch.core.launch.JobInstanceAlreadyCompleteException;
import org.springframework.batch.core.launch.JobLauncher;
import org.springframework.batch.core.launch.JobRestartException;
import org.springframework.batch.core.step.StepExecution;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * REST-API zur manuellen Auslösung und Beobachtung von
 * Spring-Batch-Läufen.  Aktuell ist nur der
 * {@code city-prioritization-job} angebunden, das Routing ist aber so
 * geschnitten, dass weitere Jobs später als zusätzliche Pfade ergänzt
 * werden können (z. B. {@code /api/batch/jobs/search-reindex}).
 *
 * <p>Endpunkte:</p>
 * <ul>
 *   <li>{@code POST /api/batch/jobs/city-prioritization} – Lauf starten.</li>
 *   <li>{@code GET  /api/batch/jobs} – jüngste Lauf-Übersicht.</li>
 *   <li>{@code GET  /api/batch/jobs/{executionId}} – technischer Lauf-Status.</li>
 *   <li>{@code GET  /api/batch/jobs/{executionId}/summary} – fachliche
 *       Zusammenfassung (Top-N, Anzahl bewerteter Stellen, Fehler).</li>
 * </ul>
 *
 * <p>Die Endpunkte sind dünn: sie validieren Eingaben, übersetzen sie in
 * {@link JobParameters} und lesen den fachlichen Lauf-Status aus
 * {@link AnalysisJobRepository} bzw. die technische Sicht aus
 * {@link JobExplorer}.</p>
 */
@RestController
@RequestMapping("/api/batch/jobs")
public class BatchJobController {

    private static final Logger LOG = LoggerFactory.getLogger(BatchJobController.class);

    private final JobLauncher jobLauncher;
    private final JobExplorer jobExplorer;
    private final Job cityPrioritizationJob;
    private final AnalysisJobRepository analysisJobs;

    public BatchJobController(JobLauncher jobLauncher,
                              JobExplorer jobExplorer,
                              Job cityPrioritizationJob,
                              AnalysisJobRepository analysisJobs) {
        this.jobLauncher = jobLauncher;
        this.jobExplorer = jobExplorer;
        this.cityPrioritizationJob = cityPrioritizationJob;
        this.analysisJobs = analysisJobs;
    }

    @PostMapping("/city-prioritization")
    public ResponseEntity<Map<String, Object>> startCityPrioritization(
            @Valid @RequestBody CityPrioritizationJobRequest req) {

        // Identifizierende Parameter (city/profile/recomputeExisting)
        // sorgen dafür, dass jede sinnvoll unterschiedliche Anfrage eine
        // eigene JobInstance bekommt.  `runTimestamp` ist zusätzlich
        // identifizierend und macht Wieder-Auslösungen mit denselben
        // fachlichen Parametern eindeutig (Spring Batch verbietet sonst
        // einen erneuten Lauf einer bereits abgeschlossenen JobInstance).
        JobParameters params = new JobParametersBuilder()
            .addString("city",    req.city,    true)
            .addString("profile", req.profile, true)
            .addString("recomputeExisting",
                Boolean.toString(req.recomputeExistingOrDefault()), true)
            .addLong("limit",      (long) req.limitOrDefault(), false)
            .addString("runLabel", req.runLabel == null ? "" : req.runLabel, false)
            .addLong("runTimestamp", System.currentTimeMillis(), true)
            .toJobParameters();

        try {
            JobExecution execution = jobLauncher.run(cityPrioritizationJob, params);
            LOG.info("[batch][rest] city-prioritization gestartet: executionId={}, city={}, profile={}",
                execution.getId(), req.city, req.profile);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("jobName",     CityPrioritizationJobConfig.JOB_NAME);
            body.put("executionId", execution.getId());
            body.put("status",      execution.getStatus().toString());
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(body);
        } catch (JobExecutionAlreadyRunningException e) {
            return error(HttpStatus.CONFLICT, "JOB_ALREADY_RUNNING", e.getMessage());
        } catch (JobInstanceAlreadyCompleteException e) {
            return error(HttpStatus.CONFLICT, "JOB_INSTANCE_ALREADY_COMPLETE", e.getMessage());
        } catch (InvalidJobParametersException e) {
            return error(HttpStatus.BAD_REQUEST, "INVALID_JOB_PARAMETERS", e.getMessage());
        } catch (JobRestartException e) {
            return error(HttpStatus.CONFLICT, "JOB_RESTART_FAILED", e.getMessage());
        }
    }

    @GetMapping
    public List<Map<String, Object>> listRecent(
            @RequestParam(value = "limit", defaultValue = "20") int limit) {
        int safe = Math.min(Math.max(1, limit), 100);
        List<AnalysisJobEntity> recent = analysisJobs.findByJobTypeOrderByCreatedAtDesc(
            CityPrioritizationJobConfig.JOB_NAME, PageRequest.of(0, safe));
        List<Map<String, Object>> out = new ArrayList<>(recent.size());
        for (AnalysisJobEntity j : recent) out.add(toAnalysisJobView(j));
        return out;
    }

    @GetMapping("/{executionId}")
    public ResponseEntity<Map<String, Object>> getStatus(@PathVariable Long executionId) {
        JobExecution execution = jobExplorer.getJobExecution(executionId);
        if (execution == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(toExecutionView(execution));
    }

    @GetMapping("/{executionId}/summary")
    public ResponseEntity<Map<String, Object>> getSummary(@PathVariable Long executionId) {
        Optional<AnalysisJobEntity> link = analysisJobs.findFirstByJobExecutionIdOrderByCreatedAtDesc(executionId);
        JobExecution exec = jobExplorer.getJobExecution(executionId);
        if (link.isEmpty() && exec == null) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("executionId", executionId);
        body.put("status",      exec != null ? exec.getStatus().toString()
                                              : link.map(j -> j.getStatus().name()).orElse("UNKNOWN"));
        if (exec != null) {
            body.put("exitCode", exec.getExitStatus().getExitCode());
            body.put("startTime", toIsoOrNull(exec.getStartTime()));
            body.put("endTime",   toIsoOrNull(exec.getEndTime()));
        }
        link.ifPresent(j -> {
            body.put("jobType",   j.getJobType());
            body.put("city",      j.getTargetCity());
            body.put("profile",   j.getTargetProfileKey());
            body.put("runLabel",  j.getRunLabel());
            body.put("attempts",  j.getAttempts());
            body.put("lastError", j.getLastError());
            body.put("summary",   j.getSummary());
        });
        return ResponseEntity.ok(body);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private Map<String, Object> toAnalysisJobView(AnalysisJobEntity j) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id",            j.getId());
        m.put("jobType",       j.getJobType());
        m.put("status",        j.getStatus().name());
        m.put("city",          j.getTargetCity());
        m.put("profile",       j.getTargetProfileKey());
        m.put("runLabel",      j.getRunLabel());
        m.put("executionId",   j.getJobExecutionId());
        m.put("createdAt",     toIsoOrNull(toLdtFromInstant(j.getCreatedAt())));
        m.put("startedAt",     toIsoOrNull(toLdtFromInstant(j.getStartedAt())));
        m.put("finishedAt",    toIsoOrNull(toLdtFromInstant(j.getFinishedAt())));
        m.put("attempts",      j.getAttempts());
        return m;
    }

    private Map<String, Object> toExecutionView(JobExecution execution) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("executionId", execution.getId());
        body.put("jobName",     execution.getJobInstance() != null ? execution.getJobInstance().getJobName() : null);
        body.put("status",      execution.getStatus().toString());
        body.put("exitCode",    execution.getExitStatus().getExitCode());
        body.put("createTime",  toIsoOrNull(execution.getCreateTime()));
        body.put("startTime",   toIsoOrNull(execution.getStartTime()));
        body.put("endTime",     toIsoOrNull(execution.getEndTime()));

        List<Map<String, Object>> steps = new ArrayList<>();
        for (StepExecution se : execution.getStepExecutions()) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("stepName",  se.getStepName());
            s.put("status",    se.getStatus().toString());
            s.put("readCount", se.getReadCount());
            s.put("writeCount", se.getWriteCount());
            s.put("processSkipCount", se.getProcessSkipCount());
            s.put("startTime", toIsoOrNull(se.getStartTime()));
            s.put("endTime",   toIsoOrNull(se.getEndTime()));
            s.put("exitCode",  se.getExitStatus().getExitCode());
            steps.add(s);
        }
        body.put("steps", steps);

        JobInstance ji = execution.getJobInstance();
        if (ji != null) {
            body.put("jobInstanceId", ji.getInstanceId());
        }
        return body;
    }

    private static String toIsoOrNull(java.time.LocalDateTime t) {
        return t == null ? null : t.toString();
    }

    private static java.time.LocalDateTime toLdtFromInstant(Instant i) {
        return i == null ? null : java.time.LocalDateTime.ofInstant(i, java.time.ZoneOffset.UTC);
    }

    private static ResponseEntity<Map<String, Object>> error(HttpStatus status, String code, String msg) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error",    true);
        body.put("category", "batch");
        body.put("code",     code);
        body.put("message",  msg);
        return ResponseEntity.status(status).body(body);
    }
}
