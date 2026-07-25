(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  if (UA.visibleTileReadiness) return;

  const NAME = 'waitForMapFullyRendered';
  const WRAPPED = '_uaVisibleTileReadinessWrapped';
  let hookRecord = null;

  function rectEdges(rect) {
    if (!rect) return null;
    const left = Number(rect.left) || 0;
    const top = Number(rect.top) || 0;
    const width = Number(rect.width) || 0;
    const height = Number(rect.height) || 0;
    return {
      left,
      top,
      right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width,
      bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height,
      width,
      height,
    };
  }

  function intersects(a, b) {
    if (!a || !b) return true;
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }

  function elementIsVisible(element, documentRef, mapRect) {
    if (!element) return false;
    if (typeof element.getBoundingClientRect === 'function') {
      const rect = rectEdges(element.getBoundingClientRect());
      if (!rect || !(rect.width > 0) || !(rect.height > 0) || !intersects(rect, mapRect)) return false;
    }
    if (typeof window.getComputedStyle === 'function') {
      let node = element;
      while (node) {
        const style = window.getComputedStyle(node);
        if (style) {
          const opacity = Number.parseFloat(style.opacity);
          if (style.display === 'none' || style.visibility === 'hidden' ||
              style.visibility === 'collapse' || (Number.isFinite(opacity) && opacity <= 0)) {
            return false;
          }
        }
        if (node === documentRef.documentElement) break;
        node = node.parentElement || null;
      }
    }
    return true;
  }

  function visibleDecodedTiles(minTileImages) {
    const doc = window.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    let images = Array.from(doc.querySelectorAll('.leaflet-map-pane img.leaflet-tile'));
    if (images.length === 0) images = Array.from(doc.querySelectorAll('.leaflet-tile-pane img'));

    const mapContainer = typeof doc.querySelector === 'function'
      ? doc.querySelector('.leaflet-container')
      : null;
    const mapRect = mapContainer && typeof mapContainer.getBoundingClientRect === 'function'
      ? rectEdges(mapContainer.getBoundingClientRect())
      : null;

    images = images.filter(image => elementIsVisible(image, doc, mapRect));
    if (images.length < minTileImages) return false;
    return images.every(image => {
      const className = String(image.className || '');
      return image.complete === true
        && Number(image.naturalWidth) > 0
        && Number(image.naturalHeight) > 0
        && !/\bleaflet-tile-loading\b/.test(className);
    });
  }

  function waitForVisibleDecodedTiles(options, control) {
    const opts = options || {};
    const minTileImages = Math.max(1, Number(opts.minTileImages) || 1);
    const timeoutMs = Math.max(1, Number(opts.timeoutMs) || 30000);
    const stableMs = Math.max(0, Number(opts.tileStableMs) || 0);
    const raf = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : callback => setTimeout(callback, 16);

    return new Promise(resolve => {
      const started = Date.now();
      let stableSince = null;
      const tick = () => {
        if (control && control.cancelled) {
          resolve(false);
          return;
        }
        const now = Date.now();
        if (visibleDecodedTiles(minTileImages)) {
          if (stableSince === null) stableSince = now;
          if (now - stableSince >= stableMs) {
            resolve(true);
            return;
          }
        } else {
          stableSince = null;
        }
        if (now - started >= timeoutMs) {
          resolve(false);
          return;
        }
        raf(tick);
      };
      tick();
    });
  }

  function firstSuccessfulProof(legacy, visible) {
    return new Promise(resolve => {
      let legacyDone = false;
      let visibleDone = false;
      let legacyOk = false;
      let visibleOk = false;
      let settled = false;

      const finishIfPossible = () => {
        if (settled) return;
        if (legacyOk || visibleOk) {
          settled = true;
          resolve(true);
          return;
        }
        if (legacyDone && visibleDone) {
          settled = true;
          resolve(false);
        }
      };

      Promise.resolve(legacy).then(result => {
        legacyDone = true;
        legacyOk = result === true;
        finishIfPossible();
      }, () => {
        legacyDone = true;
        finishIfPossible();
      });
      Promise.resolve(visible).then(result => {
        visibleDone = true;
        visibleOk = result === true;
        finishIfPossible();
      }, () => {
        visibleDone = true;
        finishIfPossible();
      });
    });
  }

  function wrap(original) {
    if (typeof original !== 'function' || original[WRAPPED]) return original;
    const wrapped = function waitForMapFullyRenderedWithVisiblePixels(map, options) {
      const opts = options || {};
      const minTileImages = Math.max(0, Number(opts.minTileImages) || 0);
      if (minTileImages === 0) return original.apply(this, arguments);

      const args = arguments;
      const control = { cancelled: false };
      const legacy = Promise.resolve()
        .then(() => original.apply(this, args))
        .then(result => result === true)
        .catch(() => false);
      const visible = waitForVisibleDecodedTiles(opts, control);
      return firstSuccessfulProof(legacy, visible).then(result => {
        control.cancelled = true;
        return result;
      });
    };
    wrapped[WRAPPED] = true;
    wrapped._original = original;
    return wrapped;
  }

  function install() {
    const descriptor = Object.getOwnPropertyDescriptor(UA, NAME);
    if (hookRecord && descriptor && descriptor.get === hookRecord.getter) return true;

    let value;
    try { value = UA[NAME]; } catch (_) { value = undefined; }
    if (typeof value === 'function') value = wrap(value);

    const record = {
      getter() { return value; },
      setter(next) { value = typeof next === 'function' ? wrap(next) : next; },
    };
    try {
      Object.defineProperty(UA, NAME, {
        configurable: true,
        enumerable: true,
        get: record.getter,
        set: record.setter,
      });
      hookRecord = record;
      return true;
    } catch (_) {
      if (typeof value === 'function') {
        try { UA[NAME] = value; } catch (_) {}
      }
      return false;
    }
  }

  UA.visibleTileReadiness = Object.freeze({
    rectEdges,
    intersects,
    elementIsVisible,
    visibleDecodedTiles,
    waitForVisibleDecodedTiles,
    firstSuccessfulProof,
    install,
  });

  install();
})();
