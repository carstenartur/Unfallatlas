#!/usr/bin/env bash
set -euo pipefail

BRANCH=split/405-5-video-export-contract
EXPECTED=5a7b9b86faab62bfff0bcc9c45926cecf69a59a0

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

old = """const MAX_DECODE_BUFFER_BYTES = 256 * 1024 * 1024;

const SERVER_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8000}`;
"""
new = """const MAX_DECODE_BUFFER_BYTES = 256 * 1024 * 1024;
const WEBP_SAMPLE_INTERVAL_US = 500_000;
const CONTEXT_WITNESS_COLORS = Object.freeze({
  slope: Object.freeze([0, 96, 255]),
  // Reuse the codec-stable magenta already reserved by the owned cluster
  // witness. Identity still comes from the separate traffic-road coordinate.
  traffic: Object.freeze([255, 0, 255]),
});

const SERVER_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8000}`;
"""
if s.count(old) != 1:
    raise SystemExit('witness constant insertion point not found exactly once')
s = s.replace(old, new)

old = """    const contextWitnesses = {};
    const contextRegistry = ctx && ctx.contextOverlays || {};
    const contextColors = { slope: [0, 96, 255], traffic: [255, 0, 128] };
    const contextRadii = { slope: 11, traffic: 18 };
"""
new = """    const contextWitnesses = {};
    const contextRegistry = ctx && ctx.contextOverlays || {};
    const contextColors = contextWitnessColors;
    const contextRadii = { slope: 11, traffic: 18 };
"""
if s.count(old) != 1:
    raise SystemExit('context witness color block not found exactly once')
s = s.replace(old, new)

old = """  }, {
    text: label,
    digest: stateSha256,
    requiredLayers: state.layers,
  });
"""
new = """  }, {
    text: label,
    digest: stateSha256,
    requiredLayers: state.layers,
    contextWitnessColors: CONTEXT_WITNESS_COLORS,
  });
"""
if s.count(old) != 1:
    raise SystemExit('semantic badge evaluate argument block not found exactly once')
s = s.replace(old, new)

old = """function parseWebpDimensions(buffer) {
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
"""
new = """function parseAnimatedWebpMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 ||
      buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  const declaredLength = buffer.readUInt32LE(4) + 8;
  if (declaredLength > buffer.length) return null;
  let dimensions = null;
  let hasAnimationHeader = false;
  let frameCount = 0;
  let durationMs = 0;
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const end = dataStart + length;
    if (end > declaredLength) return null;
    const data = buffer.subarray(dataStart, end);
    if (type === 'VP8X' && length >= 10) {
      dimensions = {
        width: 1 + data.readUIntLE(4, 3),
        height: 1 + data.readUIntLE(7, 3),
      };
      hasAnimationHeader = Boolean(data[0] & 0x02);
    } else if (type === 'VP8 ' && length >= 10 &&
        data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a && !dimensions) {
      dimensions = {
        width: data.readUInt16LE(6) & 0x3fff,
        height: data.readUInt16LE(8) & 0x3fff,
      };
    } else if (type === 'VP8L' && length >= 5 && data[0] === 0x2f && !dimensions) {
      const bits = data.readUInt32LE(1);
      dimensions = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    } else if (type === 'ANIM') {
      hasAnimationHeader = true;
    } else if (type === 'ANMF' && length >= 16) {
      frameCount += 1;
      durationMs += data.readUIntLE(12, 3);
    }
    offset = end + (length % 2);
  }
  return dimensions ? {
    ...dimensions,
    animated: hasAnimationHeader && frameCount > 1,
    frameCount,
    durationMs,
  } : null;
}

function parseWebpDimensions(buffer) {
  const metadata = parseAnimatedWebpMetadata(buffer);
  return metadata && { width: metadata.width, height: metadata.height };
}
"""
if s.count(old) != 1:
    raise SystemExit('WebP parser block not found exactly once')
s = s.replace(old, new)

old = """async function inspectEncodedFrames(outputPath, requiredState, frameEvidence) {
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
new = """async function decodeAnimatedWebpFramesWithChromium(outputPath, browser) {
  if (!browser) {
    throw new VideoExportSemanticError(
      'encoded_webp_decoder_unavailable',
      'Animated WebP verification requires the active Chromium instance'
    );
  }
  const artifact = fs.readFileSync(outputPath);
  const metadata = parseAnimatedWebpMetadata(artifact);
  if (!metadata || !metadata.animated || metadata.frameCount < 2 ||
      !validEncodedDimensions(metadata)) {
    throw new VideoExportSemanticError(
      'encoded_webp_metadata_invalid',
      'Animated WebP metadata is incomplete or inconsistent'
    );
  }

  const verificationContext = await browser.newContext();
  const page = await verificationContext.newPage();
  const frames = [];
  try {
    await page.exposeFunction('__uaCollectDecodedWebpFrame', encoded => {
      frames.push(Buffer.from(String(encoded), 'base64'));
    });
    const decoded = await page.evaluate(async ({ base64, intervalUs }) => {
      if (typeof ImageDecoder !== 'function') {
        throw new Error('Chromium ImageDecoder is unavailable');
      }
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const decoder = new ImageDecoder({ data: bytes, type: 'image/webp', preferAnimation: true });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      const sourceFrameCount = Number(track && track.frameCount);
      if (!track || !track.animated || !Number.isInteger(sourceFrameCount) || sourceFrameCount < 2) {
        throw new Error(`Animated WebP track is invalid (frames=${sourceFrameCount})`);
      }
      const canvas = new OffscreenCanvas(1, 1);
      const drawing = canvas.getContext('2d', { willReadFrequently: true });
      let width = 0, height = 0, timestampUs = 0, nextSampleUs = 0, sampledFrames = 0;
      const encodeBase64 = data => {
        let text = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          text += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
        }
        return btoa(text);
      };
      for (let frameIndex = 0; frameIndex < sourceFrameCount; frameIndex += 1) {
        const result = await decoder.decode({ frameIndex, completeFramesOnly: true });
        const image = result.image;
        try {
          if (!width || !height) {
            width = Number(image.displayWidth || image.codedWidth);
            height = Number(image.displayHeight || image.codedHeight);
            canvas.width = width;
            canvas.height = height;
          }
          const durationUs = Number(image.duration) > 0 ? Number(image.duration) : 333_333;
          const frameEndUs = timestampUs + durationUs;
          const shouldSample = frameIndex === 0 || frameIndex === sourceFrameCount - 1 ||
            frameEndUs > nextSampleUs;
          if (shouldSample) {
            drawing.clearRect(0, 0, width, height);
            drawing.drawImage(image, 0, 0, width, height);
            const pixels = drawing.getImageData(0, 0, width, height).data;
            await window.__uaCollectDecodedWebpFrame(encodeBase64(pixels));
            sampledFrames += 1;
            while (nextSampleUs <= frameEndUs) nextSampleUs += intervalUs;
          }
          timestampUs = frameEndUs;
        } finally {
          image.close();
        }
      }
      decoder.close();
      return { width, height, sampledFrames, sourceFrameCount, durationUs: timestampUs };
    }, {
      base64: artifact.toString('base64'),
      intervalUs: WEBP_SAMPLE_INTERVAL_US,
    });
    if (!validEncodedDimensions(decoded) || decoded.sampledFrames !== frames.length || frames.length < 2) {
      throw new VideoExportSemanticError(
        'encoded_webp_decode_invalid',
        `Chromium decoded an invalid WebP frame set (${decoded.sampledFrames}/${frames.length})`
      );
    }
    return {
      buffer: Buffer.concat(frames),
      width: decoded.width,
      height: decoded.height,
      sourceFrameCount: decoded.sourceFrameCount,
    };
  } catch (error) {
    if (error instanceof VideoExportSemanticError) throw error;
    throw new VideoExportSemanticError(
      'encoded_webp_decode_failed',
      `Chromium could not decode the animated WebP: ${error.message}`
    );
  } finally {
    await verificationContext.close().catch(() => {});
  }
}

async function inspectEncodedFrames(outputPath, requiredState, frameEvidence, options = {}) {
  if (path.extname(outputPath).toLowerCase() === '.webp') {
    const decoded = await decodeAnimatedWebpFramesWithChromium(outputPath, options.browser);
    return countPalettePixels(
      decoded.buffer,
      decoded.width,
      decoded.height,
      requiredState,
      frameEvidence
    );
  }
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
    raise SystemExit('encoded-frame inspection function not found exactly once')
s = s.replace(old, new)

old = """    await context.close();
    await browser.close();
    browser = null;

    const videoPath = video ? await video.path() : null;
"""
new = """    await context.close();

    const videoPath = video ? await video.path() : null;
"""
if s.count(old) != 1:
    raise SystemExit('premature browser close block not found exactly once')
s = s.replace(old, new)

old = """    const encodedFrames = await inspectEncodedFrames(outputPath, requiredState, semanticFrame);
    const artifactBuffer = fs.readFileSync(outputPath);
"""
new = """    const encodedFrames = await inspectEncodedFrames(
      outputPath,
      requiredState,
      semanticFrame,
      { browser }
    );
    await browser.close();
    browser = null;
    const artifactBuffer = fs.readFileSync(outputPath);
"""
if s.count(old) != 1:
    raise SystemExit('post-encoding inspection call not found exactly once')
s = s.replace(old, new)

old = """module.exports = {
  ANIMATED_IMAGE_FILTER,
  VideoExportSemanticError,
"""
new = """module.exports = {
  ANIMATED_IMAGE_FILTER,
  CONTEXT_WITNESS_COLORS,
  VideoExportSemanticError,
"""
if s.count(old) != 1:
    raise SystemExit('witness color export insertion point not found exactly once')
s = s.replace(old, new)

old = """  installSemanticEvidenceBadge,
  parseWebpDimensions,
"""
new = """  decodeAnimatedWebpFramesWithChromium,
  installSemanticEvidenceBadge,
  parseAnimatedWebpMetadata,
  parseWebpDimensions,
"""
if s.count(old) != 1:
    raise SystemExit('WebP decoder export insertion point not found exactly once')
s = s.replace(old, new)

p.write_text(s)

p = Path('tests/unit/videoExportEncodingContract.test.js')
s = p.read_text()
s = s.replace(
"""const {
  buildEncodedInspectionArgs,
""",
"""const {
  CONTEXT_WITNESS_COLORS,
  buildEncodedInspectionArgs,
"""
)
s = s.replace(
"""  buildWebpEncodingArgs,
  parseWebpDimensions,
""",
"""  buildWebpEncodingArgs,
  parseAnimatedWebpMetadata,
  parseWebpDimensions,
"""
)
old = """    expect(parseWebpDimensions(buffer)).toEqual({ width: 720, height: 405 });
    expect(parseWebpDimensions(Buffer.from('not-webp'))).toBeNull();
  });
"""
new = """    expect(parseWebpDimensions(buffer)).toEqual({ width: 720, height: 405 });
    expect(parseWebpDimensions(Buffer.from('not-webp'))).toBeNull();
  });

  test('parses animated WebP frame metadata and keeps traffic witness codec-stable', () => {
    const vp8x = Buffer.alloc(18);
    vp8x.write('VP8X', 0, 'ascii');
    vp8x.writeUInt32LE(10, 4);
    vp8x[8] = 0x02;
    vp8x.writeUIntLE(719, 12, 3);
    vp8x.writeUIntLE(404, 15, 3);
    const anim = Buffer.alloc(14);
    anim.write('ANIM', 0, 'ascii');
    anim.writeUInt32LE(6, 4);
    const frame = duration => {
      const chunk = Buffer.alloc(24);
      chunk.write('ANMF', 0, 'ascii');
      chunk.writeUInt32LE(16, 4);
      chunk.writeUIntLE(duration, 20, 3);
      return chunk;
    };
    const body = Buffer.concat([Buffer.from('WEBP'), vp8x, anim, frame(250), frame(500)]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    const metadata = parseAnimatedWebpMetadata(Buffer.concat([riff, body]));
    expect(metadata).toEqual({
      width: 720,
      height: 405,
      animated: true,
      frameCount: 2,
      durationMs: 750,
    });
    expect(CONTEXT_WITNESS_COLORS.slope).toEqual([0, 96, 255]);
    expect(CONTEXT_WITNESS_COLORS.traffic).toEqual([255, 0, 255]);
  });
"""
if s.count(old) != 1:
    raise SystemExit('encoding contract test insertion point not found exactly once')
s = s.replace(old, new)
p.write_text(s)
PY

npx jest tests/unit/videoExportEncodingContract.test.js tests/unit/videoExportReadiness.test.js --runInBand
git add server/video-export.js tests/unit/videoExportEncodingContract.test.js
git diff --cached --check
git commit -m "fix: verify animated WebP with Chromium decoder"
git push --force-with-lease="refs/heads/$BRANCH:$EXPECTED" origin "HEAD:refs/heads/$BRANCH"
