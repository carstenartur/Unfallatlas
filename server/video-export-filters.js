'use strict';

const path = require('path');

// child_process resolves executables when execFile is called, not when the
// function is imported. Prepending the repository-local codec directory here
// therefore routes the later ffmpeg calls through bin/ffmpeg while leaving
// every unrelated command untouched. In the production image Docker marks the
// wrapper executable; on checkouts where it is not executable, PATH lookup
// simply continues to the system ffmpeg.
const CODEC_BIN_DIR = path.resolve(__dirname, '..', 'bin');
const currentPath = String(process.env.PATH || '');
const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
if (!pathEntries.includes(CODEC_BIN_DIR)) {
  process.env.PATH = [CODEC_BIN_DIR, currentPath].filter(Boolean).join(path.delimiter);
}

// The traffic centreline is only 3 px wide in the 1280 px browser capture.
// 960 px retains 2.25 px instead of the marginal 2.025 px at 864 px, which can
// collapse to one unambiguous colour pixel after raster resampling. Reducing the
// cadence to 1.25 fps keeps the total encoded pixel volume almost unchanged:
// (960 / 864)^2 * (1.25 / 1.5) ~= 1.03. The staged analysis remains readable,
// while lossless animated WebP stays within the established size budget.
const ANIMATED_IMAGE_FPS = 1.25;
const ANIMATED_IMAGE_WIDTH = 960;
const ANIMATED_IMAGE_FILTER =
  `fps=${ANIMATED_IMAGE_FPS},scale=${ANIMATED_IMAGE_WIDTH}:-1:flags=lanczos`;

module.exports = {
  ANIMATED_IMAGE_FILTER,
  ANIMATED_IMAGE_FPS,
  ANIMATED_IMAGE_WIDTH,
  CODEC_BIN_DIR
};
