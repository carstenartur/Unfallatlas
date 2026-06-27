'use strict';

const fs = require('fs');
const path = require('path');

function loadScheduler(extraWin) {
  const win = Object.assign(
    { UA: {}, location: { href: 'http://localhost/' }, requestAnimationFrame: null },
    extraWin || {}
  );
  (function (window) {
    eval(fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.render_scheduler.js'), 'utf8'
    ));
  })(win);
  return win.UA;
}

describe('UA.RenderScheduler', () => {
  let UA;

  beforeEach(() => {
    jest.useFakeTimers();
    UA = loadScheduler();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('create() returns a scheduler object', () => {
    const s = UA.RenderScheduler.create();
    expect(typeof s.schedule).toBe('function');
    expect(typeof s.scheduleRaf).toBe('function');
    expect(typeof s.cancel).toBe('function');
    expect(typeof s.isStale).toBe('function');
  });

  test('schedule() calls renderFn synchronously when delay is 0', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 0 });
    const fn = jest.fn();
    s.schedule(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('schedule() debounces when delay > 0', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 100 });
    const fn = jest.fn();
    s.schedule(fn);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('schedule() with explicit delay overrides default debounce', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 0 });
    const fn = jest.fn();
    s.schedule(fn, 200);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('rapid schedule() calls only fire the last one (debounce)', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 100 });
    const fn = jest.fn();
    s.schedule(fn);
    s.schedule(fn);
    s.schedule(fn);
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('cancel() prevents a pending scheduled call', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 100 });
    const fn = jest.fn();
    s.schedule(fn);
    s.cancel();
    jest.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  test('isStale() returns false for current epoch', () => {
    const s = UA.RenderScheduler.create();
    const ep = s.epoch;
    expect(s.isStale(ep)).toBe(false);
  });

  test('isStale() returns true after a new schedule', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 100 });
    const fn = jest.fn();
    s.schedule(fn);
    const oldEpoch = s.epoch - 1; // epoch before this schedule
    // Schedule again to supersede
    s.schedule(fn);
    expect(s.isStale(oldEpoch)).toBe(true);
  });

  test('isStale() returns true after cancel', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 100 });
    const fn = jest.fn();
    s.schedule(fn);
    const capturedEpoch = s.epoch;
    s.cancel();
    expect(s.isStale(capturedEpoch)).toBe(true);
  });

  test('renderFn receives the epoch as its first argument', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 0 });
    let receivedEpoch = null;
    s.schedule((ep) => { receivedEpoch = ep; });
    expect(receivedEpoch).toBe(s.epoch);
  });

  test('stale scheduled call is dropped when a newer schedule supersedes it', () => {
    const s = UA.RenderScheduler.create({ debounceMs: 50 });
    const calls = [];
    s.schedule(() => calls.push('first'), 50);
    jest.advanceTimersByTime(30);
    // supersede with a new call before the first fires
    s.schedule(() => calls.push('second'), 50);
    jest.advanceTimersByTime(100);
    expect(calls).toEqual(['second']);
  });

  test('scheduleRaf() uses rAF when delay is 0', () => {
    const rafCalls = [];
    const win = Object.assign(
      { UA: {}, location: { href: 'http://localhost/' } },
      { requestAnimationFrame: (cb) => { rafCalls.push(cb); return 1; } }
    );
    (function (window) {
      eval(fs.readFileSync(
        path.resolve(__dirname, '../../js/ua.render_scheduler.js'), 'utf8'
      ));
    })(win);
    const sched = win.UA.RenderScheduler.create({ debounceMs: 0 });
    const fn = jest.fn();
    sched.scheduleRaf(fn, 0);
    expect(rafCalls.length).toBe(1);
    expect(fn).not.toHaveBeenCalled();
    // Invoke the rAF callback
    rafCalls[0]();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('scheduleRaf() cancel uses clearTimeout when rAF is unavailable', () => {
    // Load scheduler with no requestAnimationFrame (falls back to setTimeout)
    const UAnoRaf = loadScheduler({ requestAnimationFrame: undefined });
    const sched = UAnoRaf.RenderScheduler.create({ debounceMs: 0 });
    const fn = jest.fn();
    // scheduleRaf falls back to setTimeout; cancel must use clearTimeout
    sched.scheduleRaf(fn, 0);
    // Supersede — cancel() must clear the pending setTimeout, not call
    // the missing cancelAnimationFrame
    expect(() => sched.cancel()).not.toThrow();
    jest.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });
});
