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
  return {
    sourceWidth: width,
    sourceHeight: height,
    accidentWitnesses: {},
    contextWitnesses: {
      slope: {
        kind: 'slope', x: 8, y: 8, roadRadius: 3, lineWeight: 8,
        counterpartLineWeight: 3, expectedColor: '#f03b20', wayId: '42',
        witnessColor: [0, 96, 255], sharedCompositeWay: true,
      },
      traffic: {
        kind: 'traffic', x: 8, y: 8, roadRadius: 3, lineWeight: 3,
        counterpartLineWeight: 8, expectedColor: '#277da1', wayId: '42',
        witnessColor: [255, 0, 128], sharedCompositeWay: true,
      },
    },
  };
}

describe('recorded source-frame evidence', () => {
  test('decodes the source at the same scale and sampling rate as final evidence inspection', () => {
    expect(buildSourceFrameInspectionArgs('/tmp/source.webm')).toEqual([
      '-v', 'error',
      '-i', '/tmp/source.webm',
      '-vf', 'fps=2,scale=720:-1:flags=lanczos',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1',
    ]);
  });

  test('binds rendered context colours only in a frame carrying the semantic badge', () => {
    const width = 16, height = 16;
    const buffer = frameBuffer(width, height, 2);

    // Perfect pre-render style matches in an earlier frame must not become
    // evidence: only frames that also contain the fixed semantic badge prove
    // that the requested state had already been installed before recording.
    setPixel(buffer, width, height, 0, 8, 8, [240, 59, 32]);
    setPixel(buffer, width, height, 0, 8, 9, [39, 125, 161]);

    addBadge(buffer, width, height, 1);
    for (const point of [[7, 8], [8, 8], [9, 8]]) {
      setPixel(buffer, width, height, 1, point[0], point[1], [220, 45, 35]);
    }
    for (const point of [[8, 7], [8, 9], [9, 9]]) {
      setPixel(buffer, width, height, 1, point[0], point[1], [45, 115, 145]);
    }

    const result = bindRecordedContextColors(
      buffer,
      width,
      height,
      { layers: { slope: true, traffic: true } },
      evidence(width, height)
    );

    expect(result.sourceFrameInspection).toEqual(expect.objectContaining({
      frameCount: 2,
      evidenceFrameCount: 1,
      commonContextFrame: 1,
      width,
      height,
    }));
    expect(result.contextWitnesses.slope.renderedColor).toEqual([220, 45, 35]);
    expect(result.contextWitnesses.traffic.renderedColor).toEqual([45, 115, 145]);
    expect(result.contextWitnesses.slope.renderedSourceFrame).toBe(1);
    expect(result.contextWitnesses.traffic.renderedSourceFrame).toBe(1);
  });

  test('selects a distinguishable composite pair from the same evidence frame', () => {
    const width = 16, height = 16;
    const buffer = frameBuffer(width, height, 3);
    for (const frame of [0, 1, 2]) addBadge(buffer, width, height, frame);

    // Frame 0 has the best slope match but no acceptable traffic match.
    for (const point of [[7, 8], [8, 8], [9, 8]]) {
      setPixel(buffer, width, height, 0, point[0], point[1], [240, 59, 32]);
    }
    // Frame 1 has the best traffic match but no acceptable slope match.
    for (const point of [[8, 7], [8, 9], [9, 9]]) {
      setPixel(buffer, width, height, 1, point[0], point[1], [39, 125, 161]);
    }
    // Frame 2 contains a slightly less exact but genuine same-frame pair.
    for (const point of [[7, 8], [8, 8], [9, 8]]) {
      setPixel(buffer, width, height, 2, point[0], point[1], [218, 48, 38]);
    }
    for (const point of [[8, 7], [8, 9], [9, 9]]) {
      setPixel(buffer, width, height, 2, point[0], point[1], [48, 112, 146]);
    }

    const result = bindRecordedContextColors(
      buffer,
      width,
      height,
      { layers: { slope: true, traffic: true } },
      evidence(width, height)
    );

    expect(result.sourceFrameInspection.commonContextFrame).toBe(2);
    expect(result.contextWitnesses.slope.renderedSourceFrame).toBe(2);
    expect(result.contextWitnesses.traffic.renderedSourceFrame).toBe(2);
    expect(result.contextWitnesses.slope.renderedColor).toEqual([218, 48, 38]);
    expect(result.contextWitnesses.traffic.renderedColor).toEqual([48, 112, 146]);
  });

  test('fails closed when the recorded source has no semantic-evidence frame', () => {
    const width = 16, height = 16;
    const buffer = frameBuffer(width, height, 2);
    expect(() => bindRecordedContextColors(
      buffer,
      width,
      height,
      { layers: { slope: true, traffic: true } },
      evidence(width, height)
    )).toThrow(/no frame with the semantic evidence badge/i);
  });
});
