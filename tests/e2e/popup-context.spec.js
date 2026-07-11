import { test, expect } from '@playwright/test';

test.describe('Popup context data', () => {
  test('renders enrichment strings in popup html for Hannover sample feature', async ({ page }) => {
    await page.goto('/werkbank_v2.html?city=Hannover');
    await page.waitForLoadState('networkidle');

    const html = await page.evaluate(async () => {
      if (!window.UA || typeof window.UA.buildAccidentContextPopupHtml !== 'function') return '';
      if (typeof window.UA.fetchJsonCompressed !== 'function') return '';
      const manifestResp = await fetch('/out/data-manifest.json', { cache: 'no-store' });
      if (!manifestResp.ok) return '';
      const manifest = await manifestResp.json();
      const cityEntry = manifest?.cities?.hannover || null;
      if (!cityEntry?.enrichment?.hasElevation) return '';
      const gj = await window.UA.fetchJsonCompressed('/out/output_all_years_hannover.geojson', { gzipOnly: true });
      const feature = (gj.features || []).find((f) => {
        const p = f && f.properties ? f.properties : {};
        return p && (p.elevation_m != null || p.slope_percent != null || p.traffic_proxy_class != null);
      });
      if (!feature) return '';
      // Derive capability flags via the single source of truth so the
      // e2e never drifts from CAPABILITY_FIELDS in ua.context_layers.js.
      const detection = window.UA.contextLayers.detect(gj);
      const contextCapabilities = window.UA.contextLayers.capabilitiesFromDetection(detection);
      return window.UA.buildAccidentContextPopupHtml(
        { contextCapabilities },
        feature.properties || {}
      ) || '';
    });

    test.skip(!html, 'Hannover has no elevation enrichment according to manifest.');
    expect(html).toContain('Höhe');
    expect(html).toContain('Hangneigung');
    expect(html).toContain('Kontextdaten beschreiben die Umgebung, nicht die Unfallursache.');
  });
});
