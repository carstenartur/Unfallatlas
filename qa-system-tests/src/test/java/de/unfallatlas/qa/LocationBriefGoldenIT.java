package de.unfallatlas.qa;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.ImageFromDockerfile;
import org.testcontainers.postgresql.PostgreSQLContainer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

@EnabledIfSystemProperty(named = "unfallatlas.locationBriefGolden", matches = "true")
class LocationBriefGoldenIT {

    private static final int SERVICE_PORT = 8081;
    private static final String DATABASE_NAME = "unfallatlas";
    private static final String DATABASE_USER = "unfallatlas";
    private static final String DATABASE_PASSWORD = "golden-test-only";
    private static final Path REPOSITORY_ROOT = Path.of(
            System.getProperty("unfallatlas.repositoryRoot", ".."))
            .toAbsolutePath()
            .normalize();
    private static final Path INDEX_FILE = Path.of(System.getProperty(
            "unfallatlas.locationBriefGoldenIndex",
            REPOSITORY_ROOT.resolve(".build/location-brief-golden/index.json").toString()))
            .toAbsolutePath()
            .normalize();
    private static final Path ARTIFACT_FILE = Path.of(System.getProperty(
            "unfallatlas.locationBriefGoldenArtifact",
            REPOSITORY_ROOT.resolve("out/qa/location-brief-golden-testcontainers.json").toString()))
            .toAbsolutePath()
            .normalize();
    private static final Path LOG_DIRECTORY = Path.of(
            System.getProperty("unfallatlas.qaOutputDir", "target/testcontainers-logs"))
            .toAbsolutePath()
            .normalize();

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .build();
    private static final Network NETWORK = Network.newNetwork();
    private static final PostgreSQLContainer DATABASE = new PostgreSQLContainer("postgres:17-alpine")
            .withDatabaseName(DATABASE_NAME)
            .withUsername(DATABASE_USER)
            .withPassword(DATABASE_PASSWORD)
            .withNetwork(NETWORK)
            .withNetworkAliases("golden-db");
    private static final ImageFromDockerfile SERVICE_IMAGE = new ImageFromDockerfile(
            "unfallatlas-analysis-service-golden-test:local", false)
            .withDockerfile(REPOSITORY_ROOT.resolve("analysis-service/Dockerfile"));
    private static final GenericContainer<?> SERVICE = new GenericContainer<>(SERVICE_IMAGE)
            .withNetwork(NETWORK)
            .withEnv(Map.of(
                    "SPRING_PROFILES_ACTIVE", "prod",
                    "ANALYSIS_DB_URL", "jdbc:postgresql://golden-db:5432/" + DATABASE_NAME,
                    "ANALYSIS_DB_USER", DATABASE_USER,
                    "ANALYSIS_DB_PASSWORD", DATABASE_PASSWORD,
                    "PORT", Integer.toString(SERVICE_PORT)))
            .withExposedPorts(SERVICE_PORT)
            .waitingFor(Wait.forHttp("/actuator/health")
                    .forPort(SERVICE_PORT)
                    .forStatusCode(200))
            .withStartupTimeout(Duration.ofMinutes(8));

    @BeforeAll
    static void startContainers() {
        assertTrue(Files.isRegularFile(INDEX_FILE), "Missing generated golden-case index: " + INDEX_FILE);
        DATABASE.start();
        try {
            SERVICE.start();
        } catch (RuntimeException error) {
            DATABASE.stop();
            throw error;
        }
    }

    @Test
    void persistsAndRanksProductDerivedBonnAndHannoverBriefs() throws Exception {
        JsonNode index = JSON.readTree(INDEX_FILE.toFile());
        assertEquals(1, index.path("schemaVersion").asInt());
        String profile = index.path("profile").asText();
        assertFalse(profile.isBlank());
        assertTrue(index.path("cities").isArray());
        assertTrue(index.path("cities").size() >= 2);

        ObjectNode artifact = JSON.createObjectNode();
        artifact.put("profile", profile);
        artifact.put("generatedAt", Instant.now().toString());
        ObjectNode roles = artifact.putObject("pipelineRoles");
        roles.put("nodeComputesLocationBriefs", true);
        roles.put("analysisServiceComputeAndStoreIsStub", true);
        roles.put("analysisServicePersistsAndRanks", true);
        ArrayNode artifactCities = artifact.putArray("cities");

        for (JsonNode cityDefinition : index.path("cities")) {
            String city = cityDefinition.path("city").asText();
            assertFalse(city.isBlank());
            JsonNode cases = cityDefinition.path("cases");
            assertTrue(cases.isArray());
            assertTrue(cases.size() >= 2);

            boolean first = true;
            Map<String, JsonNode> caseByLocation = new HashMap<>();
            for (JsonNode goldenCase : cases) {
                String locationKey = goldenCase.path("locationKey").asText();
                Path payloadFile = INDEX_FILE.getParent()
                        .resolve(goldenCase.path("payload").asText())
                        .normalize();
                assertTrue(payloadFile.startsWith(INDEX_FILE.getParent()));
                JsonNode payload = JSON.readTree(payloadFile.toFile());
                String endpoint = first
                        ? "/api/location-briefs/compute-and-store"
                        : "/api/location-briefs";
                HttpResponse<String> response = post(endpoint, payload);
                assertEquals(201, response.statusCode(), response.body());
                JsonNode stored = JSON.readTree(response.body());
                assertEquals(locationKey, stored.path("locationKey").asText());
                assertEquals(profile, stored.path("profileKey").asText());
                if (first) {
                    assertEquals(
                            payload.path("problemSummary").asText(),
                            stored.path("deterministicSummary").asText());
                }
                first = false;
                caseByLocation.put(locationKey, goldenCase);
            }

            ObjectNode startRequest = JSON.createObjectNode();
            startRequest.put("city", city);
            startRequest.put("profile", profile);
            startRequest.put("recomputeExisting", false);
            startRequest.put("limit", 20);
            startRequest.put("runLabel", "golden-case-" + city.toLowerCase());
            HttpResponse<String> startResponse = post(
                    "/api/batch/jobs/city-prioritization",
                    startRequest);
            assertEquals(202, startResponse.statusCode(), startResponse.body());
            long executionId = JSON.readTree(startResponse.body()).path("executionId").asLong();
            assertTrue(executionId > 0);
            waitForCompleted(executionId);

            HttpResponse<String> rankingResponse = get(
                    "/api/batch/jobs/" + executionId + "/ranking");
            assertEquals(200, rankingResponse.statusCode(), rankingResponse.body());
            JsonNode ranking = JSON.readTree(rankingResponse.body());
            Map<String, Integer> rankByLocation = new HashMap<>();
            for (JsonNode item : ranking.path("items")) {
                rankByLocation.put(
                        item.path("locationKey").asText(),
                        item.path("rankPosition").asInt());
            }

            int greatestPositiveRank = 0;
            ObjectNode artifactCity = artifactCities.addObject();
            artifactCity.put("city", city);
            artifactCity.put("executionId", executionId);
            ArrayNode artifactCases = artifactCity.putArray("cases");
            for (Map.Entry<String, JsonNode> entry : caseByLocation.entrySet()) {
                String locationKey = entry.getKey();
                JsonNode goldenCase = entry.getValue();
                Integer rank = rankByLocation.get(locationKey);
                assertNotNull(rank, "Missing rank for " + locationKey);
                if ("positive".equals(goldenCase.path("kind").asText())) {
                    int expectedTopN = goldenCase.path("expectedTopN").asInt();
                    assertTrue(expectedTopN > 0);
                    assertTrue(rank <= expectedTopN,
                            locationKey + " expected top " + expectedTopN + " but was " + rank);
                    greatestPositiveRank = Math.max(greatestPositiveRank, rank);
                }
                ObjectNode artifactCase = artifactCases.addObject();
                artifactCase.put("caseId", goldenCase.path("caseId").asText());
                artifactCase.put("kind", goldenCase.path("kind").asText());
                artifactCase.put("rank", rank);
                artifactCase.put("score", goldenCase.path("score").asDouble());
                artifactCase.set("patterns", goldenCase.path("patterns"));
                artifactCase.set("measures", goldenCase.path("measures"));
                artifactCase.put("passed", true);
                artifactCase.putArray("notes");
            }
            assertTrue(greatestPositiveRank > 0);
            for (Map.Entry<String, JsonNode> entry : caseByLocation.entrySet()) {
                if ("negative".equals(entry.getValue().path("kind").asText())) {
                    assertTrue(rankByLocation.get(entry.getKey()) > greatestPositiveRank,
                            entry.getKey() + " must rank below all positive cases");
                }
            }
        }

        Files.createDirectories(ARTIFACT_FILE.getParent());
        JSON.writerWithDefaultPrettyPrinter().writeValue(ARTIFACT_FILE.toFile(), artifact);
    }

    private static void waitForCompleted(long executionId) throws Exception {
        for (int attempt = 0; attempt < 80; attempt++) {
            HttpResponse<String> response = get("/api/batch/jobs/" + executionId);
            assertEquals(200, response.statusCode(), response.body());
            String status = JSON.readTree(response.body()).path("status").asText();
            if ("COMPLETED".equals(status)) return;
            if ("FAILED".equals(status) || "STOPPED".equals(status)) {
                throw new AssertionError("Batch job " + executionId + " ended with " + status);
            }
            Thread.sleep(500);
        }
        throw new AssertionError("Batch job " + executionId + " did not finish in time");
    }

    private static HttpResponse<String> post(String path, JsonNode body)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(serviceBaseUrl() + path))
                .timeout(Duration.ofMinutes(2))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body), StandardCharsets.UTF_8))
                .build();
        return HTTP.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static HttpResponse<String> get(String path) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(serviceBaseUrl() + path))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();
        return HTTP.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String serviceBaseUrl() {
        return "http://" + SERVICE.getHost() + ":" + SERVICE.getMappedPort(SERVICE_PORT);
    }

    @AfterAll
    static void stopContainersAndPersistLogs() throws IOException {
        Files.createDirectories(LOG_DIRECTORY);
        Files.writeString(
                LOG_DIRECTORY.resolve("location-brief-golden-analysis-service.log"),
                SERVICE.getLogs(),
                StandardCharsets.UTF_8);
        Files.writeString(
                LOG_DIRECTORY.resolve("location-brief-golden-postgresql.log"),
                DATABASE.getLogs(),
                StandardCharsets.UTF_8);
        try {
            SERVICE.stop();
        } finally {
            try {
                DATABASE.stop();
            } finally {
                NETWORK.close();
            }
        }
    }
}
