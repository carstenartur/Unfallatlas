import { test, expect } from '@playwright/test';

test.describe('Popup context data', () => {
  test('first marker click materialises official base details lazily', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(
      '/werkbank_v2.html?city=Bonn&showCluster=1&showHeatmap=0' +
      '&showSchools=0&showKindergartens=0&showArgumentation=0' +
      '&centerLat=50.7330&centerLon=7.0950&zoom=15',
      { waitUntil: 'domcontentloaded' }
    );

    await page.evaluate(() => window.UA.lifecycle.whenReady({
      city: 'Bonn',
      minLoaded: 1,
      minFiltered: 1,
      minViewport: 1,
      requireCompleteCoverage: true,
      layers: ['cluster'],
    }, { timeoutMs: 30_000 }));

    const markerPopup = await page.evaluate(async () => {
      let clusterLayer = null;
      window._uaMap.eachLayer(layer => {
        // A visible MarkerCluster also exposes getAllChildMarkers().  Select
        // the owning MarkerClusterGroup explicitly; it is the object carrying
        // the one shared popup context and the delegated click listener.
        if (!clusterLayer && layer && layer._uaPopupCtx && typeof layer.getLayers === 'function') {
          clusterLayer = layer;
        }
      });
      if (!clusterLayer) throw new Error('MarkerClusterGroup is unavailable');

      const visible = clusterLayer._featureGroup && typeof clusterLayer._featureGroup.getLayers === 'function'
        ? clusterLayer._featureGroup.getLayers().find(layer => layer && layer._uaProps && layer._map)
        : null;
      const marker = visible || (typeof clusterLayer.getLayers === 'function'
        ? clusterLayer.getLayers().find(layer => layer && layer._uaProps)
        : null);
      if (!marker) throw new Error('No accident marker is available');

      if (!marker._map) {
        await new Promise((resolve, reject) => {
          if (typeof clusterLayer.zoomToShowLayer !== 'function') {
            reject(new Error('zoomToShowLayer is unavailable'));
            return;
          }
          const timeout = setTimeout(
            () => reject(new Error('Accident marker did not become visible')),
            10_000
          );
          clusterLayer.zoomToShowLayer(marker, () => {
            clearTimeout(timeout);
            marker._map ? resolve() : reject(new Error('Accident marker is still hidden'));
          });
        });
      }

      // `propagate=true` exercises Leaflet's real child→FeatureGroup event
      // path and therefore the single delegated group listener.
      marker.fire('click', {}, true);
      const popup = marker && marker.getPopup();
      return popup ? String(popup.getContent()) : '';
    });

    expect(markerPopup).toContain('Amtliche Unfalldaten');
    expect(markerPopup).toMatch(/Unfall mit (Getöteten|Schwerverletzten|Leichtverletzten)/);
    expect(markerPopup).toContain('Beteiligte');
    expect(markerPopup).toContain('Datensatz-ID');
    expect(markerPopup).toContain('belegen keine Unfallursache');
    expect(markerPopup).not.toMatch(/undefined|null/i);
  });

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
