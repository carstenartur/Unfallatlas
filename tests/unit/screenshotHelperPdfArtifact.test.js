'use strict';

const fs = require('fs');
const path = require('path');

function loadAssertStableScreenshotSnapshot() {
  const source = fs
    .readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8')
    .replace(/\bexport\s+/g, '');
  return new Function(`${source}\nreturn assertStableScreenshotSnapshot;`)();
}

function makeSnapshot(revision = 2) {
  return {
    status: 'ready',
    city: 'Bonn',
    counts: { loaded: 5, filtered: 4, viewport: 3 },
    coverage: { complete: true },
    render: {
      revision,
      completedRevision: revision,
      submitted: true,
      layers: { cluster: { requested: true, complete: true, visible: 3 } },
    },
  };
}

describe('detached PDF screenshot lifecycle evidence', () => {
  const assertStableScreenshotSnapshot = loadAssertStableScreenshotSnapshot();
  const criteria = { city: 'Bonn', layers: ['cluster'] };
  const label = 'docs/screenshots/15-export-pdf-rendered.png';

  test('accepts a later live-map render revision that cannot alter immutable PDF pixels', () => {
    expect(() => assertStableScreenshotSnapshot(
      makeSnapshot(2),
      makeSnapshot(3),
      criteria,
      label
    )).not.toThrow();
  });

  test('still rejects data changes while detached PDF pixels are captured', () => {
    const changed = makeSnapshot(3);
    changed.counts.viewport = 2;
    expect(() => assertStableScreenshotSnapshot(
      makeSnapshot(2),
      changed,
      criteria,
      label
    )).toThrow('lifecycle changed while pixels were captured');
  });
});
