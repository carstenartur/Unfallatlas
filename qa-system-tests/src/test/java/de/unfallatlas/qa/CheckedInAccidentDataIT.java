package de.unfallatlas.qa;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * JUnit-owned release contract for the actual checked-in accident publication.
 *
 * The Node audit executes the browser-owned extraction/filter helpers and then
 * binds the complete aggregate publication: reviewed official year, CSV ↔
 * GeoJSON row parity, hashes, city/year counts and quantitative user scenarios.
 */
class CheckedInAccidentDataIT {

    private static final Duration TIMEOUT = Duration.ofMinutes(12);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path REPOSITORY_ROOT = Path.of(
            System.getProperty("unfallatlas.repositoryRoot", ".."))
            .toAbsolutePath()
            .normalize();
    private static final Path OUTPUT_DIRECTORY = Path.of(
            System.getProperty("unfallatlas.qaOutputDir", "target/testcontainers-logs"))
            .toAbsolutePath()
            .normalize();

    @Test
    void checkedInPublicationMatchesTheReviewedOfficialRelease() throws Exception {
        Files.createDirectories(OUTPUT_DIRECTORY);
        Path report = OUTPUT_DIRECTORY.resolve("checked-in-accident-publication.json");
        Process process = new ProcessBuilder(List.of(
                "node",
                "--max-old-space-size=4096",
                REPOSITORY_ROOT.resolve("scripts/validate-accident-publication.js").toString(),
                "--root",
                REPOSITORY_ROOT.toString(),
                "--report",
                report.toString()))
                .directory(REPOSITORY_ROOT.toFile())
                .redirectErrorStream(true)
                .start();

        boolean finished = process.waitFor(TIMEOUT.toSeconds(), TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new AssertionError("Accident publication audit timed out after " + TIMEOUT);
        }
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, process.exitValue(), output);
        assertTrue(Files.isRegularFile(report), "Audit did not produce its evidence report\n" + output);

        JsonNode evidence = readJson(report);
        JsonNode policy = readJson(REPOSITORY_ROOT.resolve("config/accident-data-policy.json"));
        JsonNode release = readJson(REPOSITORY_ROOT.resolve("data/accident-data-release.json"));

        assertEquals("unfallwerkbank-accident-publication-audit/v1",
                evidence.path("contract").asText(), evidence.toPrettyString());
        assertTrue(evidence.path("passed").asBoolean(), evidence.toPrettyString());
        assertEquals(policy.path("expectedLatestYear").asInt(),
                evidence.path("latestYear").asInt(), evidence.toPrettyString());
        assertTrue(evidence.path("checkedCities").asInt()
                >= policy.path("minimumConfiguredCities").asInt(), evidence.toPrettyString());
        assertEquals(evidence.path("checkedCities").asInt() * 2,
                evidence.path("artifactCount").asInt(), evidence.toPrettyString());
        assertEquals(3, evidence.path("canonicalScenarios").size(), evidence.toPrettyString());

        assertEquals("unfallwerkbank-accident-data-release/v1",
                release.path("contract").asText(), release.toPrettyString());
        assertEquals(evidence.path("releaseFingerprint").asText(),
                release.path("fingerprint").asText(), release.toPrettyString());
        assertEquals(evidence.path("latestYear").asInt(),
                release.path("latestYear").asInt(), release.toPrettyString());

        int firstYear = policy.path("firstYear").asInt();
        int latestYear = policy.path("expectedLatestYear").asInt();
        String readme = Files.readString(REPOSITORY_ROOT.resolve("README.md"), StandardCharsets.UTF_8);
        assertTrue(readme.contains(firstYear + "–" + latestYear),
                "README data-year claim is stale; expected " + firstYear + "–" + latestYear);
        assertTrue(readme.contains("Pull Request"),
                "README must explain that generated data is reviewed through a pull request");
    }

    private static JsonNode readJson(Path file) throws IOException {
        return JSON.readTree(Files.readString(file, StandardCharsets.UTF_8));
    }
}
