package de.unfallatlas.analysis.fingerprint;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * Berechnet einen deterministischen Fingerprint über ein beliebiges
 * JSON-serialisierbares Objekt.  Die Serialisierung ist Schlüssel-
 * sortiert, damit die Reihenfolge der Map-Einträge das Ergebnis nicht
 * beeinflusst.
 *
 * <p>Wird verwendet, um Briefs reproduzierbar zu identifizieren und
 * Idempotenz beim Persistieren zu ermöglichen
 * ({@code locationKey + profileKey + sourceFingerprint}).</p>
 */
@Component
public class SourceFingerprintCalculator {

    private static final String ALGORITHM = "SHA-256";
    private final ObjectMapper canonicalMapper;

    public SourceFingerprintCalculator() {
        this.canonicalMapper = new ObjectMapper();
        this.canonicalMapper.configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
    }

    /**
     * Hex-codierter SHA-256-Hash über die kanonische JSON-Repräsentation
     * von {@code value}.  Gibt {@code null} zurück, wenn {@code value}
     * {@code null} ist.
     */
    public String fingerprintOf(Object value) {
        if (value == null) return null;
        try {
            byte[] json = canonicalMapper.writeValueAsBytes(value);
            MessageDigest md = MessageDigest.getInstance(ALGORITHM);
            byte[] digest = md.digest(json);
            return HexFormat.of().formatHex(digest);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Wert kann nicht JSON-serialisiert werden", e);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 ist von der JRE verpflichtend bereitgestellt.
            throw new IllegalStateException("SHA-256 nicht verfügbar", e);
        }
    }

    /** Hex-codierter SHA-256-Hash über einen UTF-8-String. */
    public String fingerprintOfString(String value) {
        if (value == null) return null;
        try {
            MessageDigest md = MessageDigest.getInstance(ALGORITHM);
            return HexFormat.of().formatHex(md.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 nicht verfügbar", e);
        }
    }
}
