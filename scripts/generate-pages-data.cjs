#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = '.build/raw';
const ENRICHED_DIR = '.build/enriched';

function display(command, args) {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

function run(command, args, options = {}) {
  process.stdout.write(`\n[pages-data] $ ${display(command, args)}\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[pages-data] Command failed with exit code ${result.status}: ${display(command, args)}`);
  }
}

function runNode(relativeScript, args = []) {
  run(process.execPath, [path.resolve(ROOT, relativeScript), ...args]);
}

function cities() {
  const file = path.join(ROOT, 'cities.txt');
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

function resolveBash() {
  return process.env.BASH || 'bash';
}

function prepareDirectories() {
  fs.rmSync(path.join(ROOT, '.build'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '_site'), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, RAW_DIR), { recursive: true });
  fs.mkdirSync(path.join(ROOT, ENRICHED_DIR), { recursive: true });
}

function generateRawData(cityNames) {
  const args = [
    path.resolve(ROOT, 'convertAmt2gmaps.sh'),
    '--outdir', RAW_DIR,
    '--limit', '0',
  ];
  for (const city of cityNames) args.push('--city', city);
  args.push('--rad', '', '--pkw', '', '--fuss', '', '--krad', '');
  run(resolveBash(), args);
  runNode('scripts/check-data-paths.js', ['--dir', RAW_DIR, '--min-features', '10']);
}

function generateContextData(cityNames) {
  for (const city of cityNames) {
    runNode('scripts/generate-context-city.js', [
      '--city', city,
      '--input-dir', RAW_DIR,
      '--output-dir', ENRICHED_DIR,
    ]);
  }
}

function buildTiles() {
  runNode('scripts/build-accident-tiles.js', [
    '--input-dir', ENRICHED_DIR,
    '--output-dir', ENRICHED_DIR,
  ]);
}

function main() {
  const cityNames = cities();
  if (cityNames.length === 0) throw new Error('[pages-data] cities.txt contains no cities');
  prepareDirectories();
  generateRawData(cityNames);
  generateContextData(cityNames);
  buildTiles();
  process.stdout.write(`\n[pages-data] Generated verified data for ${cityNames.length} cities.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
