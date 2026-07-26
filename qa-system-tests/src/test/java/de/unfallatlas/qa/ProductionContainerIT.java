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
import java.util.HexFormat;
import java.util.Locale;
import java.util.regex.Pattern;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.ImageFromDockerfile;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@Testcontainers
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ProductionContainerIT {

    private static final int APPLICATION_PORT = 8000;
    private static final Pattern SHA_256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Path REPOSITORY_ROOT = Path.of(
            System.getProperty("unfallatlas.repositoryRoot", ".."))
            .toAbsolutePath()
            .normalize();
    private static final Path LOG_DIRECTORY = Path.of(
            System.getProperty("unfallatlas.qaOutputDir", "target/testcontainers-logs"))
            .toAbsolutePath()
            .normalize();

    private static final ImageFromDockerfile APPLICATION_IMAGE =
            new ImageFromDockerfile("unfallatlas-system-test:local", false)
                    .withDockerfile(REPOSITORY_ROOT.resolve("Dockerfile"))
                    .withBuildArg("VIDEO_EXPORT_INTEGRATION_FIXTURE", "1");

    @Container
    private static final GenericContainer<?> APPLICATION = new GenericContainer<>(APPLICATION_IMAGE)
            .withExposedPorts(APPLICATION_PORT)
            .waitingFor(Wait.forHttp("/api/health")
                    .forPort(APPLICATION_PORT)
                    .forStatusCode(200))
            .withStartupTimeout(Duration.ofMinutes(12));

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private static final String VIDEO_STATE = """
            {
              "schemaVersion": 1,
              "city": "Bonn",
              "filters": {
                "severity": "all",
                "involvementMode": "or",
                "hourFrom": 0,
                "hourTo": 23,
                "dayType": "all",
                "roadCondition": "all",
                "maxPoints": 100000,
                "viewportPaddingPct": 20,
                "heatRadius": 25,
                "involvement": {
                  "cyclist": true,
                  "pedestrian": true,
                  "car": true,
                  "motorcycle": false,
                  "gkfz": false,
                  "sonstig": false
                }
              },
              "context": {
                "slopeClasses": ["steep", "very_steep"],
                "trafficClasses": ["high", "very_high"],
                "onlyMatchedWays": true
              },
              "layers": {
                "cluster": true,
                "heatmap": false,
                "onlyAboveAverage": false,
                "slope": true,
                "traffic": true
              },
              "viewport": {
                "center": {"lat": 50.7315, "lon": 7.1025},
                "zoom": 15
              },
              "selection": null
            }
            """;

    @Test
    @Order(1)
    void servesExactBuiltSiteAndHidesRepositoryMetadata() throws Exception {
        HttpResponse<byte[]> health = get("/api/health");
        assertEquals(200, health.statusCode());
        assertTrue(text(health).contains("ok"), text(health));

        HttpResponse<byte[]> manifest = get("/build-manifest.json");
        assertEquals(200, manifest.statusCode());
        String body = text(manifest);
        assertTrue(body.matches("(?s).*\"schemaVersion\"\s*:\s*1.*"), body);
        assertTrue(body.matches("(?s).*\"fingerprint\"\s*:\s*\"[a-f0-9]{64}\".*"), body);
        assertTrue(body.contains("\"application\""), body);
        assertTrue(body.contains("\"data\""), body);
        assertTrue(body.contains("\"cities\""), body);

        HttpResponse<byte[]> packageJson = get("/package.json");
        assertEquals(404, packageJson.statusCode());
    }

    @Test
    @Order(2)
    void rejectsInvalidRequestsBeforeStartingBrowserWork() throws Exception {
        long started = System.nanoTime();
        HttpResponse<byte[]> unsupportedFormat = post(
                "/api/export-video",
                payload("mp4"));
        assertEquals(400, unsupportedFormat.statusCode());
        assertTrue(text(unsupportedFormat).contains("unsupported_format"), text(unsupportedFormat));

        HttpResponse<byte[]> unsupportedPackaging = post(
                "/api/export-video?packaging=tar",
                payload("gif"));
        assertEquals(400, unsupportedPackaging.statusCode());
        assertTrue(text(unsupportedPackaging).contains("unsupported_packaging"), text(unsupportedPackaging));
        assertTrue(Duration.ofNanos(System.nanoTime() - started).compareTo(Duration.ofSeconds(10)) < 0,
                "Invalid requests unexpectedly entered the browser/export pipeline");
    }

    @Test
    @Order(3)
    void exportsValidGifWithIntegrityAndProvenanceEvidence() throws Exception {
        HttpResponse<byte[]> response = post("/api/export-video", payload("gif"));
        assertEquals(200, response.statusCode(), text(response));
        assertTrue(requiredHeader(response, "content-type").toLowerCase(Locale.ROOT).startsWith("image/gif"));

        byte[] body = response.body();
        assertTrue(body.length >= 50 * 1024, "GIF is implausibly small: " + body.length);
        assertTrue(body.length <= 10 * 1024 * 1024, "GIF exceeds the 10 MiB contract: " + body.length);
        String signature = new String(body, 0, Math.min(6, body.length), StandardCharsets.US_ASCII);
        assertTrue(signature.equals("GIF87a") || signature.equals("GIF89a"), signature);
        assertEquals(0x3b, Byte.toUnsignedInt(body[body.length - 1]));

        String artifactSha = requiredHeader(response, "x-unfallatlas-artifact-sha256");
        assertSha256(artifactSha, "artifact SHA-256");
        assertEquals(artifactSha, HexFormat.of().formatHex(java.security.MessageDigest
                .getInstance("SHA-256")
                .digest(body)));
        for (String name : new String[] {
                "x-unfallatlas-source-manifest-sha256",
                "x-unfallatlas-media-provenance-sha256",
                "x-unfallatlas-build-fingerprint",
                "x-unfallatlas-data-fingerprint",
                "x-unfallatlas-evidence-sha256"
        }) {
            assertSha256(requiredHeader(response, name), name);
        }
        for (String name : new String[] {
                "x-unfallatlas-encoded-frames",
                "x-unfallatlas-encoded-accident-pixels",
                "x-unfallatlas-encoded-slope-pixels",
                "x-unfallatlas-encoded-traffic-pixels"
        }) {
            assertTrue(Integer.parseInt(requiredHeader(response, name)) > 0, name);
        }
        for (String name : new String[] {
                "x-unfallatlas-loaded-accidents",
                "x-unfallatlas-filtered-accidents",
                "x-unfallatlas-viewport-accidents",
                "x-unfallatlas-preview-accidents"
        }) {
            assertEquals("12", requiredHeader(response, name), name);
        }
        assertEquals("true", requiredHeader(response, "x-unfallatlas-pdf-completed"));
        assertTrue(requiredHeader(response, "content-digest").startsWith("sha-256=:"));

        String provenancePath = requiredHeader(response, "x-unfallatlas-provenance-url");
        assertTrue(provenancePath.matches("^/api/export-video/provenance/[a-f0-9]{64}\\.json$"), provenancePath);
        HttpResponse<byte[]> provenance = get(provenancePath);
        assertEquals(200, provenance.statusCode());
        String provenanceJson = text(provenance);
        assertTrue(provenanceJson.contains(artifactSha), provenanceJson);
        assertTrue(provenanceJson.contains("Statistische Ämter des Bundes und der Länder"), provenanceJson);
        assertTrue(provenanceJson.contains("DL-DE-BY-2.0"), provenanceJson);
    }

    @Test
    @Order(4)
    void rendersSlopeAndTrafficLayersInTheContainerBrowser() throws Exception {
        String browserContract = """
                const { chromium } = require('@playwright/test');
                (async () => {
                  const browser = await chromium.launch({ headless: true });
                  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
                  const errors = [];
                  page.on('pageerror', error => errors.push(String(error && error.message || error)));
                  const url = new URL('http://127.0.0.1:8000/werkbank_v2.html');
                  url.searchParams.set('city', 'Bonn');
                  url.searchParams.set('mapLayer', 'slope,traffic');
                  url.searchParams.set('showCluster', '1');
                  url.searchParams.set('showHeatmap', '0');
                  url.searchParams.set('showSchools', '0');
                  url.searchParams.set('showKindergartens', '0');
                  url.searchParams.set('showArgumentation', '0');
                  url.searchParams.set('centerLat', '50.731500');
                  url.searchParams.set('centerLon', '7.102500');
                  url.searchParams.set('zoom', '15');
                  const response = await page.goto(url.toString(), {
                    waitUntil: 'domcontentloaded',
                    timeout: 120000
                  });
                  if (!response || !response.ok()) throw new Error('Werkbank HTML was not served');
                  await page.waitForFunction(() => {
                    const slope = document.querySelector('input[data-context-overlay="slope"]');
                    const traffic = document.querySelector('input[data-context-overlay="traffic"]');
                    return slope && traffic && !slope.disabled && !traffic.disabled;
                  }, null, { timeout: 120000 });
                  for (const selector of [
                    'input[data-context-overlay="slope"]',
                    'input[data-context-overlay="traffic"]'
                  ]) {
                    const input = page.locator(selector);
                    if (!(await input.isChecked())) await input.check();
                  }
                  const deadline = Date.now() + 120000;
                  let result;
                  while (Date.now() < deadline) {
                    result = await page.evaluate(() => {
                      const legends = Array.from(document.querySelectorAll('.context-road-legend'))
                        .filter(node => {
                          const style = getComputedStyle(node);
                          return style.display !== 'none' && style.visibility !== 'hidden';
                        });
                      let opaquePixels = 0;
                      let canvases = 0;
                      for (const canvas of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
                        if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) continue;
                        const context = canvas.getContext('2d', { willReadFrequently: true });
                        if (!context) continue;
                        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                        canvases += 1;
                        for (let index = 3; index < data.length; index += 16) {
                          if (data[index] >= 80) opaquePixels += 1;
                        }
                      }
                      return {
                        canvases,
                        opaquePixels,
                        legendCount: legends.length,
                        legendText: legends.map(node => node.textContent || '').join(' ')
                          .replace(/\\s+/g, ' ').trim()
                      };
                    });
                    if (result.canvases > 0 && result.opaquePixels > 100
                        && result.legendCount === 2
                        && result.legendText.includes('Straßensteigung')
                        && result.legendText.includes('Verkehrsbelastung')) break;
                    await page.waitForTimeout(250);
                  }
                  await browser.close();
                  if (!result || result.canvases < 1 || result.opaquePixels <= 100
                      || result.legendCount !== 2
                      || !result.legendText.includes('Straßensteigung')
                      || !result.legendText.includes('Verkehrsbelastung')
                      || errors.length) {
                    throw new Error('Visible context contract failed: ' + JSON.stringify({ result, errors }));
                  }
                  console.log('CONTEXT_OK=' + JSON.stringify(result));
                })().catch(error => {
                  console.error(error && error.stack ? error.stack : String(error));
                  process.exit(1);
                });
                """;

        org.testcontainers.containers.Container.ExecResult execution =
                APPLICATION.execInContainer("node", "-e", browserContract);
        assertEquals(0, execution.getExitCode(), execution.getStdout() + execution.getStderr());
        assertTrue(execution.getStdout().contains("CONTEXT_OK="), execution.getStdout());
    }

    @Test
    @Order(5)
    void containerLogsStayFreeOfVideoExportErrors() {
        String logs = APPLICATION.getLogs();
        assertFalse(logs.contains("[export-video] Fehler"), logs);
    }

    @AfterAll
    static void persistContainerLogs() throws IOException {
        Files.createDirectories(LOG_DIRECTORY);
        Files.writeString(
                LOG_DIRECTORY.resolve("unfallwerkbank-production-container.log"),
                APPLICATION.getLogs(),
                StandardCharsets.UTF_8);
    }

    private static String baseUrl() {
        return "http://" + APPLICATION.getHost() + ":" + APPLICATION.getMappedPort(APPLICATION_PORT);
    }

    private static HttpResponse<byte[]> get(String path) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl() + path))
                .timeout(Duration.ofMinutes(2))
                .GET()
                .build();
        return HTTP.send(request, HttpResponse.BodyHandlers.ofByteArray());
    }

    private static HttpResponse<byte[]> post(String path, String body)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl() + path))
                .timeout(Duration.ofMinutes(7))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        return HTTP.send(request, HttpResponse.BodyHandlers.ofByteArray());
    }

    private static String payload(String format) {
        return "{\"state\":" + VIDEO_STATE + ",\"format\":\"" + format + "\"}";
    }

    private static String text(HttpResponse<byte[]> response) {
        return new String(response.body(), StandardCharsets.UTF_8);
    }

    private static String requiredHeader(HttpResponse<?> response, String name) {
        String value = response.headers().firstValue(name).orElse(null);
        assertNotNull(value, "Missing response header: " + name);
        return value;
    }

    private static void assertSha256(String value, String label) {
        assertTrue(SHA_256.matcher(value).matches(), label + " is not a SHA-256: " + value);
    }
}
