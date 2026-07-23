'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WRAPPER = path.resolve(__dirname, '..', '..', 'bin', 'ffmpeg');
const testUnix = process.platform === 'win32' ? test.skip : test;
const tempDirectories = [];

function makeTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-codec-wrapper-'));
  tempDirectories.push(directory);
  return directory;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function runWrapper(args, directory) {
  const fakeFfmpeg = path.join(directory, 'real-ffmpeg');
  const fakeMagick = path.join(directory, 'magick');
  const ffmpegLog = path.join(directory, 'ffmpeg.log');
  const magickLog = path.join(directory, 'magick.log');

  writeExecutable(fakeFfmpeg, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'printf \'%s\\n\' "$@" >> "$FAKE_FFMPEG_LOG"',
    'if [[ "$*" == *\'palettegen=\'* ]]; then',
    '  printf \'synthetic-palette\' > "${!#}"',
    'fi',
    '',
  ].join('\n'));
  writeExecutable(fakeMagick, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'printf \'%s\\n\' "$@" >> "$FAKE_MAGICK_LOG"',
    'if [[ "${!#}" == \'rgba:-\' ]]; then',
    '  printf \'rgba-frame\'',
    'elif [[ "${!#}" == \'rgb:-\' ]]; then',
    '  printf \'rgb-frame\'',
    'else',
    '  cp -- "$1" "${!#}"',
    'fi',
    '',
  ].join('\n'));

  const result = spawnSync('bash', [WRAPPER, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      UNFALLATLAS_REAL_FFMPEG: fakeFfmpeg,
      UNFALLATLAS_MAGICK: fakeMagick,
      FAKE_FFMPEG_LOG: ffmpegLog,
      FAKE_MAGICK_LOG: magickLog,
    },
    encoding: 'utf8',
  });

  return { result, ffmpegLog, magickLog };
}

afterEach(() => {
  while (tempDirectories.length) {
    fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

test('video export prepends the repository codec directory exactly once', () => {
  const modulePath = require.resolve('../../server/video-export-filters');
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = ['/usr/bin', '/bin'].join(path.delimiter);
    delete require.cache[modulePath];
    const { CODEC_BIN_DIR } = require('../../server/video-export-filters');
    expect(process.env.PATH.split(path.delimiter)[0]).toBe(CODEC_BIN_DIR);

    delete require.cache[modulePath];
    require('../../server/video-export-filters');
    expect(process.env.PATH.split(path.delimiter).filter(entry => entry === CODEC_BIN_DIR)).toHaveLength(1);
  } finally {
    process.env.PATH = previousPath;
    delete require.cache[modulePath];
  }
});

testUnix('ordinary ffmpeg calls are delegated without rewriting arguments', () => {
  const directory = makeTempDirectory();
  const { result, ffmpegLog, magickLog } = runWrapper(['-version'], directory);

  expect(result.status).toBe(0);
  expect(fs.readFileSync(ffmpegLog, 'utf8')).toBe('-version\n');
  expect(fs.existsSync(magickLog)).toBe(false);
});

testUnix('lossless animated WebP uses deterministic compression effort', () => {
  const directory = makeTempDirectory();
  const { result, ffmpegLog, magickLog } = runWrapper([
    '-y', '-i', 'input.webm',
    '-c:v', 'libwebp_anim',
    '-lossless', '1',
    '-q:v', '60',
    '-compression_level', '6',
    '-f', 'webp',
    'output.webp',
  ], directory);

  expect(result.status).toBe(0);
  const argumentsSeen = fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n');
  const qualityIndex = argumentsSeen.indexOf('-q:v');
  expect(qualityIndex).toBeGreaterThanOrEqual(0);
  expect(argumentsSeen[qualityIndex + 1]).toBe('80');
  expect(argumentsSeen).not.toContain('60');
  expect(fs.existsSync(magickLog)).toBe(false);
});

testUnix('GIF palette generation reserves every fixed semantic-evidence colour', () => {
  const directory = makeTempDirectory();
  const palettePath = path.join(directory, 'palette.png');
  const { result, ffmpegLog, magickLog } = runWrapper([
    '-y', '-i', 'input.webm',
    '-vf', 'fps=3,palettegen=max_colors=256:reserve_transparent=0:stats_mode=full',
    palettePath,
  ], directory);

  expect(result.status).toBe(0);
  expect(fs.readFileSync(ffmpegLog, 'utf8')).toContain('palettegen=max_colors=256');
  const magickArguments = fs.readFileSync(magickLog, 'utf8');
  for (const colour of [
    'rgb(0,191,165)',
    'rgb(255,0,255)',
    'rgb(128,0,128)',
    'rgb(0,96,255)',
    'rgb(255,0,128)',
  ]) {
    expect(magickArguments).toContain(colour);
  }
  expect(fs.readFileSync(palettePath, 'utf8')).toBe('synthetic-palette');
});

testUnix('animated WebP inspection uses ImageMagick RGBA frames instead of ffmpeg decoding', () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, 'animation.webp');
  fs.writeFileSync(inputPath, 'RIFF synthetic WEBP', 'utf8');

  const { result, ffmpegLog, magickLog } = runWrapper([
    '-v', 'error', '-i', inputPath,
    '-vf', 'fps=2', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ], directory);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe('rgba-frame');
  expect(fs.existsSync(ffmpegLog)).toBe(false);
  const magickArguments = fs.readFileSync(magickLog, 'utf8');
  expect(magickArguments).toContain(inputPath);
  expect(magickArguments).toContain('-coalesce');
  expect(magickArguments).toContain('rgba:-');
});

testUnix('bounded animated WebP badge inspection preserves crop, tail-frame limit and rgb24 output', () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, 'animation.webp');
  fs.writeFileSync(inputPath, 'RIFF synthetic WEBP', 'utf8');

  const { result, ffmpegLog, magickLog } = runWrapper([
    '-v', 'error',
    '-ss', '14',
    '-i', inputPath,
    '-vf', 'fps=1,crop=942:27:9:507',
    '-frames:v', '8',
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    'pipe:1',
  ], directory);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe('rgb-frame');
  expect(fs.existsSync(ffmpegLog)).toBe(false);
  const magickArguments = fs.readFileSync(magickLog, 'utf8').trim().split('\n');
  expect(magickArguments).toContain(inputPath);
  expect(magickArguments).toContain('-coalesce');
  expect(magickArguments).toContain('-reverse');
  expect(magickArguments).toContain('-delete');
  expect(magickArguments).toContain('8--1');
  expect(magickArguments).toContain('-crop');
  expect(magickArguments).toContain('942x27+9+507');
  expect(magickArguments).toContain('-alpha');
  expect(magickArguments).toContain('off');
  expect(magickArguments).toContain('rgb:-');
});
