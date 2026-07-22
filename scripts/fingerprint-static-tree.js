#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { fingerprintFiles, listFiles } = require('./build-public-pages-profile');

function parseArgs(argv) {
  const args = { site: '_site', write: null, verify: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--site') args.site = argv[++index] || args.site;
    else if (arg === '--write') args.write = argv[++index] || args.write;
    else if (arg === '--verify') args.verify = argv[++index] || args.verify;
    else throw new Error(`[fingerprint-static-tree] Unknown argument: ${arg}`);
  }
  if (Boolean(args.write) === Boolean(args.verify)) {
    throw new Error('[fingerprint-static-tree] Specify exactly one of --write or --verify');
  }
  return args;
}

function resolveInside(root, value, label) {
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[fingerprint-static-tree] Refusing ${label} outside the repository: ${target}`);
  }
  return target;
}

function fingerprintTree(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const siteRoot = resolveInside(root, options.site || '_site', 'site directory');
  if (!fs.existsSync(siteRoot) || !fs.statSync(siteRoot).isDirectory()) {
    throw new Error(`[fingerprint-static-tree] Site directory does not exist: ${siteRoot}`);
  }
  const files = listFiles(siteRoot);
  if (!files.length) throw new Error('[fingerprint-static-tree] Site tree is empty');
  return {
    fingerprint: fingerprintFiles(siteRoot, files),
    fileCount: files.length,
    siteRoot,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const root = path.resolve(__dirname, '..');
  const result = fingerprintTree({ root, site: args.site });
  if (args.write) {
    const output = resolveInside(root, args.write, 'fingerprint output');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${result.fingerprint}\n`, 'utf8');
    process.stdout.write(
      `[fingerprint-static-tree] recorded ${result.fileCount} files as ${result.fingerprint}\n`
    );
    return result;
  }

  const expectedFile = resolveInside(root, args.verify, 'fingerprint input');
  if (!fs.existsSync(expectedFile) || !fs.statSync(expectedFile).isFile()) {
    throw new Error(`[fingerprint-static-tree] Fingerprint input does not exist: ${expectedFile}`);
  }
  const expected = fs.readFileSync(expectedFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('[fingerprint-static-tree] Stored fingerprint is not SHA-256');
  }
  if (expected !== result.fingerprint) {
    throw new Error(
      `[fingerprint-static-tree] Site tree changed: expected ${expected}, got ${result.fingerprint}`
    );
  }
  process.stdout.write(
    `[fingerprint-static-tree] verified ${result.fileCount} unchanged files (${result.fingerprint})\n`
  );
  return result;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { fingerprintTree, main, parseArgs, resolveInside };
