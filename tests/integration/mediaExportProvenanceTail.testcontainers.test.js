/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildEncodedInspectionArgs } = require('../../server/video-export');

const WIDTH = 96;
const HEIGHT = 64;
const FRAME_COUNT = 32;
const BADGE = {
  sourceWidth: WIDTH,
  sourceHeight: HEIGHT,
  rect: { x: 8, y: 40, width: 80, height: 20 },
  borderColor: [255, 193, 7],
  backgroundColor: [0, 77, 64],
};
let directory;
let previousPath;
let previousWrapper;

function runCodec(args, options = {}) {
  const result = spawnSync('ffmpeg', args, {
    env: process.env, maxBuffer: 8 * 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Real animation codec failed: ${result.error || result.stderr.toString()}`);
  }
  return result.stdout;
}

function animationPixels(withBadge) {
  const frames = Buffer.alloc(WIDTH * HEIGHT * 3 * FRAME_COUNT);
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        let color = [40 + frame % 10, 80, 200 + frame % 20];
        if (withBadge && frame >= FRAME_COUNT - 2 &&
            x >= 8 && x < 88 && y >= 40 && y < 60) {
          color = x < 11 || x >= 85 || y < 43 || y >= 57
            ? BADGE.borderColor : BADGE.backgroundColor;
        }
        const offset = ((frame * HEIGHT + y) * WIDTH + x) * 3;
        frames.set(color, offset);
      }
    }
  }
  return frames;
}

function writeAnimation(format, withBadge) {
  const output = path.join(directory, `${format}-${withBadge ? 'late-badge' : 'unbadged'}.${format}`);
  const codec = format === 'webp'
    ? ['-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0']
    : format === 'apng' ? ['-f', 'apng', '-plays', '0'] : ['-loop', '0'];
  runCodec([
    '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${WIDTH}x${HEIGHT}`, '-r', '1', '-i', 'pipe:0',
    '-frames:v', String(FRAME_COUNT), ...codec, output,
  ], { input: animationPixels(withBadge) });
  return output;
}


function inspectBadge(artifact, evidence) {
  // A standalone Node process uses the real child-process environment and the
  // same codec wrapper as the production server, without Jest module mocks.
  const script = `
    require('./server/video-export-filters');
    const { verifyEncodedSourceBadge } = require('./server/media-export-provenance');
    verifyEncodedSourceBadge(${JSON.stringify(artifact)}, ${JSON.stringify(BADGE)}, ${JSON.stringify(evidence)})
      .then(result => process.stdout.write(JSON.stringify({ result })))
      .catch(error => process.stdout.write(JSON.stringify({ code: error.code, details: error.details })));
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'), env: process.env, encoding: 'utf8',
  });
  if (child.error || child.status !== 0) {
    throw new Error(`Real provenance verification failed: ${child.error || child.stderr}`);
  }
  return JSON.parse(child.stdout);
}

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-real-provenance-tail-'));
  const codecDirectory = path.join(directory, 'bin');
  fs.mkdirSync(codecDirectory);
  const executable = path.join(codecDirectory, 'ffmpeg');
  // Exercise the production wrapper even when checkout executable bits differ.
  fs.writeFileSync(executable, '#!/bin/sh\nexec /bin/bash "$UNFALLATLAS_TEST_CODEC_WRAPPER" "$@"\n');
  fs.chmodSync(executable, 0o755);
  previousPath = process.env.PATH;
  previousWrapper = process.env.UNFALLATLAS_TEST_CODEC_WRAPPER;
  process.env.PATH = `${codecDirectory}${path.delimiter}${previousPath}`;
  process.env.UNFALLATLAS_TEST_CODEC_WRAPPER = path.resolve(__dirname, '../../bin/ffmpeg');
});

afterAll(() => {
  process.env.PATH = previousPath;
  if (previousWrapper === undefined) delete process.env.UNFALLATLAS_TEST_CODEC_WRAPPER;
  else process.env.UNFALLATLAS_TEST_CODEC_WRAPPER = previousWrapper;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe.each(['gif', 'apng', 'webp'])('real %s provenance tail', format => {
  test('finds a badge present only in the final two frames after 1-fps full-frame inspection', () => {
    const artifact = writeAnimation(format, true);
    const inspected = runCodec(buildEncodedInspectionArgs(artifact));
    const evidence = { width: WIDTH, height: HEIGHT, frameCount: inspected.length / (WIDTH * HEIGHT * 4) };
    expect(evidence.frameCount).toBe(FRAME_COUNT);

    const { result, code } = inspectBadge(artifact, evidence);
    expect(code).toBeUndefined();
    expect(result.verified).toBe(true);
    expect(result.frameCount).toBe(8);
    expect(result.sampling).toEqual({ mode: 'tail', fps: 1, maxFrames: 8 });
    expect(result).not.toHaveProperty('sampleStartSeconds');
    expect(result.maxBorderPixels).toBeGreaterThanOrEqual(result.requiredBorderPixels);
    expect(result.maxBackgroundPixels).toBeGreaterThanOrEqual(result.requiredBackgroundPixels);
  });

  test('rejects an animation that never contains the provenance badge', () => {
    const artifact = writeAnimation(format, false);
    expect(inspectBadge(artifact, {
      width: WIDTH, height: HEIGHT, frameCount: FRAME_COUNT,
    })).toMatchObject({ code: 'source_badge_not_encoded' });
  });
});
