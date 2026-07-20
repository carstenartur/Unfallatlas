#!/usr/bin/env bash
set -euo pipefail

BRANCH=split/405-5-video-export-contract
EXPECTED=9b6fdca477b3c3fc2666957e68bbfe29157788e6

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

old = """const WEBP_QUALITY = 60;
const VIDEO_TILE_STABLE_MS = 800;
const ENCODED_INSPECTION_FPS = 2;
"""
new = """const WEBP_QUALITY = 60;
const GIF_MAX_COLORS = 256;
const VIDEO_TILE_STABLE_MS = 800;
const ENCODED_INSPECTION_FPS = 2;
"""
if s.count(old) != 1:
    raise SystemExit('codec constant insertion point not found exactly once')
s = s.replace(old, new)

old = """function buildWebpEncodingArgs(webmPath, outputPath) {
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
"""
new = """function buildGifPaletteArgs(webmPath, palettePath) {
  return [
    '-y',
    '-ss', '1',
    '-i', webmPath,
    '-vf', `${ANIMATED_IMAGE_FILTER},palettegen=max_colors=${GIF_MAX_COLORS}:reserve_transparent=0:stats_mode=full`,
    palettePath,
  ];
}

function buildGifEncodingArgs(webmPath, palettePath, outputPath) {
  return [
    '-y',
    '-ss', '1',
    '-i', webmPath,
    '-i', palettePath,
    '-lavfi', `${ANIMATED_IMAGE_FILTER}[x];[x][1:v]paletteuse=dither=none`,
    outputPath,
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

function parseWebpDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 ||
      buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  const declaredLength = buffer.readUInt32LE(4) + 8;
  if (declaredLength > buffer.length) return null;
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const end = dataStart + length;
    if (end > declaredLength) return null;
    const data = buffer.subarray(dataStart, end);
    if (type === 'VP8X' && length >= 10) {
      return {
        width: 1 + data.readUIntLE(4, 3),
        height: 1 + data.readUIntLE(7, 3),
      };
    }
    if (type === 'VP8 ' && length >= 10 &&
        data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      return {
        width: data.readUInt16LE(6) & 0x3fff,
        height: data.readUInt16LE(8) & 0x3fff,
      };
    }
    if (type === 'VP8L' && length >= 5 && data[0] === 0x2f) {
      const bits = data.readUInt32LE(1);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
    offset = end + (length % 2);
  }
  return null;
}

function validEncodedDimensions(dimensions) {
  const width = Number(dimensions && dimensions.width);
  const height = Number(dimensions && dimensions.height);
  return Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && height > 0 && width <= 4096 && height <= 4096;
}

async function probeEncodedDimensions(outputPath) {
"""
if s.count(old) != 1:
    raise SystemExit('codec helper insertion point not found exactly once')
s = s.replace(old, new)

old = """  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
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
"""
new = """  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  const probed = { width: Number(stream && stream.width), height: Number(stream && stream.height) };
  if (validEncodedDimensions(probed)) return probed;

  const containerDimensions = parseWebpDimensions(fs.readFileSync(outputPath));
  if (validEncodedDimensions(containerDimensions)) return containerDimensions;

  throw new VideoExportSemanticError(
    'encoded_frame_probe_invalid',
    `Encoded animation has invalid dimensions ${probed.width}x${probed.height}`
  );
}
"""
if s.count(old) != 1:
    raise SystemExit('dimension validation block not found exactly once')
s = s.replace(old, new)

old = """    if (format === 'gif') {
      const palettePath = path.join(tmpDir, 'palette.png');
      // Schritt 1: Palette erzeugen (async, damit der Event-Loop nicht blockiert)
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', '1',
        '-i', webmPath,
        '-vf', `${ANIMATED_IMAGE_FILTER},palettegen=max_colors=96:stats_mode=diff`,
        palettePath
      ], { timeout: FFMPEG_TIMEOUT_MS });

      // Schritt 2: GIF mit Palette erzeugen (async)
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', '1',
        '-i', webmPath,
        '-i', palettePath,
        '-lavfi', `${ANIMATED_IMAGE_FILTER}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
        outputPath
      ], { timeout: FFMPEG_TIMEOUT_MS });
"""
new = """    if (format === 'gif') {
      const palettePath = path.join(tmpDir, 'palette.png');
      // A full 256-colour palette and non-dithered lookup keep the small,
      // coordinate-bound semantic witness colours stable enough for strict
      // post-encoding verification.
      await execFileAsync(
        'ffmpeg',
        buildGifPaletteArgs(webmPath, palettePath),
        { timeout: FFMPEG_TIMEOUT_MS }
      );
      await execFileAsync(
        'ffmpeg',
        buildGifEncodingArgs(webmPath, palettePath, outputPath),
        { timeout: FFMPEG_TIMEOUT_MS }
      );
"""
if s.count(old) != 1:
    raise SystemExit('GIF encoder block not found exactly once')
s = s.replace(old, new)

old = """  buildEncodedInspectionArgs,
  buildWebpEncodingArgs,
"""
new = """  buildEncodedInspectionArgs,
  buildGifEncodingArgs,
  buildGifPaletteArgs,
  buildWebpEncodingArgs,
"""
if s.count(old) != 1:
    raise SystemExit('builder export block not found exactly once')
s = s.replace(old, new)

old = """  installSemanticEvidenceBadge,
  probeEncodedDimensions,
"""
new = """  installSemanticEvidenceBadge,
  parseWebpDimensions,
  probeEncodedDimensions,
"""
if s.count(old) != 1:
    raise SystemExit('WebP parser export block not found exactly once')
s = s.replace(old, new)

p.write_text(s)

p = Path('tests/unit/videoExportEncodingContract.test.js')
s = p.read_text()
s = s.replace(
"""  buildEncodedInspectionArgs,
  buildWebpEncodingArgs,
""",
"""  buildEncodedInspectionArgs,
  buildGifEncodingArgs,
  buildGifPaletteArgs,
  buildWebpEncodingArgs,
  parseWebpDimensions,
"""
)
insert = """

  test('uses the full GIF palette without dithering so owned witness colours survive', () => {
    const palette = buildGifPaletteArgs('/tmp/input.webm', '/tmp/palette.png');
    const encoding = buildGifEncodingArgs('/tmp/input.webm', '/tmp/palette.png', '/tmp/output.gif');
    expect(palette).toContain('fps=3,scale=720:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0:stats_mode=full');
    expect(encoding).toContain('fps=3,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none');
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
"""
marker = "\n});\n"
if not s.endswith(marker):
    raise SystemExit('encoding test suite end not found')
s = s[:-len(marker)] + insert + marker
p.write_text(s)
PY

npx jest tests/unit/videoExportEncodingContract.test.js tests/unit/videoExportReadiness.test.js --runInBand
git add server/video-export.js tests/unit/videoExportEncodingContract.test.js
git diff --cached --check
git commit -m "fix: preserve GIF witnesses and probe animated WebP"
git push --force-with-lease="refs/heads/$BRANCH:$EXPECTED" origin "HEAD:refs/heads/$BRANCH"
