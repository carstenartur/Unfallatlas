'use strict';

const fs = require('fs');
const path = require('path');
const {
  ANIMATED_IMAGE_WIDTH,
} = require('../../server/video-export-filters.js');

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
    // Mentions in documentation comments are harmless; reject actual imports and calls.
    expect(source).not.toMatch(
      /require\(\s*['"](?:@playwright\/test|playwright|playwright-core)['"]\s*\)/,
    );
    expect(source).not.toMatch(/\bchromium\s*\.\s*launch\s*\(/);
    expect(source).not.toMatch(/require\(\s*['"]child_process['"]\s*\)/);
    expect(source).not.toMatch(/\b(?:spawn|spawnSync|exec|execFile|execFileSync)\s*\(/);
  });

  test('allows an obsolete canonical GIF to be repaired, then retains the strict post-write gate', () => {
    const source = read('scripts/regen-readme-demo.js');

    expect(source).toMatch(/const before = validate\([\s\S]*?policyOnly:\s*true/);
    expect(source).toMatch(/const after = validate\(\{ root: REPO_ROOT, manifest: 'docs\/media-manifest\.json' \}\)/);
    expect(source).toContain('atomicWrite(DEMO_ASSET_PATH, original)');
  });

  test('the media target is derived from the deliberate server encoding width', () => {
    const manifest = JSON.parse(read('docs/media-manifest.json'));
    const demo = manifest.assets.find(asset => asset.path === 'docs/demo.gif');

    expect(demo).toBeDefined();
    expect(demo.target.width).toBe(ANIMATED_IMAGE_WIDTH);
    expect(demo.target.height).toBe(Math.round(ANIMATED_IMAGE_WIDTH * 9 / 16));
    expect(demo.maxBytes).toBe(9 * 1024 * 1024);
    expect(demo.maxDurationMs).toBe(60_000);
  });

  test('the candidate workflow invokes the canonical command instead of reimplementing it inline', () => {
    const workflow = read('.github/workflows/regenerate-readme-demo-candidate.yml');

    expect(workflow).toContain('npm run regen:demo');
    expect(workflow).toContain('RUN_TESTCONTAINERS');
    expect(workflow).toContain('if: success()');

    // File/path names in the trigger list are expected. Only executable
    // duplicates of the orchestration or encoder are forbidden.
    expect(workflow).not.toMatch(/startUnfallatlasContainer\s*\(/);
    expect(workflow).not.toMatch(/chooseDemoAsset\s*\(/);
    expect(workflow).not.toMatch(/chromium\s*\.\s*launch\s*\(/);
    expect(workflow).not.toMatch(/(?:^|\n)\s*(?:run:\s*)?ffmpeg(?:\s|$)/m);
    expect(workflow).not.toMatch(/node\s+<<[-]?['"]?[A-Z_]+['"]?/);
  });

  test('package.json keeps one canonical regeneration entry point', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['regen:demo']).toBe('node scripts/regen-readme-demo.js');
  });
});
