'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function pomProperty(source, name) {
  const match = new RegExp(`<${name}>([^<]+)</${name}>`).exec(source);
  if (!match) throw new Error(`Missing Maven property ${name}`);
  return match[1].trim();
}

describe('canonical frontend toolchain contract', () => {
  test('package metadata declares the npm version installed by Maven', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const declaredNpm = /^npm@(.+)$/.exec(pkg.packageManager || '');

    expect(declaredNpm).not.toBeNull();
    expect(declaredNpm[1]).toBe(pomProperty(pom, 'npm.version'));
  });

  test('the Node engine accepts the major version installed by Maven', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const nodeVersion = pomProperty(pom, 'node.version').replace(/^v/, '');
    const nodeMajor = nodeVersion.split('.')[0];

    expect(pkg.engines.node).toBe(`${nodeMajor}.x`);
  });
});
