'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const { checkState } = require('../../scripts/gzip-static-data');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ua-gzip-static-data-test-'));
}

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe('gzip-static-data checkState', () => {
  let dir;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('ignores forbidRaw matches below maxRawBytes threshold', () => {
    writeFile(dir, 'out/ways_small.json', '{"v":1}');

    const result = checkState(dir, {
      forbidRaw: ['out/ways_*.json'],
      compress: ['out/**/*.json'],
      maxRawBytes: 100,
    });

    expect(result.violations).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

describe('gzip-static-data --check CLI', () => {
  let dir;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('exits 1 in --check mode when stale .gz artefacts are detected', () => {
    const gzAbs = path.join(dir, 'out/demo.json.gz');
    fs.mkdirSync(path.dirname(gzAbs), { recursive: true });
    fs.writeFileSync(gzAbs, zlib.gzipSync(Buffer.from('{"demo":true}', 'utf8')));

    const policyPath = path.join(dir, 'policy.js');
    fs.writeFileSync(policyPath, `module.exports = ${JSON.stringify({
      compress: ['out/**/*.json'],
      forbidRaw: [],
      maxRawBytes: 0,
    }, null, 2)};`);

    const result = spawnSync(
      'node',
      [
        path.join(__dirname, '../../scripts/gzip-static-data.js'),
        '--check',
        '--policy', policyPath,
        dir,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/STALE_GZ/);
  });
});
