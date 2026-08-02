'use strict';

const {
  SOURCE_MARKER_MIN_PIXELS,
  bindRecordedContextColors,
  buildSourceFrameInspectionArgs,
} = require('../../server/video-source-evidence');

function frameBuffer(width, height, frames) {
  const buffer = Buffer.alloc(width * height * 4 * frames, 0);
  for (let index = 3; index < buffer.length; index += 4) buffer[index] = 255;
  return buffer;
}

function setPixel(buffer, width, height, frame, x, y, color) {
  const offset = frame * width * height * 4 + (y * width + x) * 4;
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
  buffer[offset + 3] = 255;
}

function addBadge(buffer, width, height, frame) {
  for (let index = 0; index < SOURCE_MARKER_MIN_PIXELS + 2; index++) {
    setPixel(buffer, width, height, frame, index % width, Math.floor(index / width), [0, 191, 165]);
  }
}

function evidence(width, height) {
  const x = Math.floor(width / 2);
  const y = Math.floor(height / 2);
  return {
    sourceWidth: width,
    sourceHeight: height,
    accidentWitnesses: {},
    contextWitnesses: {
      slope: {
        kind: 'slope', x, y, roadRadius: 3, lineWeight: 8,
        counterpartLineWeight: 3, expectedColor: '#f03b20', wayId: '42',
        witnessColor: [0, 96, 255], sharedCompositeWay: true,
      },
      traffic: {
        kind: 'traffic', x, y, roadRadius: 3, lineWeight: 3,
        counterpartLineWeight: 8, expectedColor: '#277da1', wayId: '42',
        witnessColor: [255, 0, 128], sharedCompositeWay: true,
      },
    },
  };
}

function roadPoints(centerX, centerY) {
  return {
    slope: [[centerX - 1, centerY], [centerX, centerY], [centerX + 1, centerY]],
    traffic: [[centerX, centerY - 1], [centerX, centerY + 1], [centerX + 1, centerY + 1]],
  };
}

describe('recorded source-frame evidence', () => {
  test('decodes source evidence on the time grid shared by every final format', () => {
    // Whole-second samples are present both in the 2fps GIF/APNG inspection
    // and in the 3fps WebP encoding. The explicit 2.2-second pre-dialog hold
    // guarantees at least one real context frame on this common grid.
    expect(buildSourceFrameInspectionArgs('/tmp/source.webm')).toEqual([
      '-v', 'error',
      '-i', '/tmp/source.webm',
      '-vf', 'fps=1,scale=720:-1:flags=lanczos',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1',
    ]);
  });

  test('binds rendered context colours only in a frame carrying the semantic badge', () => {
    const width = 64, height = 64, centerX = 32, centerY = 32;
    const points = roadPoints(centerX, centerY);
    const buffer = frameBuffer(width, height, 2);

    setPixel(buffer, width, height, 0, centerX, centerY, [240, 59, 32]);
    setPixel(buffer, width, height, 0, centerX, centerY + 1, [39, 125, 161]);

    addBadge(buffer, width, height, 1);
    for (const point of points.slope) setPixel(buffer, width, height, 1, point[0], point[1], [220, 45, 35]);
    for (const point of points.traffic) setPixel(buffer, width, height, 1, point[0], point[1], [45, 115, 145]);

    const result = bindRecordedContextColors(buffer, width, height,
      { layers: { slope: true, traffic: true } }, evidence(width, height));

    expect(result.sourceFrameInspection).toEqual(expect.objectContaining({
      frameCount: 2, evidenceFrameCount: 1, commonContextFrame: 1, width, height,
    }));
    expect(result.contextWitnesses.slope.renderedColor).toEqual([220, 45, 35]);
    expect(result.contextWitnesses.traffic.renderedColor).toEqual([45, 115, 145]);
    expect(result.contextWitnesses.slope.renderedSourceFrame).toBe(1);
    expect(result.contextWitnesses.traffic.renderedSourceFrame).toBe(1);
    expect(result.contextWitnesses.slope.roadRadius).toBe(14);
    expect(result.contextWitnesses.traffic.roadRadius).toBe(14);
  });

  test('selects the earliest distinguishable same-frame pair before later overlays', () => {
    const width = 64, height = 64, centerX = 32, centerY = 32;
    const points = roadPoints(centerX, centerY);
    const buffer = frameBuffer(width, height, 4);
    for (const frame of [0, 1, 2, 3]) addBadge(buffer, width, height, frame);

    for (const point of points.slope) setPixel(buffer, width, height, 0, point[0], point[1], [240, 59, 32]);
    for (const point of points.traffic) setPixel(buffer, width, height, 1, point[0], point[1], [39, 125, 161]);
    for (const point of points.slope) setPixel(buffer, width, height, 2, point[0], point[1], [218, 48, 38]);
    for (const point of points.traffic) setPixel(buffer, width, height, 2, point[0], point[1], [48, 112, 146]);
    for (const point of points.slope) setPixel(buffer, width, height, 3, point[0], point[1], [240, 59, 32]);
    for (const point of points.traffic) setPixel(buffer, width, height, 3, point[0], point[1], [39, 125, 161]);

    const result = bindRecordedContextColors(buffer, width, height,
      { layers: { slope: true, traffic: true } }, evidence(width, height));

    expect(result.sourceFrameInspection.commonContextFrame).toBe(2);
    expect(result.contextWitnesses.slope.renderedSourceFrame).toBe(2);
    expect(result.contextWitnesses.traffic.renderedSourceFrame).toBe(2);
    expect(result.contextWitnesses.slope.renderedColor).toEqual([218, 48, 38]);
    expect(result.contextWitnesses.traffic.renderedColor).toEqual([48, 112, 146]);
  });

  test('fails closed when the recorded source has no semantic-evidence frame', () => {
    const width = 64, height = 64;
    const buffer = frameBuffer(width, height, 2);
    expect(() => bindRecordedContextColors(buffer, width, height,
      { layers: { slope: true, traffic: true } }, evidence(width, height)))
      .toThrow(/no frame with the semantic evidence badge/i);
  });
});
