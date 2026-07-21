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
// collapse to one unambiguous colour pixel after raster resampling. Real
// Testcontainers exports proved that this width preserves the two-pixel
// semantic evidence. Lossless WebP size varied from below the 18 MiB budget to
// 19.37 MB at 1.1 fps, so the final 1 fps cadence keeps the safer stroke width
// while adding a measured size margin without weakening any semantic gate.
const ANIMATED_IMAGE_FPS = 1;
const ANIMATED_IMAGE_WIDTH = 960;
const ANIMATED_IMAGE_FILTER =
  `fps=${ANIMATED_IMAGE_FPS},scale=${ANIMATED_IMAGE_WIDTH}:-1:flags=lanczos`;

module.exports = {
  ANIMATED_IMAGE_FILTER,
  ANIMATED_IMAGE_FPS,
  ANIMATED_IMAGE_WIDTH,
  CODEC_BIN_DIR
};
