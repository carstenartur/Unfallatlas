package de.unfallatlas.qa;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.ImageFromDockerfile;

@EnabledIfSystemProperty(named = "unfallatlas.contextData", matches = "true")
class ContextDataContainerIT {

    private static final int APPLICATION_PORT = 8000;
    private static final Path REPOSITORY_ROOT = Path.of(
            System.getProperty("unfallatlas.repositoryRoot", ".."))
            .toAbsolutePath()
            .normalize();
    private static final Path SELECTED_CITIES = Path.of(System.getProperty(
            "unfallatlas.contextCitiesFile",
            REPOSITORY_ROOT.resolve(".build/context-selected-cities.txt").toString()));

    @Test
    void rendersGeneratedSlopeAndTrafficDataInTheProductionContainer() throws Exception {
        String city = Files.readAllLines(SELECTED_CITIES, StandardCharsets.UTF_8).stream()
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "No generated context city listed in " + SELECTED_CITIES));

        ImageFromDockerfile image = new ImageFromDockerfile(
                "unfallatlas-context-system-test:local", false)
                .withDockerfile(REPOSITORY_ROOT.resolve("Dockerfile"));

        try (GenericContainer<?> application = new GenericContainer<>(image)
                .withExposedPorts(APPLICATION_PORT)
                .waitingFor(Wait.forHttp("/api/health")
                        .forPort(APPLICATION_PORT)
                        .forStatusCode(200))
                .withStartupTimeout(Duration.ofMinutes(12))) {
            application.start();
            String script = browserContract(city);
            org.testcontainers.containers.Container.ExecResult execution =
                    application.execInContainer("node", "-e", script);
            assertEquals(0, execution.getExitCode(), execution.getStdout() + execution.getStderr());
            assertTrue(execution.getStdout().contains("CONTEXT_E2E_RESULT="), execution.getStdout());
        }
    }

    private static String browserContract(String city) {
        String safeCity = "\"" + city
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n") + "\"";
        return """
                const { chromium } = require('@playwright/test');
                (async () => {
                  const city = %s;
                  const browser = await chromium.launch({ headless: true });
                  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
                  const errors = [];
                  page.on('pageerror', error => errors.push(String(error && error.message || error)));
                  const url = new URL('http://127.0.0.1:8000/werkbank_v2.html');
                  url.searchParams.set('city', city);
                  url.searchParams.set('mapLayer', 'slope,traffic');
                  url.searchParams.set('showCluster', '0');
                  url.searchParams.set('showHeatmap', '0');
                  url.searchParams.set('showSchools', '0');
                  url.searchParams.set('showKindergartens', '0');
                  url.searchParams.set('showArgumentation', '0');
                  const response = await page.goto(url.toString(), {
                    waitUntil: 'domcontentloaded', timeout: 120000
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
                  let result = null;
                  while (Date.now() < deadline) {
                    result = await page.evaluate(() => {
                      const legends = Array.from(document.querySelectorAll('.context-road-legend'))
                        .filter(node => {
                          const style = getComputedStyle(node);
                          return style.display !== 'none' && style.visibility !== 'hidden';
                        });
                      let canvases = 0;
                      let opaquePixels = 0;
                      for (const canvas of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
                        if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) continue;
                        const context = canvas.getContext('2d', { willReadFrequently: true });
                        if (!context) continue;
                        canvases += 1;
                        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
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
                  result = result || { canvases: 0, opaquePixels: 0, legendCount: 0, legendText: '' };
                  result.city = city;
                  result.pageErrors = errors;
                  console.log('CONTEXT_E2E_RESULT=' + JSON.stringify(result));
                  if (result.canvases < 1 || result.opaquePixels <= 100
                      || result.legendCount !== 2
                      || !result.legendText.includes('Straßensteigung')
                      || !result.legendText.includes('Verkehrsbelastung')
                      || errors.length) {
                    throw new Error('Visible context contract failed: ' + JSON.stringify(result));
                  }
                })().catch(error => {
                  console.error(error && error.stack ? error.stack : String(error));
                  process.exit(1);
                });
                """.formatted(safeCity);
    }
}
