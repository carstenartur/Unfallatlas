'use strict';

const fs = require('fs');
const path = require('path');

function loadScheduleViewportUpdate(win) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.app_v2.js'), 'utf8');
  const start = source.indexOf('UA.scheduleViewportUpdate =');
  const end = source.indexOf('\n  async function writeClipboard', start);
  if (start < 0 || end < 0) throw new Error('scheduleViewportUpdate source block not found');
  const block = source.slice(start, end);
  (function (window) {
    const UA = window.UA; // eslint-disable-line no-shadow
    eval(block); // eslint-disable-line no-eval
  })(win);
}

describe('ua.app_v2 viewport scheduling', () => {
  test('an empty tiled viewport still dispatches movement so another tile can load', () => {
    const dispatch = jest.fn();
    const win = { UA: {} };
    loadScheduleViewportUpdate(win);

    win.UA.scheduleViewportUpdate({
      accidentDataMode: 'viewport',
      allPts: [],
      store: { dispatch },
    }, false);

    expect(dispatch).toHaveBeenCalledWith('viewportChanged', { debounceMs: 350 });
  });

  test('an empty full-city data set keeps the legacy no-op behavior', () => {
    const dispatch = jest.fn();
    const win = { UA: {} };
    loadScheduleViewportUpdate(win);

    win.UA.scheduleViewportUpdate({
      accidentDataMode: 'full',
      allPts: [],
      store: { dispatch },
    }, false);

    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a non-empty full-city data set continues to dispatch through MapStore', () => {
    const dispatch = jest.fn();
    const win = { UA: {} };
    loadScheduleViewportUpdate(win);

    win.UA.scheduleViewportUpdate({
      accidentDataMode: 'full',
      allPts: [{ lat: 50.73, lon: 7.1 }],
      store: { dispatch },
    }, true);

    expect(dispatch).toHaveBeenCalledWith('viewportChanged', { debounceMs: 350 });
  });
});
