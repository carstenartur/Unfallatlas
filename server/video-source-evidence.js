'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SOURCE_INSPECTION_FPS = 2;
const SOURCE_TARGET_WIDTH = 720;
const SOURCE_MARKER_TOLERANCE = 38;
const SOURCE_MARKER_MIN_PIXELS = 20;
const SOURCE_STYLE_MAX_DISTANCE = 96;
const SOURCE_STYLE_MIN_PIXELS = 2;
const MAX_SOURCE_DECODE_BUFFER_BYTES = 256 * 1024 * 1024;
const SOURCE_DECODE_TIMEOUT_MS = 120_000;

function buildSourceFrameInspectionArgs(inputPath) {
  return [
    '-v', 'error',
    '-i', inputPath,
    '-vf', `fps=${SOURCE_INSPECTION_FPS},scale=${SOURCE_TARGET_WIDTH}:-1:flags=lanczos`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1',
  ];
}

function parseRgb(value) {
  if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
    return value.map(Number);
  }
  const text = String(value || '').trim();
  const hex = text.match(/^#([a-f\d]{6})$/i);
  if (hex) return [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16));
  const rgb = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  return rgb ? rgb.slice(1, 4).map(Number) : null;
}

function channelDistance(left, right) {
  return Math.max(...left.map((channel, index) => Math.abs(channel - right[index])));
}

function closeTo(color, expected, tolerance) {
  return channelDistance(color, expected) <= tolerance;
}

function projectedRegion(witness, width, height, sourceWidth, sourceHeight) {
  const scaleX = width / sourceWidth;
  const scaleY = height / sourceHeight;
  const sourceRadius = Math.max(
    Number(witness.roadRadius || 7),
    Number(witness.lineWeight || 0) + Number(witness.counterpartLineWeight || 0) + 3
  );
  return {
    x: Number(witness.x) * scaleX,
    y: Number(witness.y) * scaleY,
    radiusX: Math.max(3, Math.ceil(sourceRadius * scaleX)),
    radiusY: Math.max(3, Math.ceil(sourceRadius * scaleY)),
  };
}

function scanCandidateFrame(buffer, frameStart, width, height, candidate, frame) {
  const { region, styleColor } = candidate;
  const minX = Math.max(0, Math.floor(region.x - region.radiusX));
  const maxX = Math.min(width - 1, Math.ceil(region.x + region.radiusX));
  const minY = Math.max(0, Math.floor(region.y - region.radiusY));
  const maxY = Math.min(height - 1, Math.ceil(region.y + region.radiusY));
  let best = null;
  let qualifyingPixels = 0;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = (x - region.x) / region.radiusX;
      const dy = (y - region.y) / region.radiusY;
      if (dx * dx + dy * dy > 1) continue;
      const index = frameStart + (y * width + x) * 4;
      const color = [buffer[index], buffer[index + 1], buffer[index + 2]];
      const distance = channelDistance(color, styleColor);
      if (!best || distance < best.distance) best = { color, distance, frame, x, y };
      if (distance <= SOURCE_STYLE_MAX_DISTANCE) qualifyingPixels += 1;
    }
  }

  return { best, qualifyingPixels };
}

function validFrameCandidate(result) {
  return Boolean(
    result && result.best &&
    result.best.distance <= SOURCE_STYLE_MAX_DISTANCE &&
    result.qualifyingPixels >= SOURCE_STYLE_MIN_PIXELS
  );
}

function bindRecordedContextColors(buffer, width, height, requiredState, frameEvidence) {
  const frameBytes = width * height * 4;
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length % frameBytes !== 0) {
    throw Object.assign(new Error(`Recorded source-frame buffer has invalid size ${buffer && buffer.length}`), {
      code: 'source_frame_decode_invalid',
      details: { width, height, bytes: buffer && buffer.length },
    });
  }

  const sourceWidth = Number(frameEvidence && frameEvidence.sourceWidth);
  const sourceHeight = Number(frameEvidence && frameEvidence.sourceHeight);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw Object.assign(new Error('Recorded source evidence requires browser viewport dimensions'), {
      code: 'source_frame_dimensions_missing',
      details: { sourceWidth, sourceHeight },
    });
  }

  const contextWitnesses = frameEvidence && frameEvidence.contextWitnesses || {};
  const requestedKinds = ['slope', 'traffic'].filter(kind => requiredState.layers[kind]);
  if (!requestedKinds.length) return frameEvidence;

  const candidates = {};
  for (const kind of requestedKinds) {
    const witness = contextWitnesses[kind];
    const styleColor = parseRgb(witness && witness.expectedColor);
    if (!witness || !styleColor) {
      throw Object.assign(new Error(`Recorded source evidence requires an exact ${kind} style colour`), {
        code: `source_${kind}_style_missing`,
        details: { witness: witness || null },
      });
    }
    candidates[kind] = {
      witness,
      styleColor,
      region: projectedRegion(witness, width, height, sourceWidth, sourceHeight),
      best: null,
      qualifyingPixels: 0,
    };
  }

  const sharedCompositeContext = requestedKinds.length === 2 && Boolean(
    contextWitnesses.slope && contextWitnesses.traffic &&
    contextWitnesses.slope.sharedCompositeWay &&
    contextWitnesses.traffic.sharedCompositeWay &&
    contextWitnesses.slope.wayId &&
    contextWitnesses.slope.wayId === contextWitnesses.traffic.wayId
  );
  const marker = [0, 191, 165];
  const frameCount = buffer.length / frameBytes;
  let evidenceFrameCount = 0;
  let commonContextFrame = null;

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameBytes;
    const end = start + frameBytes;
    let markerPixels = 0;
    for (let index = start; index < end; index += 4) {
      const color = [buffer[index], buffer[index + 1], buffer[index + 2]];
      if (closeTo(color, marker, SOURCE_MARKER_TOLERANCE)) markerPixels += 1;
    }
    if (markerPixels < SOURCE_MARKER_MIN_PIXELS) continue;
    evidenceFrameCount += 1;

    const frameResults = {};
    for (const kind of requestedKinds) {
      const candidate = candidates[kind];
      const result = scanCandidateFrame(buffer, start, width, height, candidate, frame);
      frameResults[kind] = result;
      if (result.best && (!candidate.best || result.best.distance < candidate.best.distance)) {
        candidate.best = result.best;
      }
      candidate.qualifyingPixels += result.qualifyingPixels;
    }

    if (sharedCompositeContext &&
        validFrameCandidate(frameResults.slope) &&
        validFrameCandidate(frameResults.traffic) &&
        channelDistance(frameResults.slope.best.color, frameResults.traffic.best.color) >= 20) {
      const score = Math.max(
        frameResults.slope.best.distance,
        frameResults.traffic.best.distance
      ) * 1000 + frameResults.slope.best.distance + frameResults.traffic.best.distance;
      if (!commonContextFrame || score < commonContextFrame.score) {
        commonContextFrame = { frame, score, results: frameResults };
      }
    }
  }

  if (!evidenceFrameCount) {
    throw Object.assign(new Error('Recorded source video contains no frame with the semantic evidence badge'), {
      code: 'source_semantic_marker_missing',
      details: { frameCount },
    });
  }
  if (sharedCompositeContext && !commonContextFrame) {
    throw Object.assign(new Error(
      'Recorded source video does not contain distinguishable slope and traffic pixels in one semantic-evidence frame'
    ), {
      code: 'source_context_composite_frame_missing',
      details: {
        evidenceFrameCount,
        slopeBest: candidates.slope.best,
        trafficBest: candidates.traffic.best,
        slopeRegion: candidates.slope.region,
        trafficRegion: candidates.traffic.region,
      },
    });
  }

  const enriched = { ...frameEvidence, contextWitnesses: { ...contextWitnesses } };
  for (const kind of requestedKinds) {
    const candidate = candidates[kind];
    const selected = commonContextFrame
      ? commonContextFrame.results[kind]
      : { best: candidate.best, qualifyingPixels: candidate.qualifyingPixels };
    if (!validFrameCandidate(selected)) {
      throw Object.assign(new Error(
        `Recorded source video does not contain rendered ${kind} road pixels near the owned geometry`
      ), {
        code: `source_${kind}_pixels_missing`,
        details: {
          evidenceFrameCount,
          best: selected && selected.best,
          qualifyingPixels: selected && selected.qualifyingPixels,
          styleColor: candidate.styleColor,
          region: candidate.region,
          witness: candidate.witness,
        },
      });
    }
    enriched.contextWitnesses[kind] = {
      ...candidate.witness,
      renderedColor: selected.best.color,
      renderedStyleDistance: selected.best.distance,
      renderedQualifyingPixels: selected.qualifyingPixels,
      renderedSourceFrame: selected.best.frame,
      renderedSourcePoint: { x: selected.best.x, y: selected.best.y },
    };
  }

  if (requestedKinds.length === 2) {
    const slope = enriched.contextWitnesses.slope.renderedColor;
    const traffic = enriched.contextWitnesses.traffic.renderedColor;
    if (channelDistance(slope, traffic) < 20) {
      throw Object.assign(new Error('Recorded slope and traffic evidence colours are not distinguishable'), {
        code: 'source_context_colors_indistinguishable',
        details: { slope, traffic, evidenceFrameCount },
      });
    }
  }

  return {
    ...enriched,
    sourceFrameInspection: {
      frameCount,
      evidenceFrameCount,
      commonContextFrame: commonContextFrame && commonContextFrame.frame,
      width,
      height,
      fps: SOURCE_INSPECTION_FPS,
    },
  };
}

async function probeSourceDimensions(inputPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    inputPath,
  ], {
    timeout: SOURCE_DECODE_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(String(stdout || ''));
  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  const sourceWidth = Number(stream && stream.width);
  const sourceHeight = Number(stream && stream.height);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(`Recorded source video has invalid dimensions ${sourceWidth}x${sourceHeight}`);
  }
  const height = Math.round(sourceHeight * SOURCE_TARGET_WIDTH / sourceWidth);
  return { width: SOURCE_TARGET_WIDTH, height };
}

async function inspectRecordedSourceFrames(inputPath, requiredState, frameEvidence) {
  const { width, height } = await probeSourceDimensions(inputPath);
  const { stdout } = await execFileAsync('ffmpeg', buildSourceFrameInspectionArgs(inputPath), {
    timeout: SOURCE_DECODE_TIMEOUT_MS,
    encoding: 'buffer',
    maxBuffer: MAX_SOURCE_DECODE_BUFFER_BYTES,
  });
  return bindRecordedContextColors(Buffer.from(stdout), width, height, requiredState, frameEvidence);
}

module.exports = {
  SOURCE_INSPECTION_FPS,
  SOURCE_MARKER_MIN_PIXELS,
  SOURCE_STYLE_MAX_DISTANCE,
  bindRecordedContextColors,
  buildSourceFrameInspectionArgs,
  inspectRecordedSourceFrames,
  parseRgb,
};
