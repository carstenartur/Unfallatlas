package de.unfallatlas.analysis.batch;

import de.unfallatlas.analysis.batch.CityPrioritizationContext.RankedLocation;
import de.unfallatlas.analysis.domain.BatchRankingArtifactEntity;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import de.unfallatlas.analysis.domain.PrioritizationProfileScoreEntity;
import de.unfallatlas.analysis.persistence.BatchRankingArtifactRepository;
import de.unfallatlas.analysis.persistence.LocationActionBriefRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.batch.core.job.Job;
import org.springframework.batch.core.configuration.annotation.JobScope;
import org.springframework.batch.core.job.builder.JobBuilder;
import org.springframework.batch.core.repository.JobRepository;
import org.springframework.batch.core.scope.context.StepSynchronizationManager;
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
 * <p>Der Job ist in sechs klar geschnittene Steps zerlegt:</p>
 * <ol>
 *   <li><b>loadCandidatesStep</b> – ermittelt die zu bewertenden
 *       {@code locationKey}s einer Stadt.</li>
 *   <li><b>enrichPoliticalContextStep</b> – aggregiert pro Lauf die
 *       Anzahl persistierter politischer Referenzen über alle
 *       Kandidaten.  Dieser Step bereitet die in Decision-Cards
 *       sichtbare Datenherkunft („political_attention") vor und
 *       erfolgt bewusst <em>vor</em> {@code computeBriefsStep}, damit
 *       fehlende politische Vorbefassung im selben Lauf protokolliert
 *       werden kann.</li>
 *   <li><b>computeBriefsStep</b> – lädt die jeweils jüngsten Briefs der
 *       Kandidaten in den Lauf-Kontext.</li>
 *   <li><b>scoreProfilesStep</b> – validiert pro Brief, dass für das
 *       angeforderte Profil ein {@code PrioritizationProfileScoreEntity}
 *       vorliegt.</li>
 *   <li><b>persistResultsStep</b> – fasst die Ergebnisse zusammen und
 *       befüllt {@code processedBriefIds}.</li>
 *   <li><b>buildRankingArtifactsStep</b> – ermittelt das Top-N-Ranking
 *       und persistiert es als {@link BatchRankingArtifactEntity}-Reihe,
 *       damit es nach dem Lauf reproduzierbar abrufbar ist (UI „Aus
 *       Batch laden", Vergleichsmodus).  Die fachliche Zusammenfassung
 *       im {@code AnalysisJobEntity.summary} bleibt zusätzlich erhalten.</li>
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
    private final BatchRankingArtifactRepository rankingRepo;
    private final CityPrioritizationContext context;
    private final AnalysisJobLinkListener jobLinkListener;

    public CityPrioritizationJobConfig(JobRepository jobRepository,
                                       PlatformTransactionManager transactionManager,
                                       LocationActionBriefRepository repo,
                                       BatchRankingArtifactRepository rankingRepo,
                                       CityPrioritizationContext context,
                                       AnalysisJobLinkListener jobLinkListener) {
        this.jobRepository = jobRepository;
        this.transactionManager = transactionManager;
        this.repo = repo;
        this.rankingRepo = rankingRepo;
        this.context = context;
        this.jobLinkListener = jobLinkListener;
    }

    // ── Job ────────────────────────────────────────────────────────────────

    @Bean
    public Job cityPrioritizationJob(Step loadCandidatesStep,
                                     Step enrichPoliticalContextStep,
                                     Step computeBriefsStep,
                                     Step scoreProfilesStep,
                                     Step persistResultsStep,
                                     Step buildRankingArtifactsStep) {
        return new JobBuilder(JOB_NAME, jobRepository)
            .listener(jobLinkListener)
            .start(loadCandidatesStep)
            .next(enrichPoliticalContextStep)
            .next(computeBriefsStep)
            .next(scoreProfilesStep)
            .next(persistResultsStep)
            .next(buildRankingArtifactsStep)
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
    public Step enrichPoliticalContextStep(@JobScope Tasklet enrichPoliticalContextTasklet) {
        return new StepBuilder("enrichPoliticalContextStep", jobRepository)
            .tasklet(enrichPoliticalContextTasklet, transactionManager)
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
    public Step buildRankingArtifactsStep(@JobScope Tasklet buildRankingArtifactsTasklet) {
        return new StepBuilder("buildRankingArtifactsStep", jobRepository)
            .tasklet(buildRankingArtifactsTasklet, transactionManager)
            .build();
    }

    // ── Tasklets (job-scoped, lesen Job-Parameter über @Value) ─────────────

    @Bean
    @JobScope
    public Tasklet loadCandidatesTasklet(
            @Value("#{jobParameters['city']}") String city,
            @Value("#{jobParameters['profile']}") String profile,
            @Value("#{jobParameters['recomputeExisting']}") String recomputeExisting,
            @Value("#{jobParameters['useAiPolish']}") String useAiPolish,
            @Value("#{jobParameters['limit']}") Long limit) {
        final boolean recompute = "true".equalsIgnoreCase(recomputeExisting);
        final boolean polish    = "true".equalsIgnoreCase(useAiPolish);
        final int safeLimit = (int) Math.min(Math.max(1L, limit == null ? 100L : limit), 1000L);
        return (contribution, chunkContext) -> {
            context.reset();
            context.setUseAiPolish(polish);
            // Bestehende Briefs einer Stadt: dieselbe Quelle wie die
            // interaktive Read-API (`/api/location-briefs?city=&profile=`).
            // safeLimit deckelt die obere Grenze hart, damit der Lauf
            // pro Stadt überschaubar bleibt.
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

            LOG.info("[batch][{}] city={} profile={} recompute={} useAiPolish={} candidates={} (limit={})",
                CityPrioritizationContext.currentStepName(), city, profile, recompute, polish,
                distinct.size(), safeLimit);
            for (int i = 0; i < distinct.size(); i++) contribution.incrementReadCount();
            return RepeatStatus.FINISHED;
        };
    }

    @Bean
    @JobScope
    public Tasklet enrichPoliticalContextTasklet(
            @Value("#{jobParameters['profile']}") String profile) {
        return (contribution, chunkContext) -> {
            int total = 0;
            int withRefs = 0;
            // Pro Kandidat den jüngsten Brief lesen und seine bereits
            // persistierten politischen Referenzen zählen.  Wir zählen
            // bewusst keine externen Quellen oder berechneten Aggregate
            // – nur das, was tatsächlich am Brief hängt und damit auch
            // im Decision-Card-Output sichtbar wird.
            for (String locationKey : context.getCandidateLocationKeys()) {
                var latest = repo.findFirstByLocationKeyAndProfileKeyOrderByCreatedAtDesc(locationKey, profile);
                if (latest.isEmpty()) continue;
                int n = latest.get().getPoliticalReferences().size();
                total += n;
                if (n > 0) withRefs++;
            }
            context.setPoliticalReferenceTotal(total);
            LOG.info("[batch][{}] politische Referenzen aggregiert: total={}, mit_referenz={} (von {} Kandidaten)",
                CityPrioritizationContext.currentStepName(), total, withRefs,
                context.getCandidateLocationKeys().size());
            // ReadCount entspricht der Anzahl gelesener Kandidaten,
            // WriteCount der Anzahl mit politischen Referenzen.
            for (int i = 0; i < context.getCandidateLocationKeys().size(); i++) contribution.incrementReadCount();
            contribution.incrementWriteCount(withRefs);
            return RepeatStatus.FINISHED;
        };
    }

    @Bean
    @JobScope
    public Tasklet computeBriefsTasklet(
            @Value("#{jobParameters['profile']}") String profile,
            @Value("#{jobParameters['recomputeExisting']}") String recomputeExisting) {
        final boolean recompute = "true".equalsIgnoreCase(recomputeExisting);
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
                    // Die deterministische Berechnung lebt weiterhin in der
                    // Node-Anwendung; recompute=true bedeutet aktuell
                    // „Brief wird in den Output-Set aufgenommen, auch wenn
                    // er bereits vorhanden war".  Das Verhalten ist damit
                    // idempotent – der Brief-Inhalt bleibt unverändert.
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
            // Briefs ohne passenden Profilscore aus der Pipeline entfernen,
            // statt den Lauf scheitern zu lassen – der Lauf bleibt damit
            // auch bei einzelnen unvollständigen Datensätzen belastbar
            // (kein stiller Datenverlust: betroffene Briefs werden
            // geloggt und im Skip-Counter sichtbar).
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
            // Schreibt aktuell keine zusätzlichen Felder am Brief – die
            // Briefs wurden bereits via Ingest-API persistiert.  Der Step
            // bleibt eigenständig (statt in scoreProfilesStep gemischt),
            // damit ein Folge-PR an genau dieser Stelle das fachliche
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
    public Tasklet buildRankingArtifactsTasklet(
            @Value("#{jobParameters['city']}") String city,
            @Value("#{jobParameters['profile']}") String profile,
            @Value("#{jobParameters['limit']}") Long limit) {
        final int topN = (int) Math.min(Math.max(1L, limit == null ? 10L : Math.min(limit, 50L)), 50L);
        return (contribution, chunkContext) -> {
            // Maßnahmen-Klassifikation: alles, was als „strukturell"
            // markiert ist (Kategorien beginnen mit "structural_" oder
            // enthalten "umbau"/"rebau"), zählen wir hier zu den
            // strukturellen Maßnahmen.  Alles andere zählt als
            // kurzfristig – das ist die gleiche Heuristik, die später
            // auch im Decision-Card-Output (server/priorities) angewandt
            // werden soll, damit Lauf-Artefakt und Karte konsistent
            // bleiben.
            List<RankedLocation> ranking = context.getProcessedBriefIds().stream()
                .map(repo::findById)
                .flatMap(java.util.Optional::stream)
                .map(b -> {
                    double score = b.getProfileScores().stream()
                        .filter(s -> profile.equals(s.getProfileKey()))
                        .map(PrioritizationProfileScoreEntity::getTotal)
                        .findFirst()
                        .orElse(0.0);
                    int polRefs = b.getPoliticalReferences().size();
                    int structural = 0;
                    int shortTerm = 0;
                    for (var m : b.getCandidateMeasures()) {
                        if (isStructural(m.getCategory())) structural++; else shortTerm++;
                    }
                    return new RankedLocation(b.getLocationKey(), b.getId(), score,
                        polRefs, shortTerm, structural);
                })
                .sorted(Comparator.comparingDouble((RankedLocation r) -> r.profileScore).reversed())
                .limit(topN)
                .toList();

            context.getRanking().addAll(ranking);

            // Persistierung der Lauf-Artefakte.  Restart-sicher: wir
            // löschen vorhandene Einträge derselben Execution zuerst,
            // damit ein Restart das Ranking sauber überschreibt statt
            // unique-constraint-Konflikte zu produzieren.
            Long executionId = currentJobExecutionId();
            if (executionId != null) {
                int deleted = rankingRepo.deleteByJobExecutionId(executionId);
                if (deleted > 0) {
                    LOG.info("[batch][{}] Restart-Hygiene: {} alte Ranking-Artefakte für executionId={} gelöscht",
                        CityPrioritizationContext.currentStepName(), deleted, executionId);
                }
                int rank = 1;
                for (RankedLocation r : ranking) {
                    BatchRankingArtifactEntity a = new BatchRankingArtifactEntity();
                    a.setJobExecutionId(executionId);
                    a.setJobName(JOB_NAME);
                    a.setTargetCity(city);
                    a.setTargetProfileKey(profile);
                    a.setRankPosition(rank++);
                    a.setLocationKey(r.locationKey);
                    a.setBriefId(r.briefId);
                    a.setProfileScore(r.profileScore);
                    a.setPoliticalReferenceCount(r.politicalReferenceCount);
                    a.setShortTermMeasures(r.shortTermMeasures);
                    a.setStructuralMeasures(r.structuralMeasures);
                    rankingRepo.save(a);
                }
            } else {
                LOG.warn("[batch][{}] keine executionId verfügbar – Ranking-Artefakte werden nicht persistiert",
                    CityPrioritizationContext.currentStepName());
            }

            LOG.info("[batch][{}] Top-{} ermittelt (von {} Briefs), persistiert für executionId={}",
                CityPrioritizationContext.currentStepName(), ranking.size(),
                context.getProcessedBriefIds().size(), executionId);
            contribution.incrementWriteCount(ranking.size());
            return RepeatStatus.FINISHED;
        };
    }

    /**
     * Klassifiziert eine Maßnahmen-Kategorie als „strukturell" (z. B.
     * Knotenpunkt-Umbau) oder „kurzfristig" (z. B. Markierung,
     * Beschilderung).  Die Heuristik ist bewusst defensiv: alles, was
     * mit {@code structural_} beginnt oder die Tokens
     * {@code umbau}/{@code rebau}/{@code kreuzungs} enthält, gilt als
     * strukturell.  Wir vermeiden hartcodierte Allow-Listen, damit neue
     * Kategorien aus dem Quellsystem (templates/measures.json) nicht
     * verloren gehen.
     */
    private static boolean isStructural(String category) {
        if (category == null || category.isBlank()) return false;
        String c = category.toLowerCase(java.util.Locale.ROOT);
        return c.startsWith("structural_")
            || c.contains("umbau")
            || c.contains("rebau")
            || c.contains("kreuzungs");
    }

    /** Liefert die ID der aktuellen JobExecution oder {@code null}, wenn unbekannt. */
    private static Long currentJobExecutionId() {
        var ctx = StepSynchronizationManager.getContext();
        if (ctx == null || ctx.getStepExecution() == null) return null;
        var exec = ctx.getStepExecution().getJobExecution();
        return exec == null ? null : exec.getId();
    }
}
