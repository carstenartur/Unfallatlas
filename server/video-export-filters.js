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

const ANIMATED_IMAGE_FPS = 3;
// Context overlays use an 8 px slope casing and a 3 px dashed traffic
// centreline at the browser's 1280 px capture width. Scaling to 720 px reduced
// the traffic stroke to about 1.7 px, so a valid shared road corridor could
// leave only one unambiguous centreline pixel after temporal sampling. Keep at
// least 960 px horizontally: the narrowest owned context stroke then projects
// to 2.25 px while GIF/WebP/APNG continue to share one deterministic filter.
const ANIMATED_IMAGE_WIDTH = 960;
const ANIMATED_IMAGE_FILTER =
  `fps=${ANIMATED_IMAGE_FPS},scale=${ANIMATED_IMAGE_WIDTH}:-1:flags=lanczos`;

module.exports = {
  ANIMATED_IMAGE_FILTER,
  ANIMATED_IMAGE_FPS,
  ANIMATED_IMAGE_WIDTH,
  CODEC_BIN_DIR
};
