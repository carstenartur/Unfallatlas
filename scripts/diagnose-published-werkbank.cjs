'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const TARGET_URL = process.env.LIVE_WERKBANK_URL || [
  'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Hannover',
  'severity=all',
  'dayType=all',
  'roadCondition=all',
  'hourFrom=0',
  'hourTo=23',
  'maxPoints=100000',
  'viewportPaddingPct=20',
  'heatRadius=25',
  'includeCyclist=1',
  'includePedestrian=1',
  'includeCar=1',
  'includeMotorcycle=0',
  'includeGkfz=0',
  'includeSonstig=0',
  'involvementMode=or',
  'showCluster=1',
  'showHeatmap=0',
  'showOnlyAboveAverage=0',
  'showSchools=1',
  'showKindergartens=1',
  'showArgumentation=1',
  'mapMode=standard',
  'orthophotoOpacity=92',
  'centerLat=52.375900',
  'centerLon=9.732000',
  'zoom=12',
  'ctxOnlyMatched=0',
].join('&');

const outputDirectory = path.resolve('out/qa/published-runtime-diagnostic');
fs.mkdirSync(outputDirectory, { recursive: true });

function compactError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const diagnostics = {
    checkedAt: new Date().toISOString(),
    targetUrl: TARGET_URL,
    navigation: null,
    pageErrors: [],
    console: [],
    httpErrors: [],
    requestFailures: [],
    state: null,
    healthy: false,
  };
  const liveOrigin = new URL(TARGET_URL).origin;

  page.on('pageerror', (error) => diagnostics.pageErrors.push(compactError(error)));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      diagnostics.console.push({ type: message.type(), text: message.text() });
    }
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    let sameOrigin = false;
    try { sameOrigin = new URL(response.url()).origin === liveOrigin; } catch (_) {}
    diagnostics.httpErrors.push({
      sameOrigin,
      status: response.status(),
      url: response.url(),
      contentType: response.headers()['content-type'] || null,
    });
  });
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push({
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText || 'unknown',
    });
  });

  try {
    const response = await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    diagnostics.navigation = {
      status: response?.status() ?? null,
      url: response?.url() || page.url(),
      contentType: response?.headers()['content-type'] || null,
    };

    try {
      await page.waitForFunction(() => {
        const ctx = window.UA?.getRuntimeContext?.();
        return Boolean(ctx?.map && ctx.ui && ctx.CITY_RAW === 'Hannover' &&
          Array.isArray(ctx.allPts) && ctx.allPts.length > 0);
      }, null, { timeout: 15000 });
    } catch (_) {
      // The state snapshot below is the primary diagnostic evidence.
    }

    diagnostics.state = await page.evaluate(() => {
      let ctx = null;
      let contextError = null;
      try { ctx = window.UA?.getRuntimeContext?.() || null; }
      catch (error) { contextError = error?.message || String(error); }
      const city = document.getElementById('citySel');
      const stat = document.getElementById('stat');
      return {
        readyState: document.readyState,
        title: document.title,
        distributionProfile: document.querySelector('meta[name="unfallwerkbank:distribution-profile"]')?.content || null,
        build: document.querySelector('meta[name="unfallwerkbank-build"]')?.content || null,
        uaExists: Boolean(window.UA),
        uaKeys: window.UA ? Object.keys(window.UA).sort() : [],
        getRuntimeContextType: typeof window.UA?.getRuntimeContext,
        contextError,
        city: ctx?.CITY_RAW || null,
        mapExists: Boolean(ctx?.map),
        uiExists: Boolean(ctx?.ui),
        allPoints: Array.isArray(ctx?.allPts) ? ctx.allPts.length : null,
        filteredPoints: Array.isArray(ctx?.filteredAll) ? ctx.filteredAll.length : null,
        viewportPoints: Array.isArray(ctx?.visibleViewportPts)
          ? ctx.visibleViewportPts.length
          : Array.isArray(ctx?.viewportPts) ? ctx.viewportPts.length : null,
        citySelect: city ? {
          value: city.value,
          ariaBusy: city.getAttribute('aria-busy'),
          optionCount: city.options.length,
          text: city.textContent.replace(/\s+/g, ' ').trim(),
        } : null,
        statusText: stat?.textContent?.replace(/\s+/g, ' ').trim() || null,
        scriptSources: Array.from(document.scripts, (script) => script.src || '[inline]'),
        bodyTextPrefix: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 500) || null,
      };
    });

    diagnostics.healthy = Boolean(
      diagnostics.navigation?.status === 200 &&
      diagnostics.state?.mapExists &&
      diagnostics.state?.uiExists &&
      diagnostics.state?.city === 'Hannover' &&
      Number(diagnostics.state?.allPoints) > 0 &&
      diagnostics.pageErrors.length === 0 &&
      diagnostics.httpErrors.filter((item) => item.sameOrigin).length === 0
    );
  } catch (error) {
    diagnostics.navigationError = compactError(error);
  } finally {
    try {
      await page.screenshot({
        path: path.join(outputDirectory, 'published-hannover.png'),
        fullPage: true,
      });
    } catch (error) {
      diagnostics.screenshotError = compactError(error);
    }
    fs.writeFileSync(
      path.join(outputDirectory, 'diagnostic.json'),
      `${JSON.stringify(diagnostics, null, 2)}\n`,
    );
    await browser.close();
  }

  console.log(JSON.stringify(diagnostics, null, 2));
  if (!diagnostics.healthy) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
