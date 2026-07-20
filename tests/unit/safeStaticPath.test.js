'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  hasUnsafeStaticPath,
  isExistingPathConfined,
  resolveLexicalPath,
  resolveStaticFile,
} = require('../../server/lib/safeStaticPath');

describe('static site real-path confinement', () => {
  let root;
  let outside;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-static-site-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-static-outside-'));
    fs.writeFileSync(path.join(root, 'index.html'), 'safe');
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'page.html'), 'nested safe');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'runner secret');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('resolves only regular files beneath the real site root', () => {
    expect(resolveLexicalPath(root, '/../secret')).toBeNull();
    expect(resolveStaticFile(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveStaticFile(root, '/nested/page.html')).toBe(path.join(root, 'nested', 'page.html'));
    expect(isExistingPathConfined(root, path.join(root, 'nested', 'page.html'))).toBe(true);
  });

  test('rejects a file symlink and a nested directory symlink before serving bytes', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'), 'file');
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');

    expect(resolveStaticFile(root, '/leak.txt')).toBeNull();
    expect(resolveStaticFile(root, '/linked/secret.txt')).toBeNull();
    expect(hasUnsafeStaticPath(root, '/leak.txt')).toBe(true);
    expect(hasUnsafeStaticPath(root, '/linked/secret.txt')).toBe(true);
    expect(isExistingPathConfined(root, path.join(root, 'leak.txt'))).toBe(false);
  });

  test('checks extension fallbacks and directory indexes as real paths', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'unsafe.html'), 'file');
    fs.mkdirSync(path.join(root, 'section'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'section', 'werkbank_v2.html'), 'file');

    expect(hasUnsafeStaticPath(root, '/unsafe', { extensions: ['html'] })).toBe(true);
    expect(hasUnsafeStaticPath(root, '/section', { index: 'werkbank_v2.html' })).toBe(true);
    expect(resolveStaticFile(root, '/unsafe', { extensions: ['html'] })).toBeNull();
  });
});
