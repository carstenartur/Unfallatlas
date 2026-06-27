'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  loadModule('../../js/ua.renderer.js', win);
  return win.UA;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UA.Renderer', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  // -------------------------------------------------------------------------
  describe('CAPABILITIES', () => {
    test('exposes all expected capability constants', () => {
      const C = UA.Renderer.CAPABILITIES;
      expect(C.RENDER_2D).toBe('render2d');
      expect(C.RENDER_3D).toBe('render3d');
      expect(C.RENDER_AR).toBe('renderAr');
      expect(C.SNAPSHOT).toBe('snapshot');
      expect(C.STREAMING).toBe('streaming');
      expect(C.EXPORT).toBe('export');
    });

    test('CAPABILITIES object is frozen', () => {
      expect(Object.isFrozen(UA.Renderer.CAPABILITIES)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('assertInterface', () => {
    test('does not throw for a valid renderer object', () => {
      const impl = {
        render:          () => {},
        update:          () => {},
        dispose:         () => {},
        captureSnapshot: () => {}
      };
      expect(() => UA.Renderer.assertInterface(impl)).not.toThrow();
    });

    test('throws when renderer is null', () => {
      expect(() => UA.Renderer.assertInterface(null)).toThrow('renderer object');
    });

    test('throws when render method is missing', () => {
      const impl = { update: () => {}, dispose: () => {}, captureSnapshot: () => {} };
      expect(() => UA.Renderer.assertInterface(impl)).toThrow('render');
    });

    test('throws when update method is missing', () => {
      const impl = { render: () => {}, dispose: () => {}, captureSnapshot: () => {} };
      expect(() => UA.Renderer.assertInterface(impl)).toThrow('update');
    });

    test('throws when dispose method is missing', () => {
      const impl = { render: () => {}, update: () => {}, captureSnapshot: () => {} };
      expect(() => UA.Renderer.assertInterface(impl)).toThrow('dispose');
    });

    test('throws when captureSnapshot method is missing', () => {
      const impl = { render: () => {}, update: () => {}, dispose: () => {} };
      expect(() => UA.Renderer.assertInterface(impl)).toThrow('captureSnapshot');
    });
  });

  // -------------------------------------------------------------------------
  describe('create', () => {
    const baseImpl = () => ({
      render:          jest.fn(() => Promise.resolve()),
      update:          jest.fn(() => Promise.resolve()),
      dispose:         jest.fn(),
      captureSnapshot: jest.fn(() => Promise.resolve('data:image/png;base64,'))
    });

    test('throws when name is missing', () => {
      expect(() => UA.Renderer.create('', baseImpl())).toThrow('name');
    });

    test('throws when impl is missing a required method', () => {
      const impl = baseImpl();
      delete impl.render;
      expect(() => UA.Renderer.create('TestRenderer', impl)).toThrow('render');
    });

    test('returns a renderer with the given name', () => {
      const r = UA.Renderer.create('TestRenderer', baseImpl());
      expect(r.name).toBe('TestRenderer');
    });

    test('returns a renderer with an empty capabilities set when caps is omitted', () => {
      const r = UA.Renderer.create('TestRenderer', baseImpl());
      expect(r.capabilities.size).toBe(0);
    });

    test('returns a renderer with the provided capabilities', () => {
      const r = UA.Renderer.create('TestRenderer', baseImpl(), ['render2d', 'snapshot']);
      expect(r.capabilities.has('render2d')).toBe(true);
      expect(r.capabilities.has('snapshot')).toBe(true);
    });

    test('capabilities set is frozen', () => {
      const r = UA.Renderer.create('TestRenderer', baseImpl(), ['render2d']);
      expect(Object.isFrozen(r.capabilities)).toBe(true);
    });

    test('delegates render() to the implementation', async () => {
      const impl = baseImpl();
      const r    = UA.Renderer.create('TestRenderer', impl);
      const sg   = { nodes: [] };
      await r.render(sg);
      expect(impl.render).toHaveBeenCalledWith(sg);
    });

    test('delegates dispose() to the implementation', () => {
      const impl = baseImpl();
      const r    = UA.Renderer.create('TestRenderer', impl);
      r.dispose();
      expect(impl.dispose).toHaveBeenCalled();
    });

    test('delegates captureSnapshot() to the implementation', async () => {
      const impl = baseImpl();
      const r    = UA.Renderer.create('TestRenderer', impl);
      const url  = await r.captureSnapshot();
      expect(impl.captureSnapshot).toHaveBeenCalled();
      expect(url).toBe('data:image/png;base64,');
    });
  });

  // -------------------------------------------------------------------------
  describe('createNoop', () => {
    test('returns an object implementing the renderer interface', () => {
      const r = UA.Renderer.createNoop();
      expect(typeof r.render).toBe('function');
      expect(typeof r.update).toBe('function');
      expect(typeof r.dispose).toBe('function');
      expect(typeof r.captureSnapshot).toBe('function');
    });

    test('name is NoopRenderer', () => {
      const r = UA.Renderer.createNoop();
      expect(r.name).toBe('NoopRenderer');
    });

    test('render() resolves immediately', async () => {
      const r = UA.Renderer.createNoop();
      await expect(r.render({ nodes: [] })).resolves.toBeUndefined();
    });

    test('update() resolves immediately', async () => {
      const r = UA.Renderer.createNoop();
      await expect(r.update({ nodes: [] })).resolves.toBeUndefined();
    });

    test('captureSnapshot() resolves to a data URL', async () => {
      const r   = UA.Renderer.createNoop();
      const url = await r.captureSnapshot();
      expect(url).toBe('data:image/png;base64,');
    });

    test('records all method calls in _calls', async () => {
      const r  = UA.Renderer.createNoop();
      const sg = { nodes: [] };
      await r.render(sg);
      await r.update(sg);
      r.dispose();
      await r.captureSnapshot();
      expect(r._calls).toHaveLength(4);
      expect(r._calls[0].method).toBe('render');
      expect(r._calls[1].method).toBe('update');
      expect(r._calls[2].method).toBe('dispose');
      expect(r._calls[3].method).toBe('captureSnapshot');
    });

    test('passes correct arguments to _calls', async () => {
      const r  = UA.Renderer.createNoop();
      const sg = { nodes: [{ id: 'x' }] };
      await r.render(sg);
      expect(r._calls[0].args[0]).toBe(sg);
    });
  });
});
