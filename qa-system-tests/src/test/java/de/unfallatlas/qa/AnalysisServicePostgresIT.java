package de.unfallatlas.qa;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.ImageFromDockerfile;
import org.testcontainers.postgresql.PostgreSQLContainer;

class AnalysisServicePostgresIT {

    private static final int SERVICE_PORT = 8081;
    private static final String DATABASE_NAME = "unfallatlas";
    private static final String DATABASE_USER = "unfallatlas";
    private static final String DATABASE_PASSWORD = "integration-test-only";
    private static final Path REPOSITORY_ROOT = Path.of(
            System.getProperty("unfallatlas.repositoryRoot", ".."))
            .toAbsolutePath()
            .normalize();
    private static final Path LOG_DIRECTORY = Path.of(
            System.getProperty("unfallatlas.qaOutputDir", "target/testcontainers-logs"))
            .toAbsolutePath()
            .normalize();

    private static final Network NETWORK = Network.newNetwork();
    private static final PostgreSQLContainer DATABASE = new PostgreSQLContainer("postgres:17-alpine")
            .withDatabaseName(DATABASE_NAME)
            .withUsername(DATABASE_USER)
            .withPassword(DATABASE_PASSWORD)
            .withNetwork(NETWORK)
            .withNetworkAliases("analysis-db");

    private static final ImageFromDockerfile SERVICE_IMAGE =
            new ImageFromDockerfile("unfallatlas-analysis-service-system-test:local", false)
                    .withDockerfile(REPOSITORY_ROOT.resolve("analysis-service/Dockerfile"));

    private static final GenericContainer<?> SERVICE = new GenericContainer<>(SERVICE_IMAGE)
            .withNetwork(NETWORK)
            .withEnv(java.util.Map.of(
                    "SPRING_PROFILES_ACTIVE", "prod",
                    "ANALYSIS_DB_URL", "jdbc:postgresql://analysis-db:5432/" + DATABASE_NAME,
                    "ANALYSIS_DB_USER", DATABASE_USER,
                    "ANALYSIS_DB_PASSWORD", DATABASE_PASSWORD,
                    "PORT", Integer.toString(SERVICE_PORT)))
            .withExposedPorts(SERVICE_PORT)
            .waitingFor(Wait.forHttp("/actuator/health")
                    .forPort(SERVICE_PORT)
                    .forStatusCode(200))
            .withStartupTimeout(Duration.ofMinutes(8));

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .build();

    @BeforeAll
    static void startContainers() {
        DATABASE.start();
        try {
            SERVICE.start();
        } catch (RuntimeException error) {
            DATABASE.stop();
            throw error;
        }
    }

    @Test
    void startsProductionProfileAgainstRealPostgres() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(serviceBaseUrl() + "/actuator/health"))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();
        HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
        assertTrue(response.body().contains("UP"), response.body());
        assertTrue(SERVICE.isRunning());
        assertTrue(DATABASE.isRunning());
    }

    @Test
    void flywayMigratesTheRealPostgresSchema() throws Exception {
        try (Connection connection = DriverManager.getConnection(
                DATABASE.getJdbcUrl(), DATABASE.getUsername(), DATABASE.getPassword());
             Statement statement = connection.createStatement()) {
            try (ResultSet result = statement.executeQuery(
                    "select count(*) from flyway_schema_history where success = true")) {
                assertTrue(result.next());
                assertTrue(result.getInt(1) >= 3,
                        "Expected the versioned analysis-service migrations to run");
            }
            try (ResultSet result = statement.executeQuery("""
                    select count(*)
                      from information_schema.tables
                     where table_schema = 'public'
                       and table_type = 'BASE TABLE'
                       and table_name <> 'flyway_schema_history'
                    """)) {
                assertTrue(result.next());
                assertTrue(result.getInt(1) > 5,
                        "Expected application and Spring Batch tables in PostgreSQL");
            }
        }
    }

    @Test
    void serviceLogsContainNoDatabaseFallbackOrSchemaFailure() {
        String logs = SERVICE.getLogs();
        assertFalse(logs.contains("jdbc:h2:"), "Prod container silently fell back to H2:\n" + logs);
        assertFalse(logs.contains("Schema-validation: missing"), logs);
        assertFalse(logs.contains("APPLICATION FAILED TO START"), logs);
    }

    @AfterAll
    static void stopContainersAndPersistLogs() throws IOException {
        Files.createDirectories(LOG_DIRECTORY);
        Files.writeString(
                LOG_DIRECTORY.resolve("analysis-service-postgresql.log"),
                SERVICE.getLogs(),
                StandardCharsets.UTF_8);
        Files.writeString(
                LOG_DIRECTORY.resolve("postgresql.log"),
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

    private static String serviceBaseUrl() {
        return "http://" + SERVICE.getHost() + ":" + SERVICE.getMappedPort(SERVICE_PORT);
    }
}
