(() => {
  const UA = (window.UA = window.UA || {});
  if (UA.lifecycle) return;

  const waiters = new Set();
  let revision = 0;

  function freezeValue(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freezeValue(child);
    return Object.freeze(value);
  }

  function copyCoverage(coverage) {
    if (!coverage || typeof coverage !== "object") return null;
    const copy = {};
    for (const [key, value] of Object.entries(coverage)) {
      if (value && typeof value === "object") {
        copy[key] = Array.isArray(value) ? value.slice() : { ...value };
      } else {
        copy[key] = value;
      }
    }
    return freezeValue(copy);
  }

  function emptyRender() {
    return freezeValue({
      revision,
      completedRevision: 0,
      submitted: false,
      layers: {}
    });
  }

  let snapshot = freezeValue({
    status: "booting",
    city: null,
    counts: { loaded: 0, filtered: 0, viewport: 0 },
    coverage: null,
    render: emptyRender(),
    error: null
  });

  function layerReady(layer) {
    return !layer.requested || layer.complete === true;
  }

  function renderReady(render) {
    if (!render || !render.submitted || render.completedRevision !== render.revision) return false;
    return Object.values(render.layers || {}).every(layerReady);
  }

  function matchesCriteria(current, criteria) {
    const c = criteria || {};
    if (current.status !== "ready" || !renderReady(current.render)) return false;
    if (c.city && current.city !== c.city) return false;
    if (c.afterRevision != null
        && current.render.revision <= Math.max(0, Number(c.afterRevision) || 0)) return false;
    if ((current.counts.loaded || 0) < Math.max(0, Number(c.minLoaded) || 0)) return false;
    if ((current.counts.filtered || 0) < Math.max(0, Number(c.minFiltered) || 0)) return false;
    if ((current.counts.viewport || 0) < Math.max(0, Number(c.minViewport) || 0)) return false;
    if (c.requireCompleteCoverage && current.coverage?.complete !== true) return false;
    for (const name of (Array.isArray(c.layers) ? c.layers : [])) {
      const layer = current.render.layers && current.render.layers[name];
      if (!layer || !layer.requested || layer.complete !== true || layer.visible <= 0) return false;
      if (name === "heatmap" && layer.painted !== true) return false;
    }
    return true;
  }

  function settleWaiters() {
    for (const waiter of Array.from(waiters)) {
      if (snapshot.status === "error") {
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        const error = new Error(snapshot.error || "application lifecycle failed");
        error.snapshot = snapshot;
        waiter.reject(error);
      } else if (matchesCriteria(snapshot, waiter.criteria)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(snapshot);
      }
    }
  }

  function publish(next) {
    snapshot = freezeValue(next);
    settleWaiters();
    return snapshot;
  }

  function countsFrom(input) {
    const counts = input && input.counts ? input.counts : input || {};
    return freezeValue({
      loaded: Math.max(0, Number(counts.loaded) || 0),
      filtered: Math.max(0, Number(counts.filtered) || 0),
      viewport: Math.max(0, Number(counts.viewport) || 0)
    });
  }

  function normalizeLayers(layers) {
    const normalized = {};
    for (const [name, raw] of Object.entries(layers || {})) {
      const layer = raw || {};
      normalized[name] = freezeValue({
        requested: !!layer.requested,
        expected: Math.max(0, Number(layer.expected) || 0),
        processed: Math.max(0, Number(layer.processed) || 0),
        visible: Math.max(0, Number(layer.visible) || 0),
        painted: !!layer.painted,
        complete: layer.requested ? layer.complete === true : true
      });
    }
    return freezeValue(normalized);
  }

  const reporter = {
    beginLoad(city) {
      return publish({
        status: "loading",
        city: city || null,
        counts: countsFrom(null),
        coverage: null,
        render: freezeValue({
          revision,
          completedRevision: snapshot.render?.completedRevision || 0,
          submitted: false,
          layers: {}
        }),
        error: null
      });
    },

    recordData(info) {
      const data = info || {};
      return publish({
        ...snapshot,
        status: snapshot.status === "error" ? "error" : "loading",
        city: data.city || snapshot.city,
        counts: countsFrom(data),
        coverage: copyCoverage(data.coverage),
        error: snapshot.status === "error" ? snapshot.error : null
      });
    },

    beginRender(info) {
      const data = info || {};
      revision += 1;
      publish({
        status: "rendering",
        city: data.city || snapshot.city,
        counts: countsFrom(data),
        coverage: copyCoverage(data.coverage),
        render: freezeValue({
          revision,
          completedRevision: snapshot.render?.completedRevision || 0,
          submitted: false,
          layers: normalizeLayers(data.layers)
        }),
        error: null
      });
      return revision;
    },

    reportLayer(renderRevision, name, update) {
      if (renderRevision !== snapshot.render?.revision || !snapshot.render.layers?.[name]) return snapshot;
      const layers = { ...snapshot.render.layers };
      layers[name] = freezeValue({ ...layers[name], ...(update || {}) });
      const render = freezeValue({ ...snapshot.render, layers: freezeValue(layers) });
      return publish({
        ...snapshot,
        status: renderReady(render) ? "ready" : "rendering",
        render
      });
    },

    finishRender(renderRevision) {
      if (renderRevision !== snapshot.render?.revision) return snapshot;
      const render = freezeValue({
        ...snapshot.render,
        submitted: true,
        completedRevision: renderRevision
      });
      return publish({
        ...snapshot,
        status: renderReady(render) ? "ready" : "rendering",
        render
      });
    },

    fail(error) {
      const message = String(error && error.message ? error.message : error || "application lifecycle failed");
      return publish({ ...snapshot, status: "error", error: message });
    }
  };

  function getSnapshot() {
    return snapshot;
  }

  function whenReady(criteria = {}, options = {}) {
    if (snapshot.status === "error") {
      const error = new Error(snapshot.error || "application lifecycle failed");
      error.snapshot = snapshot;
      return Promise.reject(error);
    }
    if (matchesCriteria(snapshot, criteria)) return Promise.resolve(snapshot);
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 30000);
    return new Promise((resolve, reject) => {
      const waiter = { criteria: { ...criteria }, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        waiters.delete(waiter);
        const error = new Error(`application lifecycle did not become ready within ${timeoutMs}ms`);
        error.snapshot = snapshot;
        reject(error);
      }, timeoutMs);
      waiters.add(waiter);
      settleWaiters();
    });
  }

  // Public observers only receive two read-only operations. Producers use a
  // non-enumerable frozen reporter to reduce accidental coupling. The
  // reporter is an internal API by convention, not a security boundary.
  UA.lifecycle = Object.freeze({ getSnapshot, whenReady });
  Object.defineProperty(UA, "_lifecycleReporter", {
    value: Object.freeze(reporter),
    enumerable: false,
    configurable: false,
    writable: false
  });
})();
