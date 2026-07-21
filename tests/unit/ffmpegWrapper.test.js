'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const WRAPPER = path.join(ROOT, 'bin', 'ffmpeg');

function withFakeFfmpeg(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-ffmpeg-wrapper-'));
  const fake = path.join(directory, 'fake-ffmpeg');
  const capture = path.join(directory, 'arguments.txt');
  fs.writeFileSync(fake, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$UNFALLATLAS_CAPTURE"\n');
  fs.chmodSync(fake, 0o755);
  try {
    return run({ fake, capture, directory });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function execute(args, options = {}) {
  return withFakeFfmpeg(({ fake, capture }) => {
    const result = spawnSync('bash', [WRAPPER, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        UNFALLATLAS_REAL_FFMPEG: fake,
        UNFALLATLAS_CAPTURE: capture,
        ...(options.env || {}),
      },
    });
    const forwarded = fs.existsSync(capture)
      ? fs.readFileSync(capture, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : [];
    return { result, forwarded };
  });
}

const maybeTest = process.platform === 'win32' ? test.skip : test;

describe('production ffmpeg wrapper', () => {
  maybeTest('converts animated WebP to deterministic high-quality lossy mode', () => {
    const { result, forwarded } = execute([
      '-y', '-i', '/tmp/input.webm',
      '-c:v', 'libwebp_anim',
      '-lossless', '1',
      '-q:v', '60',
      '-f', 'webp', '/tmp/output.webp',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(forwarded).toEqual([
      '-y', '-i', '/tmp/input.webm',
      '-c:v', 'libwebp_anim',
      '-lossless', '0',
      '-q:v', '82',
      '-f', 'webp', '/tmp/output.webp',
    ]);
  });

  maybeTest('adds explicit lossy and quality arguments when the caller omitted them', () => {
    const { result, forwarded } = execute([
      '-i', '/tmp/input.webm', '-c:v', 'libwebp_anim', '-f', 'webp', '/tmp/output.webp',
    ], { env: { UNFALLATLAS_WEBP_QUALITY: '88' } });

    expect(result.status).toBe(0);
    expect(forwarded.slice(-4)).toEqual(['-q:v', '88', '-lossless', '0']);
  });

  maybeTest('delegates unrelated ffmpeg calls byte-for-byte', () => {
    const original = ['-v', 'error', '-i', '/tmp/input.mp4', '-f', 'null', '-'];
    const { result, forwarded } = execute(original);
    expect(result.status).toBe(0);
    expect(forwarded).toEqual(original);
  });

  maybeTest('rejects invalid WebP quality before invoking ffmpeg', () => {
    const { result, forwarded } = execute([
      '-i', '/tmp/input.webm', '-c:v', 'libwebp_anim', '-f', 'webp', '/tmp/output.webp',
    ], { env: { UNFALLATLAS_WEBP_QUALITY: '101' } });

    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/invalid UNFALLATLAS_WEBP_QUALITY=101/);
    expect(forwarded).toEqual([]);
  });
});
