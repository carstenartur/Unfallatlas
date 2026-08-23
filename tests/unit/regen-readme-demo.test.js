'use strict';

const { chooseDemoAsset, assertAnimatedShape } = require('../../scripts/regen-readme-demo.js');
const { capGifDuration, parseGifTimeline } = require('../../scripts/gif-timeline.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function packCodes(codes, codeSize = 3) {
  const bytes = Buffer.alloc(Math.ceil(codes.length * codeSize / 8));
  let bitOffset = 0;
  for (const code of codes) {
    for (let bit = 0; bit < codeSize; bit += 1) {
      if (code & (1 << bit)) bytes[(bitOffset + bit) >>> 3] |= 1 << ((bitOffset + bit) & 7);
    }
    bitOffset += codeSize;
  }
  return bytes;
}

function asSubBlocks(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.subarray(offset, Math.min(offset + 255, data.length));
    blocks.push(Buffer.from([chunk.length]), chunk);
  }
  blocks.push(Buffer.from([0]));
  return Buffer.concat(blocks);
}

function encodePixels(pixels) {
  const codes = [];
  for (const pixel of pixels) codes.push(4, pixel);
  codes.push(5);
  return packCodes(codes);
}

function gifBuffer({
  width = 2,
  height = 2,
  frameWidth = width,
  frameHeight = height,
  delays = [2, 2],
  pixels = null,
  transparentIndices = [],
  framePalettes = [],
  interlacedFrames = [],
  disposals = [],
} = {}) {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80; // two-entry global color table
  const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
  const defaultPixels = delays.map((_delay, index) => new Array(frameWidth * frameHeight).fill(index % 2));
  const framePixels = pixels || defaultPixels;
  const frames = delays.map((delay, index) => {
    const transparentIndex = transparentIndices[index];
    const gcePacked = ((disposals[index] || 0) << 2) | (transparentIndex === undefined ? 0 : 1);
    const gce = Buffer.from([
      0x21, 0xf9, 0x04, gcePacked,
      delay & 0xff, delay >>> 8, transparentIndex || 0, 0x00,
    ]);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(frameWidth, 5);
    descriptor.writeUInt16LE(frameHeight, 7);
    const localPalette = framePalettes[index] ? Buffer.from(framePalettes[index]) : null;
    if (localPalette) descriptor[9] |= 0x80;
    if (interlacedFrames[index]) descriptor[9] |= 0x40;
    const compressed = encodePixels(framePixels[index]);
    return Buffer.concat([
      gce,
      descriptor,
      ...(localPalette ? [localPalette] : []),
      Buffer.from([2]),
      asSubBlocks(compressed),
    ]);
  });
  return Buffer.concat([header, palette, ...frames, Buffer.from([0x3b])]);
}

function firstImageOffset(buffer) {
  return buffer.indexOf(0x2c, 19);
}

describe('scripts/regen-readme-demo', () => {
  test('assertAnimatedShape delegates GIF validation to the full timeline decoder', () => {
    const valid = gifBuffer();
    expect(assertAnimatedShape(valid, 'gif')).toEqual(expect.objectContaining({
      width: 2, height: 2, frames: 2, durationMs: 40,
      visualEvidence: expect.objectContaining({
        valid: true,
        paintedCanvasRatio: 1,
        uniqueCompositedFrames: 2,
        maxChangedPixels: 4,
      }),
    }));

    const descriptorNoise = Buffer.alloc(64, 0x2c);
    descriptorNoise.write('GIF89a', 0, 'ascii');
    descriptorNoise.writeUInt16LE(720, 6);
    descriptorNoise.writeUInt16LE(405, 8);
    descriptorNoise[descriptorNoise.length - 1] = 0x3b;
    expect(() => assertAnimatedShape(descriptorNoise, 'gif')).toThrow(/invalid GIF|color table|graphic-control|image rectangle/i);
    expect(() => assertAnimatedShape(valid, 'webp')).toThrow(/unsupported animation format/i);
  });

  test('chooseDemoAsset keeps a structurally valid GIF inside the explicit manifest budget', async () => {
    const gif = gifBuffer();
    const fetchExportFn = jest.fn(async () => gif);
    const out = await chooseDemoAsset('http://example.test', {
      gifBudgetBytes: gif.length + 1,
      fetchExportFn,
    });
    expect(out.format).toBe('gif');
    expect(fetchExportFn).toHaveBeenCalledTimes(1);
  });

  test('chooseDemoAsset requires an explicit budget and never silently changes format', async () => {
    const gif = gifBuffer();
    const fetchExportFn = jest.fn(async () => gif);
    await expect(chooseDemoAsset('http://example.test', { fetchExportFn }))
      .rejects.toThrow(/explicit positive manifest gifBudgetBytes/i);
    expect(fetchExportFn).not.toHaveBeenCalled();

    await expect(chooseDemoAsset('http://example.test', {
      gifBudgetBytes: gif.length - 1,
      fetchExportFn,
    })).rejects.toThrow(/automatic format fallback is disabled.*no files were changed/i);
  });

  test('chooseDemoAsset enforces the manifest dimensions', async () => {
    const gif = gifBuffer();
    await expect(chooseDemoAsset('http://example.test', {
      gifBudgetBytes: gif.length + 1,
      expectedDimensions: { width: 1280, height: 640 },
      fetchExportFn: async () => gif,
    })).rejects.toThrow(/do not match manifest target.*no files were changed/i);
  });

  test('every image requires a GCE delay of at least 2 cs before the cap early return', () => {
    for (const delay of [0, 1]) {
      const invalid = gifBuffer({ delays: [delay, 2] });
      expect(() => capGifDuration(invalid, 60_000, 'short-delay.gif')).toThrow(/delay of at least 2 centiseconds/i);
    }
    const missing = gifBuffer();
    const gce = missing.indexOf(Buffer.from([0x21, 0xf9]));
    const withoutFirstGce = Buffer.concat([missing.subarray(0, gce), missing.subarray(gce + 8)]);
    expect(() => parseGifTimeline(withoutFirstGce, 'missing-gce.gif')).toThrow(/needs a graphic-control delay/i);
  });

  test('Plain Text Extensions fail closed instead of leaking a GCE to the next image', () => {
    const source = gifBuffer();
    const imageOffset = firstImageOffset(source);
    const plainText = Buffer.from([0x21, 0x01, 0x0c, ...new Array(12).fill(0), 0]);
    const mutated = Buffer.concat([source.subarray(0, imageOffset), plainText, source.subarray(imageOffset)]);
    expect(() => parseGifTimeline(mutated, 'plain-text.gif')).toThrow(/Plain Text Extension is unsupported/i);
  });

  test('malformed sub-blocks, LZW streams and palette indices fail closed', () => {
    const truncated = gifBuffer();
    truncated[firstImageOffset(truncated) + 11] = 0xff;
    expect(() => parseGifTimeline(truncated, 'truncated.gif')).toThrow(/truncated GIF data block/i);

    const missingEnd = gifBuffer();
    missingEnd[firstImageOffset(missingEnd) + 13] = 0;
    expect(() => parseGifTimeline(missingEnd, 'missing-end.gif')).toThrow(/decodes beyond|end code is missing/i);

    expect(() => parseGifTimeline(gifBuffer({ pixels: [[3, 3, 3, 3], [1, 1, 1, 1]] }), 'palette.gif'))
      .toThrow(/palette index 3 outside its color table/i);
  });

  test('rejects tiny image rectangles even when the logical canvas claims demo dimensions', () => {
    const tiny = gifBuffer({
      width: 720,
      height: 405,
      frameWidth: 1,
      frameHeight: 1,
      pixels: [[0], [1]],
    });
    expect(() => assertAnimatedShape(tiny, 'gif')).toThrow(/visual canvas coverage/i);
  });

  test('rejects identical full-canvas frames and transparent index-only changes', () => {
    const identical = gifBuffer({ pixels: [[0, 0, 0, 0], [0, 0, 0, 0]] });
    expect(() => assertAnimatedShape(identical, 'gif')).toThrow(/no visible composited frame diversity/i);

    const transparentChange = gifBuffer({
      pixels: [[0, 0, 0, 0], [1, 1, 1, 1]],
      transparentIndices: [undefined, 1],
    });
    expect(() => assertAnimatedShape(transparentChange, 'gif')).toThrow(/no visible composited frame diversity/i);
  });

  test('uses composed colors, so a palette-only full-canvas change is visible', () => {
    const paletteChange = gifBuffer({
      pixels: [[0, 0, 0, 0], [0, 0, 0, 0]],
      framePalettes: [null, [255, 0, 0, 255, 255, 255]],
    });
    const timeline = assertAnimatedShape(paletteChange, 'gif');
    expect(timeline.visualEvidence.uniqueCompositedFrames).toBe(2);
    expect(timeline.visualEvidence.maxChangedPixels).toBe(4);
  });

  test('deinterlaces indices before compositing and hashing visible frames', () => {
    const first = new Array(8).fill(0);
    const rowMajor = [1, 1, 0, 0, 1, 1, 0, 0];
    const interlacedOrder = [
      ...rowMajor.slice(0, 2),
      ...rowMajor.slice(4, 6),
      ...rowMajor.slice(2, 4),
      ...rowMajor.slice(6, 8),
    ];
    const plain = assertAnimatedShape(gifBuffer({ width: 2, height: 4, pixels: [first, rowMajor] }), 'gif');
    const interlaced = assertAnimatedShape(gifBuffer({
      width: 2,
      height: 4,
      pixels: [first, interlacedOrder],
      interlacedFrames: [false, true],
    }), 'gif');
    expect(interlaced.visualEvidence.compositedFrameDigests)
      .toEqual(plain.visualEvidence.compositedFrameDigests);
  });

  test.each([2, 3])('composites disposal method %i before hashing the next frame', disposal => {
    const timeline = assertAnimatedShape(gifBuffer({
      delays: [2, 2, 2],
      pixels: [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [1, 1, 1, 1],
      ],
      disposals: [1, disposal, 1],
      transparentIndices: [undefined, undefined, 1],
    }), 'gif');
    const digests = timeline.visualEvidence.compositedFrameDigests;
    expect(digests[1]).not.toBe(digests[0]);
    expect(digests[2]).toBe(digests[0]);
  });

  test('rejects digest diversity that changes too little of a large canvas', () => {
    const first = new Array(10_000).fill(0);
    const second = first.slice();
    second[0] = 1;
    const onePixel = gifBuffer({ width: 100, height: 100, pixels: [first, second] });
    expect(() => assertAnimatedShape(onePixel, 'gif')).toThrow(/visible frame change 1 pixels is below required 10/i);
  });

  test('duration capping preserves every frame and leaves the source buffer untouched', () => {
    const source = fs.readFileSync(path.join(ROOT, 'docs/demo.gif'));
    const before = parseGifTimeline(source, 'docs/demo.gif');
    const shortened = capGifDuration(source, 30000, 'docs/demo.gif');
    const after = parseGifTimeline(shortened.buffer, 'shortened demo');

    expect(shortened.changed).toBe(true);
    expect(after.durationMs).toBeLessThanOrEqual(30000);
    expect(after.frames).toBe(before.frames);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(shortened.buffer).toHaveLength(source.length);
    expect(parseGifTimeline(source, 'unchanged source').durationMs).toBe(before.durationMs);

    const permittedChanges = new Set(before.frameDelays.flatMap(delay => [delay.offset, delay.offset + 1]));
    for (let offset = 0; offset < source.length; offset++) {
      if (source[offset] !== shortened.buffer[offset]) expect(permittedChanges.has(offset)).toBe(true);
    }
  });
});
