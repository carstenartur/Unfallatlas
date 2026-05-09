import { test, expect } from '@playwright/test';

test.describe('Popup context data', () => {
  test('renders enrichment strings in popup html for Hannover sample feature', async ({ page }) => {
    await page.goto('/werkbank_v2.html?city=Hannover');
    await page.waitForLoadState('networkidle');

    const html = await page.evaluate(async () => {
      if (!window.UA || typeof window.UA.buildAccidentContextPopupHtml !== 'function') return '';
      const resp = await fetch('/out/output_all_years_hannover.geojson', { cache: 'no-store' });
      if (!resp.ok) return '';
      const gj = await resp.json();
      const feature = (gj.features || []).find((f) => {
        const p = f && f.properties ? f.properties : {};
        return p && (p.elevation_m != null || p.slope_percent != null || p.traffic_proxy_class != null);
      });
      if (!feature) return '';
      const detection = (window.UA.contextLayers && window.UA.contextLayers.detect)
        ? window.UA.contextLayers.detect(gj)
        : { availableFields: [] };
      const available = new Set(detection.availableFields || []);
      return window.UA.buildAccidentContextPopupHtml({
        contextCapabilities: {
          hasElevation: available.has('elevation_m'),
          hasSlope: available.has('slope_percent') || available.has('slope_class') || available.has('slope_source'),
          hasOsmContext: available.has('matched_way_id'),
          hasTrafficProxy: available.has('traffic_proxy_class'),
        },
      }, feature.properties || {}) || '';
    });

    expect(html).toContain('Höhe');
    expect(html).toContain('Hangneigung');
    expect(html).toContain('Kontextdaten beschreiben die Umgebung, nicht die Unfallursache.');
  });
});
