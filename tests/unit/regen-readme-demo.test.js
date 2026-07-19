'use strict';

const { chooseDemoAsset, assertAnimatedShape } = require('../../scripts/regen-readme-demo.js');

function gifBuffer(size = 32) {
  const b = Buffer.alloc(size, 0);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(720, 6);
  b.writeUInt16LE(405, 8);
  b[13] = 0x2C;
  b[14] = 0x2C;
  b[b.length - 1] = 0x3B;
  return b;
}

function webpBuffer(size = 64) {
  const b = Buffer.alloc(size, 0);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.write('ANIM', 24, 'ascii');
  return b;
}

describe('scripts/regen-readme-demo', () => {
  test('assertAnimatedShape validates gif/webp formats', () => {
    expect(() => assertAnimatedShape(gifBuffer(), 'gif')).not.toThrow();
    expect(() => assertAnimatedShape(webpBuffer(), 'webp')).not.toThrow();
  });

  test('chooseDemoAsset keeps gif when within budget', async () => {
    const fetchExportFn = jest.fn(async (_baseUrl, format) => {
      if (format === 'gif') return gifBuffer(64);
      throw new Error('fallback should not be called');
    });
    const out = await chooseDemoAsset('http://example.test', {
      gifBudgetBytes: 80,
      fetchExportFn,
    });
    expect(out.format).toBe('gif');
    expect(fetchExportFn).toHaveBeenCalledTimes(1);
  });

  test('chooseDemoAsset fails before mutation instead of silently changing the canonical format', async () => {
    const fetchExportFn = jest.fn(async (_baseUrl, format) => {
      if (format === 'gif') return gifBuffer(128);
      throw new Error('unexpected format');
    });
    await expect(chooseDemoAsset('http://example.test', {
      gifBudgetBytes: 80,
      fetchExportFn,
    })).rejects.toThrow(/automatic format fallback is disabled.*no files were changed/i);
    expect(fetchExportFn.mock.calls.map((c) => c[1])).toEqual(['gif']);
  });

  test('chooseDemoAsset enforces the manifest dimensions', async () => {
    await expect(chooseDemoAsset('http://example.test', {
      gifBudgetBytes: 1024,
      expectedDimensions: { width: 1280, height: 640 },
      fetchExportFn: async () => gifBuffer(64),
    })).rejects.toThrow(/do not match manifest target.*no files were changed/i);
  });
});
