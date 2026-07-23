'use strict';

const crypto = require('crypto');
const {
  PNG_SIGNATURE,
  createAccidentMarkers,
  createDeterministicMapPng,
  toDataUrl,
} = require('../../scripts/deterministic-map-fixture');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('deterministic cartographic document fixture', () => {
  test('creates a stable, non-placeholder RGBA PNG with requested dimensions', () => {
    const first = createDeterministicMapPng({ width: 960, height: 640 });
    const second = createDeterministicMapPng({ width: 960, height: 640 });

    expect(first.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(first.readUInt32BE(16)).toBe(960);
    expect(first.readUInt32BE(20)).toBe(640);
    expect(first.length).toBeGreaterThan(10_000);
    expect(sha256(first)).toBe(sha256(second));
    expect(first.equals(second)).toBe(true);
  });

  test('draws the 24 selected accidents required by the golden contract', () => {
    const markers = createAccidentMarkers();

    expect(markers).toHaveLength(24);
    for (const [x, y, colour] of markers) {
      expect(x).toBeGreaterThan(0.24);
      expect(x).toBeLessThan(0.68);
      expect(y).toBeGreaterThan(0.28);
      expect(y).toBeLessThan(0.74);
      expect(colour).toHaveLength(4);
    }
    expect(() => createAccidentMarkers(0)).toThrow(/between 1 and 100/);
  });

  test('changes deterministically when scenario metadata changes', () => {
    const bonn = createDeterministicMapPng({ scenario: 'Bonn' });
    const hannover = createDeterministicMapPng({ scenario: 'Hannover' });

    expect(sha256(bonn)).not.toBe(sha256(hannover));
    expect(bonn.readUInt32BE(16)).toBe(hannover.readUInt32BE(16));
    expect(bonn.readUInt32BE(20)).toBe(hannover.readUInt32BE(20));
  });

  test('produces a PNG data URL accepted by the document renderers', () => {
    const png = createDeterministicMapPng({ width: 800, height: 500 });
    const dataUrl = toDataUrl(png);

    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(dataUrl.split(',')[1], 'base64')).toEqual(png);
    expect(() => toDataUrl('not a buffer')).toThrow(/expects a Buffer/);
  });

  test('rejects placeholder-sized or invalid dimensions', () => {
    expect(() => createDeterministicMapPng({ width: 1, height: 1 }))
      .toThrow(/dimensions must be integers >= 64/);
    expect(() => createDeterministicMapPng({ width: 100.5, height: 100 }))
      .toThrow(/dimensions must be integers >= 64/);
  });
});
