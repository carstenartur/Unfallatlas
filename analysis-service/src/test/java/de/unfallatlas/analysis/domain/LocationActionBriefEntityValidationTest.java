package de.unfallatlas.analysis.domain;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Validierungs-Tests für die Aggregat-Wurzel.  Stellt sicher, dass
 * Hibernate Validator Pflichtfelder, Wertebereiche und einbettete
 * Versioning-Constraints durchsetzt.
 */
class LocationActionBriefEntityValidationTest {

    private static final Validator VALIDATOR;
    static {
        try (ValidatorFactory f = Validation.buildDefaultValidatorFactory()) {
            VALIDATOR = f.getValidator();
        }
    }

    @Test
    void leeresAggregatBringtPflichtfelderZurAusgabe() {
        LocationActionBriefEntity e = new LocationActionBriefEntity();
        Set<ConstraintViolation<LocationActionBriefEntity>> v = VALIDATOR.validate(e);

        // mind. locationKey, city, title, schemaVersion, sourceFingerprint,
        // profileKey, dataQuality, politicalReadiness müssen gemeldet werden.
        assertThat(v).extracting(cv -> cv.getPropertyPath().toString())
            .contains("locationKey", "city", "title",
                      "schemaVersion", "sourceFingerprint", "profileKey",
                      "dataQuality", "politicalReadiness");
    }

    @Test
    void confidenceMussZwischen0Und1Liegen() {
        LocationActionBriefEntity e = goldenBrief();
        e.setConfidence(1.5);
        Set<ConstraintViolation<LocationActionBriefEntity>> v = VALIDATOR.validate(e);
        assertThat(v).anyMatch(cv -> cv.getPropertyPath().toString().equals("confidence"));
    }

    @Test
    void einVollstaendigerBriefIstValidierbar() {
        LocationActionBriefEntity e = goldenBrief();
        Set<ConstraintViolation<LocationActionBriefEntity>> v = VALIDATOR.validate(e);
        assertThat(v).as("Erwartet keine Verletzungen, gefunden: %s", v).isEmpty();
    }

    private LocationActionBriefEntity goldenBrief() {
        LocationActionBriefEntity e = new LocationActionBriefEntity();
        e.setLocationKey("hannover::testknoten");
        e.setCity("Hannover");
        e.setTitle("Testknoten");
        e.setSchemaVersion("locationActionBrief.v1");
        e.setSourceFingerprint("0123456789abcdef");
        e.setProfileKey("bicycle_safety_priority");
        e.setConfidence(0.6);
        e.setDataQuality(QualityBand.MEDIUM);
        e.setPoliticalReadiness(QualityBand.MEDIUM);
        e.setVersioning(new VersioningInfo(
            "conflictPatterns.v1", "scoring.v1", "profiles.v1", Instant.now()));
        return e;
    }
}
