'use strict';

const fs = require('fs');
const path = require('path');

function loadWaitForMapTiles() {
  const source = fs
    .readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8')
    .replace(/\bexport\s+/g, '');
  return new Function(`${source}\nreturn waitForMapTiles;`)();
}

describe('screenshot map-readiness helper', () => {
  const waitForMapTiles = loadWaitForMapTiles();

  test('fails closed when the public UA helper returns false', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        available: true,
        ok: false,
        lifecycle: { status: 'rendering' },
      }),
      waitForFunction: jest.fn(),
      waitForTimeout: jest.fn(),
    };

    await expect(waitForMapTiles(page, 1234)).rejects.toThrow(
      'UA.waitForMapFullyRendered returned false'
    );
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  test('fails closed when the public UA helper throws', async () => {
    const page = {
      evaluate: jest.fn()
        .mockRejectedValueOnce(new Error('context tile failed'))
        .mockResolvedValueOnce({ lifecycle: { status: 'rendering' }, tileImages: 1 }),
      waitForFunction: jest.fn(),
      waitForTimeout: jest.fn(),
    };

    await expect(waitForMapTiles(page, 1234)).rejects.toThrow(
      'UA.waitForMapFullyRendered failed: context tile failed'
    );
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  test('uses the DOM fallback only when the UA API is absent', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({ available: false }),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };

    await expect(waitForMapTiles(page, 1234)).resolves.toBeUndefined();
    expect(page.waitForFunction).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).toHaveBeenCalledWith(250);
  });

  test('requires at least one decoded tile from the UA helper', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../e2e/helpers.js'), 'utf8');
    expect(source).toMatch(/waitForMapFullyRendered\(map,\s*\{[\s\S]*?minTileImages:\s*1/);
  });
});
