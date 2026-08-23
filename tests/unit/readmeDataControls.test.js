'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function section(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`Missing documentation section: ${heading}`);
  const next = markdown.indexOf('\n## ', start + heading.length);
  return markdown.slice(start, next < 0 ? markdown.length : next);
}

describe('user-first README data-status routing', () => {
  const readme = read('README.md');

  test('keeps availability visible without leading users into operator workflows', () => {
    const block = section(readme, '## Verfügbarkeit und Aktualität');

    expect(block).toContain('[Datenstatus und Aktualität](https://carstenartur.github.io/Unfallatlas/data-status/)');
    expect(block).toContain('[Städte- und Regionen-Katalog](docs/CITY_CATALOG.md)');
    expect(block).toContain('[Datenherkunft und Aktualisierungsverfahren](DATA_STATUS.md)');

    for (const workflow of ['generate-and-commit.yml', 'fetchpoi.yml', 'enrich.yml']) {
      expect(readme).not.toContain(`/actions/workflows/${workflow}`);
    }
  });

  test('keeps the precise official open-data licence in the user-facing source section', () => {
    const block = section(readme, '## Datenquelle und Lizenz');
    expect(block).toContain('https://www.govdata.de/dl-de/by-2-0');
  });
});

describe('operator data-update controls', () => {
  const status = read('DATA_STATUS.md');

  test.each([
    ['accidents', 'generate-and-commit.yml'],
    ['poi', 'fetchpoi.yml'],
    ['roads', 'enrich.yml'],
    ['slope', 'enrich.yml'],
    ['traffic', 'enrich.yml'],
  ])('keeps the %s status and its workflow action in one operator-table row', (family, workflow) => {
    const row = status.split(/\r?\n/).find((line) => line.includes(`/status/${family}.svg`));
    expect(row).toBeDefined();
    expect(row).toContain(`/actions/workflows/${workflow}`);
    expect(row).toMatch(/^\|\s*\*\*\d+\*\*\s*\|/);
  });

  test('documents the shared context workflow instead of presenting three independent jobs', () => {
    const slopeRow = status.split(/\r?\n/).find((line) => line.includes('/status/slope.svg'));
    const trafficRow = status.split(/\r?\n/).find((line) => line.includes('/status/traffic.svg'));

    expect(slopeRow).toContain('Bestandteil desselben Kontext-Workflows');
    expect(trafficRow).toContain('Bestandteil desselben Kontext-Workflows');
    expect(status).toContain('Schritt 3 folgt nach Schritt 1 automatisch');
  });
});
