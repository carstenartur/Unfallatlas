package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.domain.AnalysisJobEntity;
import de.unfallatlas.analysis.domain.AnalysisJobEntity.Status;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

/**
 * Spring-Data-Repository für persistierte Analyse-Jobs.
 *
 * <p>In dieser Iteration bewusst minimal gehalten: Lesen, Anlegen, Updaten.
 * Das eigentliche Worker-Polling, Locking und der verteilte Betrieb kommen
 * im Folge-PR.  Die Schnittstelle ist so geschnitten, dass diese
 * Erweiterung ohne Bruch erfolgen kann.</p>
 */
public interface AnalysisJobRepository extends JpaRepository<AnalysisJobEntity, Long> {

    /** Alle Jobs eines bestimmten Status (älteste zuerst, FIFO). */
    List<AnalysisJobEntity> findByStatusOrderByCreatedAtAsc(Status status, Pageable pageable);

    /** Anzahl Jobs pro Status (für einfache Status-/Health-Anzeigen). */
    long countByStatus(Status status);

    /** Jüngste Jobs eines Typs (für Doku/Debug). */
    List<AnalysisJobEntity> findByJobTypeOrderByCreatedAtDesc(String jobType, Pageable pageable);

    /**
     * Verknüpfung zwischen Spring-Batch-{@code JobExecution} und fachlichem
     * Analyse-Job.  Wird vom {@code AnalysisJobLinkListener} verwendet, um
     * den passenden Datensatz beim Lauf-Ende zu aktualisieren.
     */
    Optional<AnalysisJobEntity> findFirstByJobExecutionIdOrderByCreatedAtDesc(Long jobExecutionId);
}
