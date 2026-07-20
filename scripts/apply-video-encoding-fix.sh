#!/usr/bin/env bash
set -euo pipefail

REPO=carstenartur/Unfallatlas
BRANCH=split/405-5-video-export-contract
EXPECTED=feab6357e40c74ba75ad70b550c2e5a6df09e73b

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin "$BRANCH"
ACTUAL=$(git rev-parse "origin/$BRANCH")
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo "Unexpected #440 head: $ACTUAL" >&2; exit 1; }
git checkout -B "$BRANCH" "$ACTUAL"

python3 <<'PY'
from pathlib import Path

p = Path('server/video-export.js')
s = p.read_text()

old = """const FFMPEG_TIMEOUT_MS = 120_000; // 2 minutes max for each ffmpeg step
const WEBP_QUALITY = 60;
const VIDEO_TILE_STABLE_MS = 800;
"""
new = """const FFMPEG_TIMEOUT_MS = 120_000; // 2 minutes max for each ffmpeg step
const WEBP_QUALITY = 60;
const VIDEO_TILE_STABLE_MS = 800;
const ENCODED_INSPECTION_FPS = 2;
const MAX_DECODE_BUFFER_BYTES = 256 * 1024 * 1024;
"""
if s.count(old) != 1:
    raise SystemExit('encoder constants block not found exactly once')
s = s.replace(old, new)

old = """async function inspectEncodedFrames(outputPath, requiredState, frameEvidence) {
  const width = 360;
  const height = 202;
  const { stdout } = await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-i', outputPath,
    '-vf', `fps=1,scale=${width}:${height}:flags=lanczos`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1',
  ], {
    timeout: FFMPEG_TIMEOUT_MS,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return countPalettePixels(Buffer.from(stdout), width, height, requiredState, frameEvidence);
}
"""
new = """function buildEncodedInspectionArgs(outputPath) {
  return [
    '-v', 'error',
    '-i', outputPath,
    '-vf', `fps=${ENCODED_INSPECTION_FPS}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1',
  ];
}

function buildWebpEncodingArgs(webmPath, outputPath) {
  return [
    '-y',
    '-i', webmPath,
    '-vf', ANIMATED_IMAGE_FILTER,
    '-loop', '0',
    '-c:v', 'libwebp_anim',
    '-lossless', '0',
    '-q:v', String(WEBP_QUALITY),
    '-compression_level', '6',
    '-an',
    '-f', 'webp',
    outputPath,
  ];
}

async function probeEncodedDimensions(outputPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    outputPath,
  ], {
    timeout: FFMPEG_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch (error) {
    throw new VideoExportSemanticError(
      'encoded_frame_probe_invalid',
      `Could not parse encoded-frame dimensions: ${error.message}`
    );
  }
  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  const width = Number(stream && stream.width);
  const height = Number(stream && stream.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new VideoExportSemanticError(
      'encoded_frame_probe_invalid',
      `Encoded animation has invalid dimensions ${width}x${height}`
    );
  }
  return { width, height };
}

async function inspectEncodedFrames(outputPath, requiredState, frameEvidence) {
  const { width, height } = await probeEncodedDimensions(outputPath);
  const { stdout } = await execFileAsync(
    'ffmpeg',
    buildEncodedInspectionArgs(outputPath),
    {
      timeout: FFMPEG_TIMEOUT_MS,
      encoding: 'buffer',
      maxBuffer: MAX_DECODE_BUFFER_BYTES,
    }
  );
  return countPalettePixels(Buffer.from(stdout), width, height, requiredState, frameEvidence);
}
"""
if s.count(old) != 1:
    raise SystemExit('encoded inspection block not found exactly once')
s = s.replace(old, new)

old = """    } else if (format === 'webp') {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', webmPath,
        '-vf', ANIMATED_IMAGE_FILTER,
        '-loop', '0',
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', String(WEBP_QUALITY),
        '-compression_level', '6',
        '-preset', 'picture',
        '-an',
        '-vsync', '0',
        outputPath
      ], { timeout: FFMPEG_TIMEOUT_MS });
"""
new = """    } else if (format === 'webp') {
      await execFileAsync(
        'ffmpeg',
        buildWebpEncodingArgs(webmPath, outputPath),
        { timeout: FFMPEG_TIMEOUT_MS }
      );
"""
if s.count(old) != 1:
    raise SystemExit('WebP encoder block not found exactly once')
s = s.replace(old, new)

old = """module.exports = {
  ANIMATED_IMAGE_FILTER,
  VideoExportSemanticError,
"""
new = """module.exports = {
  ANIMATED_IMAGE_FILTER,
  VideoExportSemanticError,
  buildEncodedInspectionArgs,
  buildWebpEncodingArgs,
"""
if s.count(old) != 1:
    raise SystemExit('module exports insertion point not found exactly once')
s = s.replace(old, new)

old = """  inspectEncodedFrames,
  installSemanticEvidenceBadge,
"""
new = """  inspectEncodedFrames,
  installSemanticEvidenceBadge,
  probeEncodedDimensions,
"""
if s.count(old) != 1:
    raise SystemExit('probe export insertion point not found exactly once')
s = s.replace(old, new)

p.write_text(s)

Path('tests/unit/videoExportEncodingContract.test.js').write_text("""'use strict';

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
""")
PY

npx jest tests/unit/videoExportEncodingContract.test.js tests/unit/videoExportReadiness.test.js --runInBand
git add server/video-export.js tests/unit/videoExportEncodingContract.test.js
git diff --cached --check
git commit -m "fix: preserve semantic evidence across animation codecs"
git push --force-with-lease="refs/heads/$BRANCH:$EXPECTED" origin "HEAD:refs/heads/$BRANCH"
