package de.unfallatlas.analysis.fingerprint;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

class SourceFingerprintCalculatorTest {

    private final SourceFingerprintCalculator calc = new SourceFingerprintCalculator();

    @Test
    void selberInhaltErgibtSelbenHash() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("locationKey", "hannover::x");
        a.put("scoring", 0.6);
        a.put("patterns", java.util.List.of("a", "b"));

        Map<String, Object> b = new LinkedHashMap<>();
        b.put("locationKey", "hannover::x");
        b.put("scoring", 0.6);
        b.put("patterns", java.util.List.of("a", "b"));

        assertThat(calc.fingerprintOf(a)).isEqualTo(calc.fingerprintOf(b));
    }

    @Test
    void schluesselReihenfolgeBeeinflusstHashNicht() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("a", 1); a.put("b", 2); a.put("c", 3);

        Map<String, Object> b = new TreeMap<>();
        b.put("c", 3); b.put("a", 1); b.put("b", 2);

        assertThat(calc.fingerprintOf(a)).isEqualTo(calc.fingerprintOf(b));
    }

    @Test
    void unterschiedlicheInhalteErgebenUnterschiedlicheHashes() {
        assertThat(calc.fingerprintOf(Map.of("k", "v1")))
            .isNotEqualTo(calc.fingerprintOf(Map.of("k", "v2")));
    }

    @Test
    void nullErgibtNull() {
        assertThat(calc.fingerprintOf(null)).isNull();
        assertThat(calc.fingerprintOfString(null)).isNull();
    }

    @Test
    void laengeEntsprichtSha256Hex() {
        assertThat(calc.fingerprintOfString("hello"))
            .hasSize(64)
            .matches("^[0-9a-f]+$");
    }
}
