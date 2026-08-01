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
 * JUnit-owned release contract for the actual checked-in accident data.
 *
 * The test intentionally executes the browser-owned JavaScript helpers through
 * the repository validator instead of reimplementing their semantics in Java.
 * This makes the contract fail when either the generated data schema or the web
 * application's extraction/filter semantics drift.
 */
class CheckedInAccidentDataIT {

    private static final Duration TIMEOUT = Duration.ofMinutes(8);
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
    void checkedInDataLoadsThroughTheRealBrowserRuntimeContract() throws Exception {
        Files.createDirectories(OUTPUT_DIRECTORY);
        Path report = OUTPUT_DIRECTORY.resolve("checked-in-accident-runtime-contract.json");
        Process process = new ProcessBuilder(List.of(
                "node",
                "--max-old-space-size=4096",
                REPOSITORY_ROOT.resolve("scripts/validate-accident-runtime-contract.js").toString(),
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
            throw new AssertionError("Accident runtime contract timed out after " + TIMEOUT);
        }
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, process.exitValue(), output);
        assertTrue(Files.isRegularFile(report), "Validator did not produce its evidence report\n" + output);

        JsonNode evidence = readJson(report);
        assertEquals("unfallwerkbank-checked-in-accident-runtime/v1",
                evidence.path("contract").asText(), evidence.toPrettyString());
        assertTrue(evidence.path("checkedCities").asInt() > 0, evidence.toPrettyString());
        assertTrue(evidence.path("latestYear").asInt() >= 2024, evidence.toPrettyString());
        assertTrue(evidence.path("canonicalScenarios").isArray(), evidence.toPrettyString());
        assertEquals(3, evidence.path("canonicalScenarios").size(), evidence.toPrettyString());
        for (JsonNode scenario : evidence.path("canonicalScenarios")) {
            assertTrue(scenario.path("matches").asInt() > 0, scenario.toPrettyString());
        }

        String readme = Files.readString(REPOSITORY_ROOT.resolve("README.md"), StandardCharsets.UTF_8);
        int latestYear = evidence.path("latestYear").asInt();
        assertTrue(readme.contains("2016–" + latestYear),
                "README data-year claim is stale; expected 2016–" + latestYear);
    }

    private static JsonNode readJson(Path file) throws IOException {
        return JSON.readTree(Files.readString(file, StandardCharsets.UTF_8));
    }
}
