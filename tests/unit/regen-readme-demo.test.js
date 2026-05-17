'use strict';

const { chooseDemoAsset, assertAnimatedShape } = require('../../scripts/regen-readme-demo.js');

function gifBuffer(size = 32) {
  const b = Buffer.alloc(size, 0);
  b.write('GIF89a', 0, 'ascii');
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

  test('chooseDemoAsset falls back to webp when gif exceeds budget', async () => {
    const fetchExportFn = jest.fn(async (_baseUrl, format) => {
      if (format === 'gif') return gifBuffer(128);
      if (format === 'webp') return webpBuffer(40);
      throw new Error('unexpected format');
    });
    const out = await chooseDemoAsset('http://example.test', {
      gifBudgetBytes: 80,
      fetchExportFn,
    });
    expect(out.format).toBe('webp');
    expect(fetchExportFn.mock.calls.map((c) => c[1])).toEqual(['gif', 'webp']);
  });
});
