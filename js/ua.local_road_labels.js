// Named local OSM ways for installations without a configured raster label service.
(() => {
  'use strict';

  const UA = window.UA = window.UA || {};
  const sources = Object.freeze({ bonn: 'data/mobility/road-labels/bonn.json' });
  const attribution = 'Straßennamen: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a> (ODbL 1.0)';

  function render(layer, map, data) {
    layer.clearLayers();
    if (map.getZoom() < 15) return;
    const bounds = map.getBounds();
    const metresPerPixel = 156543.034 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** map.getZoom();
    const placed = [];
    const pane = 'localRoadLabels';
    if (!map.getPane(pane)) {
      map.createPane(pane).style.cssText = 'z-index:350;pointer-events:none';
    }
    // Rows are sorted by road class and segment length by the producer.
    for (const [wayId, index, lat, lon, angle, length] of data.labels) {
      const point = [lat / 1e5, lon / 1e5];
      if (!bounds.contains(point)) continue;
      const name = data.names[index];
      const width = name.length * 7 + 6;
      if (length < width * metresPerPixel * 0.8) continue;
      const { x, y } = map.latLngToContainerPoint(point);
      const radians = angle * Math.PI / 180;
      const dx = Math.abs(Math.cos(radians)) * width / 2 + 10;
      const dy = Math.abs(Math.sin(radians)) * width / 2 + 10;
      if (placed.some(other => Math.abs(x - other.x) < dx + other.dx && Math.abs(y - other.y) < dy + other.dy
          || (other.name === name && Math.hypot(x - other.x, y - other.y) < 300))) continue;

      const text = document.createElement('span');
      text.textContent = name;
      text.dataset.osmWayId = String(wayId);
      text.style.cssText = 'position:absolute;white-space:nowrap;font:bold 12px/1.2 sans-serif;color:#182128;'
        + 'text-shadow:-1px -1px 1px white,1px -1px 1px white,-1px 1px 1px white,1px 1px 1px white,0 0 3px white;';
      text.style.transform = 'translate(-50%, -50%) rotate(' + angle + 'deg)';
      const icon = window.L.divIcon({ className: 'ua-local-road-label', html: text, iconSize: [0, 0] });
      window.L.marker(point, { pane, icon, interactive: false, keyboard: false }).addTo(layer);
      placed.push({ x, y, dx, dy, name });
    }
  }

  UA.createLocalRoadLabels = function(city, onStatusChange) {
    const slug = String(city || '').trim().toLowerCase();
    if (!Object.hasOwn(sources, slug) || !window.L?.layerGroup || !UA.DataResources) return null;
    const layer = window.L.layerGroup([], { attribution });
    let data;
    let pending;
    let activeMap;
    const redraw = () => { if (activeMap && data) render(layer, activeMap, data); };
    layer.on('add', async () => {
      const map = layer._map;
      activeMap = map;
      map.on('moveend', redraw);
      if (data) { redraw(); return; }
      layer.localLabelStatus = 'loading';
      try {
        pending ||= UA.DataResources.fetchJsonUrl(sources[slug], { compression: 'gzip-only', cache: 'no-cache' });
        const payload = await pending;
        if (payload?.schemaVersion !== 1 || payload.city !== slug || !Array.isArray(payload.names)
            || !Array.isArray(payload.labels)) throw new Error('Invalid local road label data');
        data = payload;
        layer.localLabelStatus = 'ready';
        redraw();
      } catch {
        layer.localLabelStatus = 'unavailable';
      } finally {
        pending = null;
        if (activeMap === map && onStatusChange) onStatusChange();
      }
    });
    layer.on('remove', () => {
      activeMap?.off('moveend', redraw);
      activeMap = null;
      layer.clearLayers();
    });
    return layer;
  };
})();
