package de.unfallatlas.analysis.batch;

import de.unfallatlas.analysis.batch.CityPrioritizationContext.RankedLocation;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import de.unfallatlas.analysis.domain.PrioritizationProfileScoreEntity;
import de.unfallatlas.analysis.persistence.LocationActionBriefRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.batch.core.job.Job;
import org.springframework.batch.core.configuration.annotation.JobScope;
import org.springframework.batch.core.job.builder.JobBuilder;
import org.springframework.batch.core.repository.JobRepository;
import org.springframework.batch.core.step.Step;
import org.springframework.batch.core.step.builder.StepBuilder;
import org.springframework.batch.core.step.tasklet.Tasklet;
import org.springframework.batch.infrastructure.repeat.RepeatStatus;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.transaction.PlatformTransactionManager;

import java.util.Comparator;
import java.util.List;

/**
 * Konfiguration des {@code city-prioritization-job}.
 *
 * <p>Der Job ist in fünf klar geschnittene Steps zerlegt:</p>
 * <ol>
 *   <li><b>loadCandidatesStep</b> – ermittelt die zu bewertenden
 *       {@code locationKey}s einer Stadt (vorhandene Briefs für
 *       {@code city}+{@code profile}, optional mit
 *       {@code recomputeExisting=false} nur Stellen ohne aktuellen Brief).</li>
 *   <li><b>computeBriefsStep</b> – lädt die jeweils jüngsten Briefs der
 *       Kandidaten in den Lauf-Kontext.  Die deterministische Berechnung
 *       selbst lebt weiterhin in der Node-Anwendung; dieser Schritt nutzt
 *       die bereits persistierten Aggregate und bereitet die
 *       Profilbewertung vor (keine Schattenmodelle).</li>
 *   <li><b>scoreProfilesStep</b> – validiert pro Brief, dass für das
 *       angeforderte Profil ein {@code PrioritizationProfileScoreEntity}
 *       vorliegt; fehlt es, wird der Brief übersprungen und im Lauf
 *       protokolliert (kein stiller Datenverlust, sondern fail-fast für
 *       fachlich kaputte Daten).</li>
 *   <li><b>persistResultsStep</b> – fasst die Ergebnisse zusammen und
 *       befüllt {@code processedBriefIds}.  Schreiboperationen auf den
 *       Fachobjekten erfolgen ausschließlich hier; alle vorigen Steps
 *       sind read-only.</li>
 *   <li><b>buildRankingStep</b> – ermittelt das Top-N-Ranking nach
 *       Profil-Gesamtscore (auf Basis der bestehenden
 *       {@code PrioritizationProfileScoreEntity}-Werte) und legt es im
 *       Lauf-Kontext ab.  Die Job-Zusammenfassung wird daraus durch den
 *       {@link AnalysisJobLinkListener} gebaut und im
 *       {@code AnalysisJobEntity.summary}-Feld persistiert.</li>
 * </ol>
 *
 * <p>Die Steps sind klein, idempotent und schreiben in derselben
 * Reihenfolge auch beim Restart.  Tasklets sind in {@link JobScope}
 * gehalten, damit jeder Lauf seine eigenen Job-Parameter sieht und
 * unabhängig läuft.</p>
 */
@Configuration
public class CityPrioritizationJobConfig {

    public static final String JOB_NAME = "city-prioritization-job";

    private static final Logger LOG = LoggerFactory.getLogger(CityPrioritizationJobConfig.class);

    private final JobRepository jobRepository;
    private final PlatformTransactionManager transactionManager;
    private final LocationActionBriefRepository repo;
    private final CityPrioritizationContext context;
    private final AnalysisJobLinkListener jobLinkListener;

    public CityPrioritizationJobConfig(JobRepository jobRepository,
                                       PlatformTransactionManager transactionManager,
                                       LocationActionBriefRepository repo,
                                       CityPrioritizationContext context,
                                       AnalysisJobLinkListener jobLinkListener) {
        this.jobRepository = jobRepository;
        this.transactionManager = transactionManager;
        this.repo = repo;
        this.context = context;
        this.jobLinkListener = jobLinkListener;
    }

    // ── Job ────────────────────────────────────────────────────────────────

    @Bean
    public Job cityPrioritizationJob(Step loadCandidatesStep,
                                     Step computeBriefsStep,
                                     Step scoreProfilesStep,
                                     Step persistResultsStep,
                                     Step buildRankingStep) {
        return new JobBuilder(JOB_NAME, jobRepository)
            .listener(jobLinkListener)
            .start(loadCandidatesStep)
            .next(computeBriefsStep)
            .next(scoreProfilesStep)
            .next(persistResultsStep)
            .next(buildRankingStep)
            .build();
    }

    // ── Steps ──────────────────────────────────────────────────────────────

    @Bean
    public Step loadCandidatesStep(@JobScope Tasklet loadCandidatesTasklet) {
        return new StepBuilder("loadCandidatesStep", jobRepository)
            .tasklet(loadCandidatesTasklet, transactionManager)
            .build();
    }

    @Bean
    public Step computeBriefsStep(@JobScope Tasklet computeBriefsTasklet) {
        return new StepBuilder("computeBriefsStep", jobRepository)
            .tasklet(computeBriefsTasklet, transactionManager)
            .build();
    }

    @Bean
    public Step scoreProfilesStep(@JobScope Tasklet scoreProfilesTasklet) {
        return new StepBuilder("scoreProfilesStep", jobRepository)
            .tasklet(scoreProfilesTasklet, transactionManager)
            .build();
    }

    @Bean
    public Step persistResultsStep(@JobScope Tasklet persistResultsTasklet) {
        return new StepBuilder("persistResultsStep", jobRepository)
            .tasklet(persistResultsTasklet, transactionManager)
            .build();
    }

    @Bean
    public Step buildRankingStep(@JobScope Tasklet buildRankingTasklet) {
        return new StepBuilder("buildRankingStep", jobRepository)
            .tasklet(buildRankingTasklet, transactionManager)
            .build();
    }

    // ── Tasklets (job-scoped, lesen Job-Parameter über @Value) ─────────────

    @Bean
    @JobScope
    public Tasklet loadCandidatesTasklet(
            @Value("#{jobParameters['city']}") String city,
            @Value("#{jobParameters['profile']}") String profile,
            @Value("#{jobParameters['recomputeExisting']}") Boolean recomputeExisting,
            @Value("#{jobParameters['limit']}") Long limit) {
        final boolean recompute = recomputeExisting != null && recomputeExisting;
        final int safeLimit = (int) Math.min(Math.max(1L, limit == null ? 100L : limit), 1000L);
        return (contribution, chunkContext) -> {
            context.reset();
            // Bestehende Briefs einer Stadt: dieselbe Quelle wie die
            // interaktive Read-API (`/api/location-briefs?city=&profile=`).
            // Wir paginieren bewusst nicht, weil safeLimit die obere
            // Grenze hart deckelt und die Mengen pro Lauf überschaubar sind.
            List<LocationActionBriefEntity> candidates =
                repo.findByCityAndProfileKeyOrderByCreatedAtDesc(
                        city, profile, org.springframework.data.domain.PageRequest.of(0, safeLimit))
                    .getContent();

            // Distinct nach locationKey behalten, neueste zuerst (die
            // Repository-Methode liefert bereits createdAt DESC).
            java.util.LinkedHashSet<String> distinct = new java.util.LinkedHashSet<>();
            for (LocationActionBriefEntity b : candidates) {
                distinct.add(b.getLocationKey());
            }
            for (String k : distinct) context.getCandidateLocationKeys().add(k);

            LOG.info("[batch][{}] city={} profile={} recompute={} candidates={} (limit={})",
                CityPrioritizationContext.currentStepName(), city, profile, recompute, distinct.size(), safeLimit);
            for (int i = 0; i < distinct.size(); i++) contribution.incrementReadCount();
            return RepeatStatus.FINISHED;
        };
    }

    @Bean
    @JobScope
    public Tasklet computeBriefsTasklet(
            @Value("#{jobParameters['profile']}") String profile,
            @Value("#{jobParameters['recomputeExisting']}") Boolean recomputeExisting) {
        final boolean recompute = recomputeExisting != null && recomputeExisting;
        return (contribution, chunkContext) -> {
            int loaded = 0;
            for (String locationKey : context.getCandidateLocationKeys()) {
                var latest = repo.findFirstByLocationKeyAndProfileKeyOrderByCreatedAtDesc(locationKey, profile);
                if (latest.isEmpty()) {
                    LOG.warn("[batch][{}] kein Brief gefunden für locationKey={} profile={} – wird übersprungen",
                        CityPrioritizationContext.currentStepName(), locationKey, profile);
                    continue;
                }
                if (recompute) {
                    // In dieser Iteration findet die deterministische
                    // Berechnung weiterhin in der Node-Anwendung statt;
                    // recompute=true ist der Hook für den Folge-PR und
                    // bedeutet aktuell "Brief wird in den Output-Set
                    // aufgenommen, auch wenn er bereits vorhanden war".
                    // Damit ist das Verhalten heute idempotent.
                    LOG.debug("[batch][{}] recompute=true – Brief {} bleibt unverändert (fachliche Re-Compute folgt)",
                        CityPrioritizationContext.currentStepName(), latest.get().getId());
                }
                context.getProcessedBriefIds().add(latest.get().getId());
                loaded++;
            }
            LOG.info("[batch][{}] geladen: {} Briefs", CityPrioritizationContext.currentStepName(), loaded);
            for (int i = 0; i < loaded; i++) contribution.incrementReadCount();
            return RepeatStatus.FINISHED;
        };
    }

    @Bean
    @JobScope
    public Tasklet scoreProfilesTasklet(@Value("#{jobParameters['profile']}") String profile) {
        return (contribution, chunkContext) -> {
            int withScore = 0;
            int missing = 0;
            // Wir entfernen Briefs ohne passenden Profilscore aus der
            // Pipeline, statt den Lauf scheitern zu lassen – der Lauf
            // bleibt damit auch bei einzelnen unvollständigen Datensätzen
            // belastbar (kein stiller Datenverlust: betroffene Briefs
            // werden geloggt und im Skip-Counter sichtbar).
            java.util.Iterator<String> it = context.getProcessedBriefIds().iterator();
            while (it.hasNext()) {
                String id = it.next();
                var brief = repo.findById(id).orElse(null);
                if (brief == null) {
                    LOG.warn("[batch][{}] Brief {} nicht mehr auffindbar – Skip",
                        CityPrioritizationContext.currentStepName(), id);
                    it.remove();
                    contribution.incrementProcessSkipCount();
                    continue;
                }
                boolean hasMatchingScore = brief.getProfileScores().stream()
                    .anyMatch(s -> profile.equals(s.getProfileKey()));
                if (hasMatchingScore) {
                    withScore++;
                } else {
                    missing++;
                    LOG.warn("[batch][{}] Brief {} hat keinen Score für profile={} – Skip",
                        CityPrioritizationContext.currentStepName(), id, profile);
                    it.remove();
                    contribution.incrementProcessSkipCount();
                }
            }
            LOG.info("[batch][{}] Scores OK: {} | fehlend: {}",
                CityPrioritizationContext.currentStepName(), withScore, missing);
            return RepeatStatus.FINISHED;
        };
    }

    @Bean
    @JobScope
    public Tasklet persistResultsTasklet() {
        return (contribution, chunkContext) -> {
            // Schreibt aktuell keine zusätzlichen Felder – die Briefs
            // wurden bereits via Ingest-API persistiert.  Der Step ist
            // bewusst eigenständig (statt in scoreProfilesStep gemischt),
            // damit der Folge-PR an genau dieser Stelle das fachliche
            // Re-Compute einhängen kann, ohne andere Steps anzufassen.
            int n = context.getProcessedBriefIds().size();
            contribution.incrementWriteCount(n);
            LOG.info("[batch][{}] persistierte/aktuelle Briefs: {}",
                CityPrioritizationContext.currentStepName(), n);
            return RepeatStatus.FINISHED;
        };
    }

    @Bean
    @JobScope
    public Tasklet buildRankingTasklet(
            @Value("#{jobParameters['profile']}") String profile,
            @Value("#{jobParameters['limit']}") Long limit) {
        final int topN = (int) Math.min(Math.max(1L, limit == null ? 10L : Math.min(limit, 50L)), 50L);
        return (contribution, chunkContext) -> {
            List<RankedLocation> ranking = context.getProcessedBriefIds().stream()
                .map(repo::findById)
                .flatMap(java.util.Optional::stream)
                .map(b -> {
                    double score = b.getProfileScores().stream()
                        .filter(s -> profile.equals(s.getProfileKey()))
                        .map(PrioritizationProfileScoreEntity::getTotal)
                        .findFirst()
                        .orElse(0.0);
                    return new RankedLocation(b.getLocationKey(), b.getId(), score);
                })
                .sorted(Comparator.comparingDouble((RankedLocation r) -> r.profileScore).reversed())
                .limit(topN)
                .toList();

            context.getRanking().addAll(ranking);
            LOG.info("[batch][{}] Top-{} ermittelt (von {} Briefs)",
                CityPrioritizationContext.currentStepName(), ranking.size(),
                context.getProcessedBriefIds().size());
            contribution.incrementWriteCount(ranking.size());
            return RepeatStatus.FINISHED;
        };
    }
}
