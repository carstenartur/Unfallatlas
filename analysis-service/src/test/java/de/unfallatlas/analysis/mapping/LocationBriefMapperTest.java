package de.unfallatlas.analysis.mapping;

import de.unfallatlas.analysis.api.dto.LocationBriefIngestDto;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import de.unfallatlas.analysis.domain.QualityBand;
import de.unfallatlas.analysis.fingerprint.SourceFingerprintCalculator;
import de.unfallatlas.analysis.support.LocationBriefFixtures;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LocationBriefMapperTest {

    private final LocationBriefMapper mapper =
        new LocationBriefMapper(new SourceFingerprintCalculator());

    @Test
    void mapptKernfelderUndSubAggregate() {
        LocationActionBriefEntity e = mapper.toEntity(LocationBriefFixtures.bicycleTurningConflictBrief());

        assertThat(e.getLocationKey()).startsWith("hannover::");
        assertThat(e.getCity()).isEqualTo("Hannover");
        assertThat(e.getProfileKey()).isEqualTo("bicycle_safety_priority");
        assertThat(e.getSchemaVersion()).isEqualTo("locationActionBrief.v1");
        assertThat(e.getSourceFingerprint()).hasSize(64).matches("^[0-9a-f]+$");
        assertThat(e.getDataQuality()).isEqualTo(QualityBand.MEDIUM);
        assertThat(e.getPoliticalReadiness()).isEqualTo(QualityBand.HIGH);
        assertThat(e.getConfidence()).isBetween(0.0, 1.0);
        assertThat(e.isAiUsed()).isFalse();
        assertThat(e.getAiMetadata()).isNull();

        // Versionierung
        assertThat(e.getVersioning().getRulesVersion()).isEqualTo("conflictPatterns.v1");
        assertThat(e.getVersioning().getScoringVersion()).isEqualTo("scoring.v1");
        assertThat(e.getVersioning().getProfileVersion()).isEqualTo("profiles.v1");
        assertThat(e.getVersioning().getGeneratedAt()).isNotNull();

        // Sub-Aggregate
        assertThat(e.getConflictPatterns()).hasSize(2);
        assertThat(e.getConflictPatterns().get(0).getAliasId())
            .isEqualTo("bicycle_turning_conflict");
        assertThat(e.getCandidateMeasures()).hasSize(2);
        assertThat(e.getCandidateMeasures().get(0).getPosition()).isZero();
        assertThat(e.getCandidateMeasures().get(1).getPosition()).isEqualTo(1);
        assertThat(e.getProfileScores()).hasSize(5);
        assertThat(e.getPoliticalReferences()).hasSize(1);
        assertThat(e.getPoliticalReferences().get(0).getTopic()).isEqualTo("radverkehr");
    }

    @Test
    void aiMetadatenWerdenNurUebernommenWennGeneratedWithAi() {
        LocationActionBriefEntity e = mapper.toEntity(LocationBriefFixtures.withAiPolish());
        assertThat(e.isAiUsed()).isTrue();
        assertThat(e.getAiMetadata()).isNotNull();
        assertThat(e.getAiMetadata().getAiModel()).isEqualTo("gemini-2.0-flash");
        assertThat(e.getAiMetadata().getAiPromptVersion()).isEqualTo("exportAssessmentPrompt.v1");
    }

    @Test
    void fingerprintIstReproduzierbarFuerGleichesIngest() {
        LocationBriefIngestDto a = LocationBriefFixtures.bicycleTurningConflictBrief();
        LocationBriefIngestDto b = LocationBriefFixtures.bicycleTurningConflictBrief();

        String fpA = mapper.toEntity(a).getSourceFingerprint();
        String fpB = mapper.toEntity(b).getSourceFingerprint();
        assertThat(fpA).isEqualTo(fpB);
    }

    @Test
    void aenderungAmInputErzeugtAnderenFingerprint() {
        LocationBriefIngestDto a = LocationBriefFixtures.bicycleTurningConflictBrief();
        LocationBriefIngestDto b = LocationBriefFixtures.bicycleTurningConflictBrief();
        b.title = "Anderer Titel";

        String fpA = mapper.toEntity(a).getSourceFingerprint();
        String fpB = mapper.toEntity(b).getSourceFingerprint();
        assertThat(fpA).isNotEqualTo(fpB);
    }

    @Test
    void aiMetadatenUndZeitstempelBeeinflussenFingerprintNicht() {
        LocationBriefIngestDto a = LocationBriefFixtures.bicycleTurningConflictBrief();
        LocationBriefIngestDto b = LocationBriefFixtures.withAiPolish(); // gleiche Inhalte + KI

        String fpA = mapper.toEntity(a).getSourceFingerprint();
        String fpB = mapper.toEntity(b).getSourceFingerprint();
        assertThat(fpA).isEqualTo(fpB);
    }
}
