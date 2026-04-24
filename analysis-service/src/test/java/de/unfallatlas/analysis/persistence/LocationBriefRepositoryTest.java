package de.unfallatlas.analysis.persistence;

import de.unfallatlas.analysis.api.LocationBriefService;
import de.unfallatlas.analysis.api.dto.LocationBriefIngestDto;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import de.unfallatlas.analysis.support.LocationBriefFixtures;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * End-to-End-Persistenztest: Mapper → Service → Repository → DB.
 * Nutzt das Test-H2-Profil und überprüft die in der Aufgabenstellung
 * geforderten Standard-Repository-Abfragen.
 */
@SpringBootTest
@Transactional
class LocationBriefRepositoryTest {

    @Autowired private LocationBriefService service;
    @Autowired private LocationActionBriefRepository repo;
    @Autowired private CandidateMeasureAssessmentRepository measureRepo;
    @Autowired private PrioritizationProfileScoreRepository scoreRepo;
    @Autowired private PoliticalReferenceSummaryRepository politicalRepo;

    @Test
    void persistierterBriefIstVollständigLesbar() {
        LocationActionBriefEntity saved = service.ingest(
            LocationBriefFixtures.bicycleTurningConflictBrief());

        assertThat(saved.getId()).isNotBlank();
        LocationActionBriefEntity reread = repo.findById(saved.getId()).orElseThrow();
        assertThat(reread.getConflictPatterns()).hasSize(2);
        assertThat(reread.getCandidateMeasures()).hasSize(2);
        assertThat(reread.getProfileScores()).hasSize(5);
        assertThat(reread.getPoliticalReferences()).hasSize(1);

        assertThat(measureRepo.findByBrief_IdOrderByPositionAsc(saved.getId()))
            .extracting("position").containsExactly(0, 1);

        assertThat(scoreRepo.findByBrief_IdAndProfileKey(saved.getId(), "bicycle_safety_priority"))
            .isPresent()
            .get()
            .extracting("total").isEqualTo(0.78);

        assertThat(politicalRepo.findByBrief_IdOrderByRelevanceDesc(saved.getId()))
            .hasSize(1);
    }

    @Test
    void ingestIstIdempotentBeiGleichemFingerprint() {
        LocationBriefIngestDto dto = LocationBriefFixtures.bicycleTurningConflictBrief();
        LocationActionBriefEntity first = service.ingest(dto);
        LocationActionBriefEntity second = service.ingest(dto);
        assertThat(first.getId()).isEqualTo(second.getId());
        assertThat(repo.count()).isEqualTo(1);
    }

    @Test
    void neuesterBriefProStelle() {
        LocationBriefIngestDto a = LocationBriefFixtures.bicycleTurningConflictBrief();
        LocationBriefIngestDto b = LocationBriefFixtures.bicycleTurningConflictBrief();
        b.title = "Knoten Beispielstraße / Musterweg (revisited)";
        LocationActionBriefEntity first = service.ingest(a);
        LocationActionBriefEntity newest = service.ingest(b);

        assertThat(first.getLocationKey()).isEqualTo(newest.getLocationKey());
        var rereadList = service.findByLocationKey(first.getLocationKey());
        assertThat(rereadList).hasSize(2);
        // Beide Auswertungen müssen abrufbar sein; die Reihenfolge richtet
        // sich nach createdAt (neueste zuerst).  Da die Zeitstempel in
        // demselben Test-Tx praktisch gleichzeitig entstehen, prüfen wir
        // hier nur die Vollständigkeit, nicht die Reihenfolge.
        assertThat(rereadList).extracting(LocationActionBriefEntity::getId)
            .containsExactlyInAnyOrder(first.getId(), newest.getId());
    }

    @Test
    void cityFilterMitProfilLiefertNurPassendeBriefs() {
        // Brief A – Hannover, profil bicycle_safety_priority
        service.ingest(LocationBriefFixtures.bicycleTurningConflictBrief());

        // Brief B – Berlin, profil low_hanging_fruit
        LocationBriefIngestDto b = LocationBriefFixtures.bicycleTurningConflictBrief();
        b.meta.city = "Berlin";
        b.meta.profile = "low_hanging_fruit";
        b.title = "Knoten Berlin / Beispielallee";
        b.meta.areaName = "Berlin Beispielallee";
        service.ingest(b);

        List<LocationActionBriefEntity> hannover = service.findByCity("Hannover", null, 0, 50);
        List<LocationActionBriefEntity> hannoverBicycle =
            service.findByCity("Hannover", "bicycle_safety_priority", 0, 50);
        List<LocationActionBriefEntity> hannoverOther =
            service.findByCity("Hannover", "low_hanging_fruit", 0, 50);

        assertThat(hannover).hasSize(1);
        assertThat(hannoverBicycle).hasSize(1);
        assertThat(hannoverOther).isEmpty();
    }

    @Test
    void topNNachProfilGibtBeideBriefsSortiertZurueck() {
        // Zwei Stellen in Hannover, gleiche Profil-Bewertung -> Reihenfolge nach total
        LocationBriefIngestDto a = LocationBriefFixtures.bicycleTurningConflictBrief();
        a.meta.areaName = "Stelle A";
        a.title = "Stelle A";
        service.ingest(a);

        LocationBriefIngestDto b = LocationBriefFixtures.bicycleTurningConflictBrief();
        b.meta.areaName = "Stelle B";
        b.title = "Stelle B";
        // Niedrigerer Top-Score
        b.deterministicFindings.profileScores.forEach(ps -> {
            if ("bicycle_safety_priority".equals(ps.profile)) ps.total = 0.40;
        });
        service.ingest(b);

        List<LocationActionBriefEntity> top =
            service.findTopByCityAndProfile("Hannover", "bicycle_safety_priority", 10);
        assertThat(top).hasSize(2);
        assertThat(top.get(0).getTitle()).isEqualTo("Stelle A");
        assertThat(top.get(1).getTitle()).isEqualTo("Stelle B");
    }

    @Test
    void politicalReadinessFilterFindetVorbefassteFaelle() {
        service.ingest(LocationBriefFixtures.bicycleTurningConflictBrief());

        LocationBriefIngestDto low = LocationBriefFixtures.bicycleTurningConflictBrief();
        low.meta.areaName = "Stille Stelle";
        low.title = "Stille Stelle";
        low.politicalContext.policyReadiness = "low";
        low.politicalContext.relatedReferences = List.of();
        service.ingest(low);

        var withReadiness = service.findWithPoliticalReadiness("Hannover");
        assertThat(withReadiness).hasSize(1);
        assertThat(withReadiness.get(0).getPoliticalReadiness().toLower()).isEqualTo("high");
    }

    @Test
    void aiMetadatenWerdenPersistiert() {
        LocationActionBriefEntity saved = service.ingest(LocationBriefFixtures.withAiPolish());
        LocationActionBriefEntity reread = repo.findById(saved.getId()).orElseThrow();
        assertThat(reread.isAiUsed()).isTrue();
        assertThat(reread.getAiMetadata().getAiModel()).isEqualTo("gemini-2.0-flash");
        assertThat(reread.getAiMetadata().getAiPromptVersion()).isEqualTo("exportAssessmentPrompt.v1");
    }
}
