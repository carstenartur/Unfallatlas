(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // Renderer — abstract renderer interface (Issue #310)
  //
  // A Renderer consumes a SceneGraph and produces a visual representation
  // in a target environment (2D canvas, WebGL, AR, PDF image, etc.).
  //
  // All renderer implementations share the same interface:
  //
  //   renderer.render(sceneGraph)          → void | Promise<void>
  //   renderer.update(sceneGraph)          → void | Promise<void>
  //   renderer.dispose()                   → void
  //   renderer.captureSnapshot()           → Promise<string>  (data URL)
  //
  // Planned implementations
  //   UA.LeafletRenderer  — 2D Leaflet maps (available now)
  //   MapLibreRenderer    — 2D/3D vector tiles
  //   CesiumRenderer      — 3D globe
  //   RealityKitRenderer  — AR (native Swift bridge)
  //   HtmlRenderer        — HTML fragment
  //   WordRenderer        — Word document image
  //   PdfRenderer         — PDF image
  //   ImageRenderer       — static PNG/JPEG snapshot
  //
  // Public API
  //   UA.Renderer.CAPABILITIES — frozen set of capability keys
  //   UA.Renderer.create(name, impl, caps?) → renderer instance
  //   UA.Renderer.createNoop()             → no-op renderer (for testing)
  //   UA.Renderer.assertInterface(r)       — throws if required methods missing
  // ----------------------------

  /** Renderer capability flags. */
  const CAPABILITIES = Object.freeze({
    RENDER_2D:  'render2d',
    RENDER_3D:  'render3d',
    RENDER_AR:  'renderAr',
    SNAPSHOT:   'snapshot',
    STREAMING:  'streaming',
    EXPORT:     'export'
  });

  // ---- interface enforcement ----

  const REQUIRED_METHODS = ['render', 'update', 'dispose', 'captureSnapshot'];

  /**
   * Throw if `r` does not implement the required renderer interface.
   *
   * @param {object} r — candidate renderer
   */
  function assertInterface(r) {
    if (!r || typeof r !== 'object') {
      throw new Error('Renderer.assertInterface: expected a renderer object');
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof r[method] !== 'function') {
        throw new Error(
          'Renderer.assertInterface: missing required method "' + method + '"'
        );
      }
    }
  }

  // ---- public API ----

  UA.Renderer = {

    CAPABILITIES: CAPABILITIES,

    /**
     * Create a renderer instance by wrapping a user-supplied implementation
     * object.  The implementation must provide all four required methods.
     * The returned object is a sealed object with the renderer interface plus
     * a `name` and `capabilities` field.
     *
     * @param {string}   name         — human-readable renderer name
     * @param {object}   impl         — implementation object with render/update/dispose/captureSnapshot
     * @param {string[]} [caps]       — optional list of CAPABILITIES this renderer supports
     * @returns {Renderer}
     */
    create: function createRenderer(name, impl, caps) {
      if (!name) throw new Error('Renderer.create: name is required');
      assertInterface(impl);
      return Object.assign({}, impl, {
        name:         String(name),
        capabilities: Object.freeze(new Set(Array.isArray(caps) ? caps : []))
      });
    },

    /**
     * Create a no-op renderer that records all calls but performs no output.
     * Useful for testing pipeline code that expects a renderer object.
     *
     * @returns {Renderer}
     */
    createNoop: function createNoopRenderer() {
      const calls = [];
      return {
        name:         'NoopRenderer',
        capabilities: Object.freeze(new Set()),
        _calls:       calls,

        render: function render(sceneGraph) {
          calls.push({ method: 'render', args: [sceneGraph] });
          return Promise.resolve();
        },

        update: function update(sceneGraph) {
          calls.push({ method: 'update', args: [sceneGraph] });
          return Promise.resolve();
        },

        dispose: function dispose() {
          calls.push({ method: 'dispose', args: [] });
        },

        captureSnapshot: function captureSnapshot() {
          calls.push({ method: 'captureSnapshot', args: [] });
          return Promise.resolve('data:image/png;base64,');
        }
      };
    },

    /**
     * Assert that a renderer object implements the required interface.
     * Throws a descriptive error if any required method is missing.
     *
     * @param {object} r
     */
    assertInterface: assertInterface
  };

})();
