'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('README demo regeneration architecture', () => {
  test('the regeneration script downloads the real server export through the shared Testcontainers helper', () => {
    const source = read('scripts/regen-readme-demo.js');

    expect(source).toContain('startUnfallatlasContainer');
    expect(source).toContain('/api/export-video');
    expect(source).toContain("require('../tests/integration/lib/startUnfallatlasContainer')");

    // Recording, browser control and encoding belong to server/video-export.js.
    expect(source).not.toMatch(/@playwright\/test|playwright-core|chromium\.launch/);
    expect(source).not.toMatch(/\bffmpeg\b|child_process|spawn\s*\(/);
  });

  test('the candidate workflow invokes the canonical command instead of reimplementing it inline', () => {
    const workflow = read('.github/workflows/regenerate-readme-demo-candidate.yml');

    expect(workflow).toContain('npm run regen:demo');
    expect(workflow).toContain('RUN_TESTCONTAINERS');
    expect(workflow).not.toMatch(/startUnfallatlasContainer|chooseDemoAsset|chromium\.launch|ffmpeg/);
  });

  test('package.json keeps one canonical regeneration entry point', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['regen:demo']).toBe('node scripts/regen-readme-demo.js');
  });
});
