(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // RenderScheduler
  //
  // Provides deterministic, debounced rendering with epoch-based
  // stale-update cancellation. Multiple rapid calls to schedule()
  // only produce one render (the last one wins). Asynchronous
  // context loads that complete after a newer render has started
  // are automatically dropped via the epoch check.
  //
  // Usage:
  //   const sched = UA.RenderScheduler.create({ debounceMs: 0 });
  //   sched.schedule(() => UA.renderLayers(ctx));          // immediate
  //   sched.schedule(() => UA.renderLayers(ctx), 350);     // 350 ms debounce
  //   sched.scheduleRaf(() => UA.renderLayers(ctx), 350);  // debounce + rAF
  //   sched.cancel();                                       // abort pending
  // ----------------------------

  UA.RenderScheduler = {
    /**
     * Create a new scheduler instance.
     *
     * opts.debounceMs: default debounce delay in milliseconds (default: 0).
     */
    create: function createRenderScheduler(opts) {
      const defaultDebounce = (opts && opts.debounceMs != null)
        ? Math.max(0, Number(opts.debounceMs))
        : 0;

      let epoch = 0;
      let timer = null;
      let rafId = null;

      const _raf = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
        ? window.requestAnimationFrame.bind(window)
        : function (cb) { return setTimeout(cb, 16); };

      const _cancelRaf = (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function')
        ? window.cancelAnimationFrame.bind(window)
        : clearTimeout;

      const _cancelPending = function () {
        if (timer  !== null) { clearTimeout(timer);  timer  = null; }
        if (rafId  !== null) { _cancelRaf(rafId);    rafId  = null; }
      };

      const scheduler = {
        /**
         * Current render epoch. Increments with every schedule/cancel call.
         * Async tasks that captured the epoch before a later schedule can
         * compare against this to detect staleness.
         */
        get epoch() { return epoch; },

        /**
         * Schedule renderFn to run after `delayMs` ms (default: opts.debounceMs).
         * Cancels any previously pending render in this scheduler.
         *
         * renderFn receives the captured epoch as its first argument so it
         * can bail out early if it discovers it is stale.
         */
        schedule: function schedule(renderFn, delayMs) {
          epoch++;
          _cancelPending();
          const myEpoch = epoch;
          const delay = delayMs != null ? Math.max(0, Number(delayMs)) : defaultDebounce;

          if (delay > 0) {
            timer = setTimeout(function () {
              timer = null;
              if (myEpoch !== epoch) return; // stale
              try { renderFn(myEpoch); } catch (e) { console.error('RenderScheduler error:', e); }
            }, delay);
          } else {
            // Synchronous path — still update epoch so any inflight async
            // task that captured an older epoch sees it as stale.
            try { renderFn(myEpoch); } catch (e) { console.error('RenderScheduler error:', e); }
          }
        },

        /**
         * Like schedule() but wraps the final call in requestAnimationFrame
         * so rendering happens on the next paint. Useful for viewport updates
         * where we want to avoid layout thrashing.
         */
        scheduleRaf: function scheduleRaf(renderFn, delayMs) {
          epoch++;
          _cancelPending();
          const myEpoch = epoch;
          const delay = delayMs != null ? Math.max(0, Number(delayMs)) : defaultDebounce;

          const doRaf = function () {
            if (myEpoch !== epoch) return; // stale
            rafId = _raf(function () {
              rafId = null;
              if (myEpoch !== epoch) return; // stale
              try { renderFn(myEpoch); } catch (e) { console.error('RenderScheduler error:', e); }
            });
          };

          if (delay > 0) {
            timer = setTimeout(function () {
              timer = null;
              if (myEpoch !== epoch) return; // stale
              doRaf();
            }, delay);
          } else {
            doRaf();
          }
        },

        /**
         * Abort any pending scheduled render and advance the epoch so that
         * any in-flight async task captures become stale.
         */
        cancel: function cancel() {
          _cancelPending();
          epoch++;
        },

        /**
         * Returns true if testEpoch no longer matches the current epoch,
         * i.e. a newer schedule or cancel has superseded this render.
         */
        isStale: function isStale(testEpoch) {
          return testEpoch !== epoch;
        }
      };

      return scheduler;
    }
  };
})();
