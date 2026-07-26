package de.unfallatlas.analysis.batch;

import de.unfallatlas.analysis.api.LocationBriefService;
import de.unfallatlas.analysis.domain.AnalysisJobEntity;
import de.unfallatlas.analysis.persistence.AnalysisJobRepository;
import de.unfallatlas.analysis.persistence.LocationActionBriefRepository;
import de.unfallatlas.analysis.support.LocationBriefFixtures;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.batch.core.BatchStatus;
import org.springframework.batch.core.ExitStatus;
import org.springframework.batch.core.job.Job;
import org.springframework.batch.core.job.JobExecution;
import org.springframework.batch.core.job.parameters.JobParameters;
import org.springframework.batch.core.job.parameters.JobParametersBuilder;
import org.springframework.batch.core.launch.JobOperator;
import org.springframework.batch.core.repository.JobRepository;
import org.springframework.batch.core.step.StepExecution;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integrationstest des {@code city-prioritization-job}.
 *
 * <p>Deckt die in der Aufgabenstellung geforderten Szenarien ab:</p>
 * <ul>
 *   <li>Job-Konfiguration und Step-Reihenfolge (alle 6 Steps in
 *       erwarteter Folge),</li>
 *   <li>erfolgreicher Lauf mit zwei seedeten Stellen,</li>
 *   <li>Lauf mit leerer Eingabe (Stadt ohne Briefs) → COMPLETED mit
 *       {@code processed=0},</li>
 *   <li>Persistenz der Batch-Metadaten (BATCH_JOB_EXECUTION) und der
 *       fachlichen Lauf-Zusammenfassung im
 *       {@link AnalysisJobEntity},</li>
 *   <li>keine Beschädigung bestehender Entitäten (Briefs sind nach Lauf
 *       unverändert vorhanden).</li>
 * </ul>
 */
@SpringBootTest
@DisplayName("CityPrioritizationJob – End-to-End")
class CityPrioritizationJobIntegrationTest {

    @Autowired private JobOperator jobOperator;
    @Autowired private Job cityPrioritizationJob;
    @Autowired private JobRepository jobRepository;
    @Autowired private LocationBriefService briefs;
    @Autowired private LocationActionBriefRepository briefRepo;
    @Autowired private AnalysisJobRepository jobRepo;
    @Autowired private ApplicationContext ctx;

    @BeforeEach
    void clean() {
        jobRepo.deleteAll();
        briefRepo.deleteAll();
    }

    @Test
    @DisplayName("Job-Bean ist verfügbar und nutzt Spring Batch")
    void jobBeanIsConfigured() {
        assertThat(cityPrioritizationJob).isNotNull();
        assertThat(cityPrioritizationJob.getName()).isEqualTo(CityPrioritizationJobConfig.JOB_NAME);
        // Alle sechs Steps existieren als Beans
        assertThat(ctx.containsBean("loadCandidatesStep")).isTrue();
        assertThat(ctx.containsBean("enrichPoliticalContextStep")).isTrue();
        assertThat(ctx.containsBean("computeBriefsStep")).isTrue();
        assertThat(ctx.containsBean("scoreProfilesStep")).isTrue();
        assertThat(ctx.containsBean("persistResultsStep")).isTrue();
        assertThat(ctx.containsBean("buildRankingArtifactsStep")).isTrue();
    }

    @Test
    @DisplayName("Erfolgreicher Lauf mit zwei Stellen führt alle Steps in Reihenfolge aus")
    void runsAllStepsInOrderForSeededData() throws Exception {
        // Zwei Briefs seeden, gleiche Stadt + gleiches Profil (über meta.profile gesteuert),
        // aber unterschiedliche locationId → unterschiedliche locationKeys.
        var dto1 = LocationBriefFixtures.bicycleTurningConflictBrief();
        dto1.locationId = "hannover::knoten_a";
        dto1.title = "Knoten A";
        var dto2 = LocationBriefFixtures.bicycleTurningConflictBrief();
        dto2.locationId = "hannover::knoten_b";
        dto2.title = "Knoten B";
        var saved1 = briefs.ingest(dto1);
        var saved2 = briefs.ingest(dto2);
        String profile = saved1.getProfileKey();
        String city = saved1.getCity();
        assertThat(saved2.getProfileKey()).isEqualTo(profile);

        JobExecution exec = jobOperator.run(cityPrioritizationJob, params(city, profile, false, 50, "test-run"));

        assertThat(exec.getStatus()).isEqualTo(BatchStatus.COMPLETED);
        assertThat(exec.getExitStatus().getExitCode()).isEqualTo(ExitStatus.COMPLETED.getExitCode());

        List<StepExecution> steps = List.copyOf(exec.getStepExecutions());
        assertThat(steps).extracting(StepExecution::getStepName).containsExactly(
            "loadCandidatesStep",
            "enrichPoliticalContextStep",
            "computeBriefsStep",
            "scoreProfilesStep",
            "persistResultsStep",
            "buildRankingArtifactsStep"
        );

        // Persistenz der Batch-Metadaten: über JobRepository wieder lesbar
        JobExecution reloaded = jobRepository.getJobExecution(exec.getId());
        assertThat(reloaded).isNotNull();
        assertThat(reloaded.getStatus()).isEqualTo(BatchStatus.COMPLETED);

        // Fachliche Lauf-Zusammenfassung wurde im AnalysisJob abgelegt
        AnalysisJobEntity link = jobRepo.findFirstByJobExecutionIdOrderByCreatedAtDesc(exec.getId())
            .orElseThrow();
        assertThat(link.getStatus()).isEqualTo(AnalysisJobEntity.Status.SUCCEEDED);
        assertThat(link.getTargetCity()).isEqualTo(city);
        assertThat(link.getTargetProfileKey()).isEqualTo(profile);
        assertThat(link.getRunLabel()).isEqualTo("test-run");
        assertThat(link.getJobExecutionId()).isEqualTo(exec.getId());
        assertThat(link.getSummary()).contains("\"processed\":2");
        assertThat(link.getSummary()).contains("\"top\":[");

        // Bestehende fachliche Entitäten sind unverändert vorhanden (kein
        // Schreibzugriff durch den Job in dieser Iteration).
        assertThat(briefRepo.count()).isEqualTo(2);
        assertThat(briefRepo.findByLocationKeyOrderByCreatedAtDesc("hannover::knoten_a")).hasSize(1);
    }

    @Test
    @DisplayName("Lauf mit leerer Eingabe schließt sauber ab (processed=0)")
    void runsCleanlyOnEmptyCity() throws Exception {
        JobExecution exec = jobOperator.run(cityPrioritizationJob,
            params("StadtOhneDaten", "low_hanging_fruit", false, 10, null));

        assertThat(exec.getStatus()).isEqualTo(BatchStatus.COMPLETED);
        AnalysisJobEntity link = jobRepo.findFirstByJobExecutionIdOrderByCreatedAtDesc(exec.getId())
            .orElseThrow();
        assertThat(link.getStatus()).isEqualTo(AnalysisJobEntity.Status.SUCCEEDED);
        assertThat(link.getSummary()).contains("\"processed\":0");
        assertThat(link.getSummary()).contains("\"candidates\":0");
        assertThat(link.getSummary()).contains("\"top\":[]");
    }

    @Test
    @DisplayName("Ein zweiter Lauf mit denselben fachlichen Parametern erzeugt eine neue JobInstance (runTimestamp)")
    void rerunCreatesNewJobInstance() throws Exception {
        long instancesBefore = jobRepository.getJobInstanceCount(CityPrioritizationJobConfig.JOB_NAME);

        JobExecution e1 = jobOperator.run(cityPrioritizationJob,
            params("Hannover", "low_hanging_fruit", false, 10, "lauf-1"));
        // runTimestamp macht den Lauf eindeutig – ein zweiter Lauf darf
        // nicht an JobInstanceAlreadyComplete scheitern.
        JobExecution e2 = jobOperator.run(cityPrioritizationJob,
            params("Hannover", "low_hanging_fruit", false, 10, "lauf-2"));

        long instancesAfter = jobRepository.getJobInstanceCount(CityPrioritizationJobConfig.JOB_NAME);
        assertThat(instancesAfter - instancesBefore).isEqualTo(2);
        assertThat(e1.getStatus()).isEqualTo(BatchStatus.COMPLETED);
        assertThat(e2.getStatus()).isEqualTo(BatchStatus.COMPLETED);
        assertThat(e1.getJobInstance().getInstanceId())
            .isNotEqualTo(e2.getJobInstance().getInstanceId());
    }

    private static final java.util.concurrent.atomic.AtomicLong RUN_SEQ = new java.util.concurrent.atomic.AtomicLong();

    private static JobParameters params(String city, String profile, boolean recompute,
                                         int limit, String runLabel) {
        return new JobParametersBuilder()
            .addString("city", city, true)
            .addString("profile", profile, true)
            .addString("recomputeExisting", Boolean.toString(recompute), true)
            .addString("useAiPolish", "false", true)
            .addLong("limit", (long) limit, false)
            .addString("runLabel", runLabel == null ? "" : runLabel, false)
            .addLong("runTimestamp", RUN_SEQ.incrementAndGet(), true)
            .toJobParameters();
    }
}
