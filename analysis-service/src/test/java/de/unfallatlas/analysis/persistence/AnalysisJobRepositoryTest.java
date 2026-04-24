package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.domain.AnalysisJobEntity;
import de.unfallatlas.analysis.domain.AnalysisJobEntity.Status;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.domain.PageRequest;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Smoke-Test für das Job-Repository (Vorbereitung für spätere Batch-/Queue-
 * Verarbeitung).  Verifiziert nur den Persistenz-Pfad (Anlegen, Filter
 * nach Status, Zähler) – keine Worker-Logik, die kommt im Folge-PR.
 *
 * <p>Verwendet bewusst {@code @SpringBootTest} statt {@code @DataJpaTest},
 * weil Spring Boot 4 die schmalen Test-Slices reorganisiert hat.</p>
 */
@SpringBootTest
@Transactional
class AnalysisJobRepositoryTest {

    @Autowired
    private AnalysisJobRepository jobs;

    @BeforeEach
    void clean() {
        jobs.deleteAll();
    }

    @Test
    void persistAndQueryByStatus() {
        AnalysisJobEntity j1 = new AnalysisJobEntity();
        j1.setJobType("city.recompute");
        j1.setStatus(Status.PENDING);
        j1.setTargetCity("Hannover");
        j1.setTargetProfileKey("low_hanging_fruit");
        j1.setAttempts(0);
        jobs.saveAndFlush(j1);

        AnalysisJobEntity j2 = new AnalysisJobEntity();
        j2.setJobType("city.topN.refresh");
        j2.setStatus(Status.RUNNING);
        j2.setAttempts(1);
        jobs.saveAndFlush(j2);

        AnalysisJobEntity j3 = new AnalysisJobEntity();
        j3.setJobType("city.recompute");
        j3.setStatus(Status.PENDING);
        j3.setTargetCity("Bonn");
        j3.setAttempts(0);
        jobs.saveAndFlush(j3);

        assertThat(jobs.countByStatus(Status.PENDING)).isEqualTo(2);
        assertThat(jobs.countByStatus(Status.RUNNING)).isEqualTo(1);
        assertThat(jobs.countByStatus(Status.SUCCEEDED)).isZero();

        List<AnalysisJobEntity> pending = jobs.findByStatusOrderByCreatedAtAsc(
            Status.PENDING, PageRequest.of(0, 10));
        assertThat(pending).hasSize(2);
        // älteste zuerst → j1 vor j3
        assertThat(pending.get(0).getTargetCity()).isEqualTo("Hannover");
        assertThat(pending.get(1).getTargetCity()).isEqualTo("Bonn");

        List<AnalysisJobEntity> recompute = jobs.findByJobTypeOrderByCreatedAtDesc(
            "city.recompute", PageRequest.of(0, 10));
        assertThat(recompute).extracting(AnalysisJobEntity::getTargetCity)
            .containsExactly("Bonn", "Hannover");
    }

    @Test
    void timestampsAreManaged() {
        AnalysisJobEntity j = new AnalysisJobEntity();
        j.setJobType("search.reindex");
        j.setStatus(Status.PENDING);
        j.setAttempts(0);
        AnalysisJobEntity saved = jobs.saveAndFlush(j);
        assertThat(saved.getCreatedAt()).isNotNull();
        assertThat(saved.getUpdatedAt()).isNotNull();
    }
}
