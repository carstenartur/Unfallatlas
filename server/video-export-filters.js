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

// Encoded semantic inspection also samples at 2 fps. Using the same cadence
// avoids a 3→2 fps phase conversion that could select frames between the
// stable dual-context states recorded by the browser.
const ANIMATED_IMAGE_FPS = 2;
// Context overlays use an 8 px slope casing and a 3 px dashed traffic
// centreline at the browser's 1280 px capture width. 864 px retains just over
// two pixels for the narrow owned line (3 * 864 / 1280 = 2.025) while keeping
// GIF/WebP/APNG below their existing artifact-size budgets. A previous 960 px
// attempt proved the semantics but inflated lossless WebP to ~28 MiB.
const ANIMATED_IMAGE_WIDTH = 864;
const ANIMATED_IMAGE_FILTER =
  `fps=${ANIMATED_IMAGE_FPS},scale=${ANIMATED_IMAGE_WIDTH}:-1:flags=lanczos`;

module.exports = {
  ANIMATED_IMAGE_FILTER,
  ANIMATED_IMAGE_FPS,
  ANIMATED_IMAGE_WIDTH,
  CODEC_BIN_DIR
};
