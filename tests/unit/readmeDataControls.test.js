'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function readDataControlsBlock() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## Datenstatus und Aktualisierung');
  const end = readme.indexOf('\nhttps://doi.org/', start);
  if (start < 0 || end < 0) throw new Error('README data controls block is missing');
  return readme.slice(start, end);
}

describe('README data update controls', () => {
  test('keeps every mobile control in one table row with an unambiguous step', () => {
    const block = readDataControlsBlock();
    expect(block).toContain('| Datenbestand | Status und Aktualisierung |');
    expect(block).toContain('**1 · Unfalldaten**');
    expect(block).toContain('**2 · Schulen und Kitas**');
    expect(block).toContain('**3a · Straßenkontext**');
    expect(block).toContain('**3b · Steigung**');
    expect(block).toContain('**3c · Verkehr**');
    expect(block).not.toContain('**3.**');
  });

  test.each([
    ['accidents', 'generate-and-commit.yml'],
    ['poi', 'fetchpoi.yml'],
    ['roads', 'enrich.yml'],
    ['slope', 'enrich.yml'],
    ['traffic', 'enrich.yml'],
  ])('places the %s status and compact workflow button in the same row', (family, workflow) => {
    const block = readDataControlsBlock();
    const row = block.split('\n').find((line) => line.includes(`/status/${family}.svg?readme=`));
    expect(row).toBeDefined();
    expect(row).toContain(`/actions/workflows/${workflow}`);
    expect(row).toContain('img.shields.io/badge/%E2%96%B6--2ea44f');
    expect(row.split('|')).toHaveLength(4);
  });

  test('does not reintroduce the wide mobile button that caused wrapping', () => {
    expect(readDataControlsBlock()).not.toContain('%E2%96%B6-Aktualisieren-2ea44f');
  });
});
