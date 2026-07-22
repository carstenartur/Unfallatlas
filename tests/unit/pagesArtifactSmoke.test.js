'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertPrebuiltSite,
  parseArgs: parseServeArgs,
  resolveSiteRoot,
} = require('../../scripts/serve-site');
const {
  fingerprintTree,
  parseArgs: parseFingerprintArgs,
} = require('../../scripts/fingerprint-static-tree');

const ROOT = path.resolve(__dirname, '../..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('immutable Pages artifact smoke contract', () => {
  test('serving an existing artifact is explicit and does not select a rebuild', () => {
    expect(parseServeArgs(['--no-build', '--site', '_site'])).toEqual({
      build: false,
      site: '_site',
    });
    expect(parseServeArgs([])).toEqual({ build: true, site: '_site' });
    expect(() => parseServeArgs(['--unknown'])).toThrow(/Unknown argument/);
    expect(resolveSiteRoot('_site')).toBe(path.join(ROOT, '_site'));
    expect(() => resolveSiteRoot('.')).toThrow(/outside the repository/);
    expect(() => resolveSiteRoot('../outside')).toThrow(/outside the repository/);
  });

  test('prebuilt mode fails closed on incomplete artifacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-prebuilt-site-'));
    try {
      expect(() => assertPrebuiltSite(directory)).toThrow(/build-manifest\.json/);
      fs.writeFileSync(path.join(directory, 'build-manifest.json'), '{}\n');
      expect(() => assertPrebuiltSite(directory)).toThrow(/werkbank_v2\.html/);
      fs.writeFileSync(path.join(directory, 'werkbank_v2.html'), '<!doctype html>\n');
      expect(() => assertPrebuiltSite(directory)).not.toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('tree fingerprint changes for any delivered-byte mutation', () => {
    const relative = path.join(
      '.build',
      `pages-fingerprint-test-${process.pid}-${process.env.JEST_WORKER_ID || '0'}`
    );
    const directory = path.join(ROOT, relative);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(path.join(directory, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), 'first\n');
    fs.writeFileSync(path.join(directory, 'nested', 'data.json'), '{}\n');
    try {
      const first = fingerprintTree({ root: ROOT, site: relative });
      expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(first.fileCount).toBe(2);
      fs.appendFileSync(path.join(directory, 'index.html'), 'mutation\n');
      const second = fingerprintTree({ root: ROOT, site: relative });
      expect(second.fingerprint).not.toBe(first.fingerprint);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fingerprint CLI requires exactly one write or verify operation', () => {
    expect(parseFingerprintArgs(['--site', '_site', '--write', 'out/qa/site.sha256']))
      .toEqual({ site: '_site', write: 'out/qa/site.sha256', verify: null });
    expect(parseFingerprintArgs(['--site', '_site', '--verify', 'out/qa/site.sha256']))
      .toEqual({ site: '_site', write: null, verify: 'out/qa/site.sha256' });
    expect(() => parseFingerprintArgs(['--site', '_site'])).toThrow(/exactly one/);
    expect(() => parseFingerprintArgs([
      '--write', 'out/qa/a.sha256', '--verify', 'out/qa/a.sha256',
    ])).toThrow(/exactly one/);
  });

  test.each([
    '.github/workflows/deploy-pages-current-data.yml',
    '.github/workflows/generate-data-deploy-pages.yml',
  ])('%s smokes and revalidates the immutable reduced tree', workflowPath => {
    const workflow = read(workflowPath);
    expect(workflow).toContain('npm run serve:site:existing');
    expect(workflow).toContain('BASE_URL=http://127.0.0.1:8000');
    expect(workflow).toContain('npm run fingerprint:site -- --site _site --write');
    expect(workflow).toContain('npm run fingerprint:site -- --site _site --verify');
    expect(workflow.match(/npm run validate:pages-profile -- --site _site/g)).toHaveLength(2);
    expect(workflow.indexOf('--write')).toBeLessThan(workflow.indexOf('npx playwright test'));
    expect(workflow.indexOf('npx playwright test')).toBeLessThan(workflow.indexOf('--verify'));
  });
});
