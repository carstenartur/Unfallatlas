(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const MODULE_ID = 'unfallwerkbank.mapCaptureTileIntegrity.v1';
  const WRAPPER_TIMEOUT_MS = 25000;
  const FETCH_ATTEMPTS = 3;
  const FETCH_DELAYS_MS = Object.freeze([0, 180, 600]);
  const FETCH_CONCURRENCY = 4;
  const MAX_INSTALL_CHECKS = 240;
  const TRANSPARENT_TILE =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';

  const clean = value => String(value == null ? '' : value).trim();

  function failure(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    if (details) error.details = details;
    return error;
  }

  function isDataImage(value) {
    return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(clean(value));
  }

  function absoluteUrl(value) {
    const raw = clean(value);
    if (!raw || isDataImage(raw) || /^blob:/i.test(raw)) return raw;
    try {
      return new URL(raw, root.document?.baseURI || root.location?.href || undefined).href;
    } catch (_) {
      return raw;
    }
  }

  function zFor(coords, layer, map) {
    for (const value of [coords?.z, layer?._tileZoom,
      typeof map?.getZoom === 'function' ? map.getZoom() : NaN]) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function coordKey(coords, layer, map) {
    return `${Number(coords?.x)}:${Number(coords?.y)}:${zFor(coords, layer, map) ?? ''}`;
  }

  function xyKey(coords) {
    return `${Number(coords?.x)}:${Number(coords?.y)}`;
  }

  function leafletPoint(x, y, z) {
    let point;
    if (typeof root.L?.point === 'function') point = root.L.point(x, y);
    else if (typeof root.L?.Point === 'function') point = new root.L.Point(x, y);
    else point = { x, y, clone() { return leafletPoint(this.x, this.y, this.z); } };
    if (Number.isFinite(z)) point.z = z;
    return point;
  }

  function tileSizeFor(layer) {
    const option = layer?.options?.tileSize;
    const resolved = typeof layer?.getTileSize === 'function' ? layer.getTileSize() : null;
    return Number(option?.x ?? option ?? resolved?.x ?? 256);
  }

  function visibleAtCurrentZoom(layer, map) {
    const zoom = Number(typeof map?.getZoom === 'function' ? map.getZoom() : NaN);
    const min = Number(layer?.options?.minZoom);
    const max = Number(layer?.options?.maxZoom);
    if (Number.isFinite(zoom) && Number.isFinite(min) && zoom < min) return false;
    if (Number.isFinite(zoom) && Number.isFinite(max) && zoom > max) return false;
    return Number(layer?.options?.opacity) !== 0;
  }

  function activeTileLayers(map) {
    const TileLayer = root.L?.TileLayer;
    const layers = [];
    if (!map || typeof map.eachLayer !== 'function' || typeof TileLayer !== 'function') return layers;
    map.eachLayer(layer => {
      if (layer instanceof TileLayer && typeof layer.getTileUrl === 'function'
          && visibleAtCurrentZoom(layer, map)) {
        layers.push(layer);
      }
    });
    return layers;
  }

  function entryCoords(key, entry, layer, map) {
    if (entry?.coords && Number.isFinite(Number(entry.coords.x))
        && Number.isFinite(Number(entry.coords.y))) return entry.coords;
    const parts = clean(key).split(':').map(Number);
    if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    return { x: parts[0], y: parts[1], z: Number.isFinite(parts[2])
      ? parts[2] : zFor(null, layer, map) };
  }

  function entryElement(entry) {
    if (entry?.el) return entry.el;
    if (clean(entry?.tagName).toLowerCase() === 'img') return entry;
    return null;
  }

  function loadedTileRecords(layer, map) {
    const records = [];
    for (const [key, entry] of Object.entries(layer?._tiles || {})) {
      if (!entry || entry.current === false) continue;
      const coords = entryCoords(key, entry, layer, map);
      const element = entryElement(entry);
      if (coords && element) records.push({ coords, element, entry, originalCoords: coords });
    }
    return records;
  }

  /**
   * Mirror leaflet-image@0.4.0's tile range, while distinguishing the extra
   * boundary row/column that has zero overlap with the output canvas.
   */
  function expectedTileRequests(layer, map) {
    if (typeof map?.getPixelBounds !== 'function' || typeof map?.getSize !== 'function') return null;
    const bounds = map.getPixelBounds();
    const size = map.getSize();
    const tileSize = tileSizeFor(layer);
    if (!(tileSize > 0) || !bounds?.min || !bounds?.max) return null;

    const values = [bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y, size?.x, size?.y]
      .map(Number);
    if (!values.every(Number.isFinite) || !(Number(size.x) > 0) || !(Number(size.y) > 0)) return null;

    const minX = Math.floor(Number(bounds.min.x) / tileSize);
    const minY = Math.floor(Number(bounds.min.y) / tileSize);
    const maxX = Math.floor(Number(bounds.max.x) / tileSize);
    const maxY = Math.floor(Number(bounds.max.y) / tileSize);
    const zoom = zFor(null, layer, map);
    const visible = [];
    const ignoredCoords = new Set();
    const ignoredXy = new Set();
    const ignoredUrls = new Set();

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (y < 0) continue; // same guard as leaflet-image
        const adjusted = leafletPoint(x, y, zoom);
        if (typeof layer._adjustTilePoint === 'function') layer._adjustTilePoint(adjusted);
        const coords = { x: Number(adjusted.x), y: Number(adjusted.y), z: zoom };
        const posX = x * tileSize - Number(bounds.min.x);
        const posY = y * tileSize - Number(bounds.min.y);
        const intersects = posX < Number(size.x) && posY < Number(size.y)
          && posX + tileSize > 0 && posY + tileSize > 0;
        if (intersects) {
          visible.push({ coords, originalCoords: { x, y, z: zoom }, element: null, entry: null });
        } else {
          ignoredCoords.add(coordKey(coords, layer, map));
          ignoredXy.add(xyKey(coords));
          try {
            const url = absoluteUrl(layer.getTileUrl(coords));
            if (url) ignoredUrls.add(url);
          } catch (_) { /* no visible pixels depend on this boundary tile */ }
        }
      }
    }
    return { visible, ignoredCoords, ignoredXy, ignoredUrls };
  }

  function loadedElementDataUrl(element) {
    const source = clean(element?.currentSrc || element?.src);
    if (isDataImage(source)) return source;
    if (!element || element.complete === false) return null;
    if ('naturalWidth' in element && Number(element.naturalWidth) <= 0) return null;
    if (!root.document || typeof root.document.createElement !== 'function') return null;
    try {
      const width = Number(element.naturalWidth || element.width || 0);
      const height = Number(element.naturalHeight || element.height || 0);
      if (!(width > 0) || !(height > 0)) return null;
      const canvas = root.document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext?.('2d');
      if (!context || typeof context.drawImage !== 'function') return null;
      context.drawImage(element, 0, 0, width, height);
      const dataUrl = canvas.toDataURL?.('image/png');
      return isDataImage(dataUrl) ? dataUrl : null;
    } catch (_) {
      // Cross-origin images loaded without crossorigin taint a canvas. Fetch
      // the exact already-visible URL with CORS and no cache buster below.
      return null;
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    if (typeof root.btoa === 'function') return root.btoa(binary);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    throw failure('MAP_CAPTURE_TILE_ENCODING_UNAVAILABLE',
      'Die Kartenkacheln konnten nicht für den Dokumentexport kodiert werden.');
  }

  async function blobToDataUrl(blob) {
    const mime = clean(blob?.type) || 'image/png';
    if (typeof root.FileReader === 'function') {
      return new Promise((resolve, reject) => {
        const reader = new root.FileReader();
        reader.onload = () => resolve(clean(reader.result));
        reader.onerror = () => reject(reader.error || failure('MAP_CAPTURE_TILE_ENCODING_FAILED',
          'Eine Kartenkachel konnte nicht für den Dokumentexport kodiert werden.'));
        reader.readAsDataURL(blob);
      });
    }
    if (typeof blob?.arrayBuffer === 'function') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return `data:${mime};base64,${bytesToBase64(bytes)}`;
    }
    throw failure('MAP_CAPTURE_TILE_ENCODING_UNAVAILABLE',
      'Diese Browserlaufzeit kann Kartenkacheln nicht für den Dokumentexport kodieren.');
  }

  function delay(ms, signal) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = root.setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => {
        root.clearTimeout(timer);
        reject(failure('MAP_CAPTURE_TILE_PREPARATION_ABORTED',
          'Die Vorbereitung der Kartenkacheln wurde abgebrochen.'));
      }, { once: true });
    });
  }

  async function fetchTileDataUrl(url, options = {}) {
    const fetchImpl = options.fetchImpl || (typeof root.fetch === 'function'
      ? root.fetch.bind(root) : null);
    if (!fetchImpl) {
      throw failure('MAP_CAPTURE_TILE_FETCH_UNAVAILABLE',
        'Eine sichtbare Kartenkachel ist nicht canvas-lesbar und kann nicht per CORS geladen werden.',
        { url });
    }
    const attempts = Math.max(1, Number(options.attempts) || FETCH_ATTEMPTS);
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await delay(Number(FETCH_DELAYS_MS[attempt] || 0), options.signal);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          cache: 'force-cache',
          signal: options.signal,
        });
        if (!response?.ok) {
          throw failure('MAP_CAPTURE_TILE_HTTP_ERROR',
            `Kartenkachel antwortete mit HTTP ${Number(response?.status) || 'unbekannt'}.`,
            { url, status: Number(response?.status) || null, attempt: attempt + 1 });
        }
        if (typeof response.blob !== 'function') {
          throw failure('MAP_CAPTURE_TILE_INVALID_RESPONSE',
            'Kartenkachel lieferte keine lesbaren Bilddaten.', { url });
        }
        const blob = await response.blob();
        const mime = clean(blob?.type || response.headers?.get?.('content-type')).toLowerCase();
        if (mime && !mime.startsWith('image/')) {
          throw failure('MAP_CAPTURE_TILE_NOT_IMAGE',
            `Kartenkachel lieferte den unerwarteten Inhaltstyp ${mime}.`, { url, mime });
        }
        const dataUrl = await blobToDataUrl(blob);
        if (!isDataImage(dataUrl)) {
          throw failure('MAP_CAPTURE_TILE_INVALID_DATA_URL',
            'Kartenkachel konnte nicht als lokales Bild bereitgestellt werden.', { url });
        }
        return dataUrl;
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) break;
      }
    }
    throw failure('MAP_CAPTURE_TILE_FETCH_FAILED',
      `Eine sichtbare Kartenkachel konnte nach ${attempts} Versuch(en) nicht vollständig geladen werden. `
        + 'Der Dokumentexport wurde abgebrochen, damit keine Karte mit fehlenden Kacheln entsteht.',
      { url, attempts, cause: clean(lastError?.message || lastError) });
  }

  async function mapConcurrent(values, limit, mapper) {
    const list = Array.from(values || []);
    const results = new Array(list.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(list[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker));
    return results;
  }

  async function materialize(record, layer, map, originalGetTileUrl, options) {
    let originalUrl;
    try {
      originalUrl = absoluteUrl(originalGetTileUrl.call(layer, record.coords));
    } catch (error) {
      throw failure('MAP_CAPTURE_TILE_URL_FAILED',
        'Die URL einer sichtbaren Kartenkachel konnte nicht bestimmt werden.',
        { coords: coordKey(record.coords, layer, map), cause: clean(error?.message || error) });
    }
    const elementUrl = absoluteUrl(record.element?.currentSrc || record.element?.src);
    const direct = loadedElementDataUrl(record.element);
    if (direct) return { ...record, originalUrl, elementUrl, dataUrl: direct };

    const sourceUrl = elementUrl || originalUrl;
    if (!sourceUrl) {
      throw failure('MAP_CAPTURE_TILE_SOURCE_MISSING',
        'Eine sichtbare Kartenkachel besitzt keine wiederverwendbare Bildquelle.',
        { coords: coordKey(record.coords, layer, map) });
    }
    let promise = options.urlCache.get(sourceUrl);
    if (!promise) {
      promise = fetchTileDataUrl(sourceUrl, options);
      options.urlCache.set(sourceUrl, promise);
    }
    return { ...record, originalUrl, elementUrl, dataUrl: await promise };
  }

  async function prepareLayer(layer, map, options) {
    const originalGetTileUrl = layer.getTileUrl;
    const loaded = loadedTileRecords(layer, map);
    const loadedByCoord = new Map();
    const loadedByXy = new Map();
    const loadedByUrl = new Map();
    for (const record of loaded) {
      loadedByCoord.set(coordKey(record.coords, layer, map), record);
      loadedByXy.set(xyKey(record.coords), record);
      try {
        const url = absoluteUrl(originalGetTileUrl.call(layer, record.coords));
        if (url) loadedByUrl.set(url, record);
      } catch (_) { /* handled below with a precise failure */ }
    }

    const expected = expectedTileRequests(layer, map);
    const records = expected ? expected.visible.map(request => {
      let url = '';
      try { url = absoluteUrl(originalGetTileUrl.call(layer, request.coords)); } catch (_) { /* later */ }
      const match = loadedByUrl.get(url)
        || loadedByCoord.get(coordKey(request.coords, layer, map))
        || loadedByXy.get(xyKey(request.coords));
      return match ? { ...request, element: match.element, entry: match.entry } : request;
    }) : loaded;

    if (!records.length) {
      throw failure('MAP_CAPTURE_TILE_SET_EMPTY',
        'Ein sichtbarer Rasterkarten-Layer enthält keine für den Kartenausschnitt benötigten Kacheln. '
          + 'Der Dokumentexport wurde abgebrochen.',
        { layer: clean(layer?.options?.attribution || layer?._url || layer?.constructor?.name) });
    }
    for (const record of records) {
      const element = record.element;
      if (element && (element.complete === false
          || ('naturalWidth' in element && Number(element.naturalWidth) <= 0))) {
        throw failure('MAP_CAPTURE_TILE_NOT_READY',
          'Mindestens eine sichtbare Kartenkachel ist noch nicht vollständig geladen.',
          { coords: coordKey(record.coords, layer, map), src: clean(element.currentSrc || element.src) });
      }
    }

    const materialized = await mapConcurrent(records, FETCH_CONCURRENCY,
      record => materialize(record, layer, map, originalGetTileUrl, options));
    const byCoord = new Map();
    const byXy = new Map();
    const byUrl = new Map();
    for (const tile of materialized) {
      byCoord.set(coordKey(tile.coords, layer, map), tile.dataUrl);
      byXy.set(xyKey(tile.coords), tile.dataUrl);
      for (const url of [tile.originalUrl, tile.elementUrl].map(absoluteUrl).filter(Boolean)) {
        byUrl.set(url, tile.dataUrl);
      }
    }

    const missing = new Map();
    const descriptor = Object.getOwnPropertyDescriptor(layer, 'getTileUrl');
    Object.defineProperty(layer, 'getTileUrl', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value(coords) {
        let raw = '';
        try { raw = absoluteUrl(originalGetTileUrl.call(this, coords)); } catch (_) { /* below */ }
        const key = coordKey(coords, layer, map);
        const xy = xyKey(coords);
        const local = byUrl.get(raw) || byCoord.get(key) || byXy.get(xy);
        if (local) return local;
        if (expected && (expected.ignoredUrls.has(raw)
            || expected.ignoredCoords.has(key) || expected.ignoredXy.has(xy))) {
          return TRANSPARENT_TILE;
        }
        missing.set(`${key}|${raw}`, { coords: key, url: raw });
        return TRANSPARENT_TILE;
      },
    });

    let restored = false;
    return {
      missing,
      restore() {
        if (restored) return;
        restored = true;
        if (descriptor) Object.defineProperty(layer, 'getTileUrl', descriptor);
        else delete layer.getTileUrl;
      },
    };
  }

  async function prepareMap(map, options = {}) {
    const prepared = [];
    const shared = { ...options, urlCache: new Map() };
    try {
      for (const layer of activeTileLayers(map)) prepared.push(await prepareLayer(layer, map, shared));
    } catch (error) {
      for (const item of prepared.reverse()) {
        try { item.restore(); } catch (_) { /* keep primary failure */ }
      }
      throw error;
    }
    let restored = false;
    return {
      missing() { return prepared.flatMap(item => [...item.missing.values()]); },
      restore() {
        if (restored) return;
        restored = true;
        for (const item of [...prepared].reverse()) item.restore();
      },
    };
  }

  function validateResult(map, canvas, prepared) {
    const missing = prepared?.missing?.() || [];
    if (missing.length) {
      throw failure('MAP_CAPTURE_TILE_COVERAGE_INCOMPLETE',
        `${missing.length} für den Kartenausschnitt benötigte Kachel(n) waren nicht in der `
          + 'vollständig gerenderten Leaflet-Karte vorhanden. Der Dokumentexport wurde abgebrochen.',
        { missing: missing.slice(0, 20) });
    }
    if (!canvas) throw failure('MAP_CAPTURE_CANVAS_MISSING',
      'leaflet-image lieferte keine Kartenfläche für den Dokumentexport.');
    const size = typeof map?.getSize === 'function' ? map.getSize() : null;
    const expectedWidth = Number(size?.x);
    const expectedHeight = Number(size?.y);
    if (expectedWidth > 0 && expectedHeight > 0
        && (Number(canvas.width) !== expectedWidth || Number(canvas.height) !== expectedHeight)) {
      throw failure('MAP_CAPTURE_CANVAS_SIZE_MISMATCH',
        `Die erzeugte Karte hat ${canvas.width}×${canvas.height} Pixel statt `
          + `${expectedWidth}×${expectedHeight} Pixel.`);
    }
  }

  function wrapLeafletImage(original) {
    if (typeof original !== 'function' || original._uaMapCaptureTileIntegrityWrapped) return original;
    const wrapped = function integrityCheckedLeafletImage(map, callback) {
      if (typeof callback !== 'function') return original(map, callback);
      let done = false;
      let prepared = null;
      const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      let timer;
      const finish = (error, canvas) => {
        if (done) return;
        done = true;
        root.clearTimeout(timer);
        try { controller?.abort(); } catch (_) { /* no-op */ }
        try { prepared?.restore?.(); } catch (restoreError) { if (!error) error = restoreError; }
        if (!error) {
          try { validateResult(map, canvas, prepared); } catch (validationError) { error = validationError; }
        }
        callback(error || null, error ? undefined : canvas);
      };
      timer = root.setTimeout(() => finish(failure('MAP_CAPTURE_TILE_INTEGRITY_TIMEOUT',
        `Die vollständige Bereitstellung der Kartenkacheln dauerte länger als `
          + `${WRAPPER_TIMEOUT_MS / 1000} Sekunden. Der Dokumentexport wurde abgebrochen.`)),
      WRAPPER_TIMEOUT_MS);

      Promise.resolve()
        .then(() => prepareMap(map, { signal: controller?.signal }))
        .then(result => {
          if (done) { result.restore(); return; }
          prepared = result;
          try { original(map, finish); } catch (error) { finish(error); }
        })
        .catch(error => finish(error));
      return undefined;
    };
    Object.defineProperties(wrapped, {
      _uaMapCaptureTileIntegrityWrapped: { value: true },
      _uaOriginal: { value: original },
    });
    return wrapped;
  }

  function install() {
    if (typeof root.leafletImage !== 'function') return false;
    if (!root.leafletImage._uaMapCaptureTileIntegrityWrapped) {
      root.leafletImage = wrapLeafletImage(root.leafletImage);
    }
    return true;
  }

  UA.MapCaptureTileIntegrity = Object.freeze({
    MODULE_ID,
    install,
    _internal: Object.freeze({
      absoluteUrl,
      coordKey,
      activeTileLayers,
      loadedTileRecords,
      expectedTileRequests,
      loadedElementDataUrl,
      fetchTileDataUrl,
      prepareLayer,
      prepareMap,
      validateResult,
      wrapLeafletImage,
    }),
  });

  let checks = 0;
  const installWhenReady = () => {
    if (install()) return;
    if (checks++ < MAX_INSTALL_CHECKS && typeof root.setTimeout === 'function') {
      root.setTimeout(installWhenReady, 25);
    }
  };
  installWhenReady();
  root.document?.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
})();
