'use strict';

const { ANIMATED_IMAGE_FILTER } = require('../../server/video-export-filters.js');

describe('server/video-export animated image filter', () => {
  test('keeps original timing (no setpts time compression)', () => {
    expect(ANIMATED_IMAGE_FILTER).not.toMatch(/setpts\s*=/i);
  });

  test('limits filesize using a positive fps and scale', () => {
    const fpsMatch = ANIMATED_IMAGE_FILTER.match(/(?:^|,)fps=(\d+(?:\.\d+)?)(?:,|$)/);
    expect(fpsMatch).not.toBeNull();
    expect(Number(fpsMatch[1])).toBeGreaterThan(0);
    expect(ANIMATED_IMAGE_FILTER).toMatch(/(?:^|,)scale=\d+:-1(?::|,|$)/);
  });
});
