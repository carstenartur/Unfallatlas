'use strict';

jest.mock('@playwright/test', () => ({ chromium: { launch: jest.fn() } }));

const {
  buildEncodedInspectionArgs,
  buildWebpEncodingArgs,
} = require('../../server/video-export');

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
      '-f', 'webp',
      '-loop', '0',
      '/tmp/output.webp',
    ]));
    expect(args).not.toContain('libwebp');
    expect(args).not.toContain('-vsync');
  });
});
