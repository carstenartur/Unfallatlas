'use strict';

jest.mock('@playwright/test', () => ({ chromium: { launch: jest.fn() } }));

const {
  buildEncodedInspectionArgs,
  buildGifEncodingArgs,
  buildGifPaletteArgs,
  buildWebpEncodingArgs,
  parseWebpDimensions,
} = require('../../server/video-export');
const {
  ANIMATED_IMAGE_FILTER,
  ANIMATED_IMAGE_FPS,
  ANIMATED_IMAGE_WIDTH,
} = require('../../server/video-export-filters');

describe('video export encoding contract', () => {
  test('inspects encoded frames at their probed native dimensions without another scale pass', () => {
    const args = buildEncodedInspectionArgs('/tmp/output.gif');
    expect(args).toEqual([
      '-v', 'error',
      '-i', '/tmp/output.gif',
      '-vf', 'fps=2',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1',
    ]);
    expect(args.join(' ')).not.toMatch(/scale=/);
  });

  test('uses the dedicated animated WebP encoder and an explicit WebP muxer', () => {
    const args = buildWebpEncodingArgs('/tmp/input.webm', '/tmp/output.webp');
    expect(args).toEqual(expect.arrayContaining([
      '-c:v', 'libwebp_anim',
      '-lossless', '1',
      '-f', 'webp',
      '-loop', '0',
      '/tmp/output.webp',
    ]));
    expect(args).not.toContain('libwebp');
    expect(args).not.toContain('-vsync');
  });

  test('aligns output cadence with semantic inspection and preserves the narrow owned context stroke', () => {
    const browserCaptureWidth = 1280;
    const trafficStrokeWidth = 3;
    const projectedStrokeWidth = trafficStrokeWidth * ANIMATED_IMAGE_WIDTH / browserCaptureWidth;

    expect(ANIMATED_IMAGE_FPS).toBe(2);
    expect(ANIMATED_IMAGE_WIDTH).toBe(864);
    expect(projectedStrokeWidth).toBeGreaterThanOrEqual(2);
    expect(ANIMATED_IMAGE_FILTER)
      .toBe(`fps=2,scale=${ANIMATED_IMAGE_WIDTH}:-1:flags=lanczos`);
    expect(buildEncodedInspectionArgs('/tmp/output.webp')).toContain(`fps=${ANIMATED_IMAGE_FPS}`);
  });

  test('uses the full GIF palette without dithering so owned witness colours survive', () => {
    const palette = buildGifPaletteArgs('/tmp/input.webm', '/tmp/palette.png');
    const encoding = buildGifEncodingArgs('/tmp/input.webm', '/tmp/palette.png', '/tmp/output.gif');
    expect(palette).toContain('fps=2,scale=864:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0:stats_mode=full');
    expect(encoding).toContain('fps=2,scale=864:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none');
  });

  test('reads animated WebP canvas dimensions from the RIFF VP8X chunk', () => {
    const buffer = Buffer.alloc(30);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(22, 4);
    buffer.write('WEBP', 8, 'ascii');
    buffer.write('VP8X', 12, 'ascii');
    buffer.writeUInt32LE(10, 16);
    buffer[20] = 0x02;
    buffer.writeUIntLE(719, 24, 3);
    buffer.writeUIntLE(404, 27, 3);
    expect(parseWebpDimensions(buffer)).toEqual({ width: 720, height: 405 });
    expect(parseWebpDimensions(Buffer.from('not-webp'))).toBeNull();
  });
});
