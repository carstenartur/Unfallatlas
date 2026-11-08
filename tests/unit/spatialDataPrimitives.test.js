'use strict';

const grid = require('../../js/ua.spatial-grid');
const budget = require('../../js/ua.data-budget');

test('uses the same slippy grid for bounds, point assignments and crossing multipart geometry', () => {
  const geometry = { type: 'MultiLineString', coordinates: [
    [[9.68, 52.36], [9.74, 52.39]], [[9.67, 52.38], [9.71, 52.37]],
  ] };
  const [west, south, east, north] = grid.geometryBounds(geometry);
  expect([west, south, east, north]).toEqual([9.67, 52.36, 9.74, 52.39]);
  const tiles = grid.tilesForBounds({ west, south, east, north }, 13, { maxTiles: 100 });
  const crossing = [grid.lonToTileX(9.70, 13), grid.latToTileY(52.375, 13)];
  expect(tiles).toContainEqual(crossing);
  expect(grid.intersectsBounds(grid.tileBounds(...crossing, 13), [west, south, east, north])).toBe(true);
  expect(grid.tilesForBounds([south, west, north, east], 13)).toEqual(tiles);
});

test('rejects a huge enumeration before allocating tiles and clamps edge coordinates', () => {
  const bounds = { west: -180, south: -90, east: 180, north: 90 };
  expect(grid.tileRange(bounds, 22).count).toBe(2 ** 44);
  expect(() => grid.tilesForBounds(bounds, 22, { maxTiles: 64 })).toThrow(/tile/i);
  try { grid.tilesForBounds(bounds, 22, { maxTiles: 64 }); }
  catch (error) { expect(error.code).toBe('SPATIAL_TILE_LIMIT'); }
  expect(grid.lonToTileX(180, 13)).toBe(8191);
  expect(grid.latToTileY(90, 13)).toBe(0);
  expect(grid.latToTileY(-90, 13)).toBe(8191);
  expect(grid.tilesForBounds({ west: NaN, east: 1, south: 1, north: 2 }, 13)).toEqual([]);
});

test('a shared scheduler bounds concurrent reads and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const values = await budget.mapLimit([1, 2, 3, 4, 5], 2, async value => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return value * 2;
  });
  expect(values).toEqual([2, 4, 6, 8, 10]);
  expect(peak).toBe(2);
});

test('aborted queued reads do not start and a failed read releases its slot', async () => {
  const scheduler = budget.createScheduler(1);
  let release;
  const first = scheduler.run(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const task = jest.fn();
  const queued = scheduler.run(task, { signal: controller.signal });
  const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejection;
  release('done');
  await expect(first).resolves.toBe('done');
  expect(task).not.toHaveBeenCalled();
  await expect(scheduler.run(() => { throw new Error('bad source'); })).rejects.toThrow('bad source');
  await expect(scheduler.run(() => 7)).resolves.toBe(7);
  expect(scheduler.stats()).toMatchObject({ active: 0, queued: 0 });
});

test('decoded byte cache evicts least recently used values and refuses oversized leaves', () => {
  const cache = budget.createByteCache(10, { maxEntries: 3 });
  cache.set('a', 'first', 4);
  cache.set('b', 'second', 4);
  expect(cache.get('a')).toBe('first');
  cache.set('c', 'third', 4);
  expect(cache.has('b')).toBe(false);
  expect(cache.stats()).toEqual({ bytes: 8, entries: 2, maxBytes: 10 });
  expect(cache.set('huge', {}, 11)).toBe(false);
  expect(cache.has('huge')).toBe(false);
  cache.set('a', 'replacement', 6);
  expect(cache.stats().bytes).toBe(10);
  cache.delete('c');
  expect(cache.stats().bytes).toBe(6);
  cache.clear();
  expect(cache.stats().bytes).toBe(0);
});
