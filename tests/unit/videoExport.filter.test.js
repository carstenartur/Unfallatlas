'use strict';

const { ANIMATED_IMAGE_FILTER } = require('../../server/video-export-filters.js');

describe('server/video-export animated image filter', () => {
  test('keeps original timing (no setpts time compression)', () => {
    expect(ANIMATED_IMAGE_FILTER).not.toMatch(/setpts\s*=/i);
  });

  test('limits filesize using fps and scale', () => {
    expect(ANIMATED_IMAGE_FILTER).toMatch(/(?:^|,)fps=\d+(?:,|$)/);
    expect(ANIMATED_IMAGE_FILTER).toMatch(/(?:^|,)scale=\d+:-1(?::|,|$)/);
  });
});
