'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REQUESTED_CITY = String(process.env.CONTEXT_CITY || '').trim();
const FORCE = /^(?:1|true|yes)$/i.test(String(process.env.FORCE_CONTEXT || 'false'));
const SELECTED_FILE = path.join(ROOT, '.build', 'context-selected-cities.txt');

function run(relativeScript, args = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, relativeScript), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${relativeScript} exited with status ${result.status}`);
}

function configuredCities() {
  if (REQUESTED_CITY) return [REQUESTED_CITY];
  const source = fs.readFileSync(path.join(ROOT, 'cities.txt'), 'utf8');
  return source.split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

const cities = configuredCities();
if (cities.length === 0) throw new Error('No context cities were selected');
fs.mkdirSync(path.dirname(SELECTED_FILE), { recursive: true });
fs.writeFileSync(SELECTED_FILE, `${cities.join('\n')}\n`);
console.log(`[context-enrichment] Selected ${cities.length} city/cities; browser contract uses ${cities[0]}`);

for (const city of cities) {
  const args = ['--city', city];
  if (FORCE) args.push('--force');
  run('scripts/generate-context-city.js', args);
  run('scripts/apply-qualitative-traffic-proxy.js', ['--city', city]);
}

run('scripts/check-enrichment-inputs.js', cities.flatMap(city => ['--city', city]));
run('scripts/gzip-static-data.js', ['--check', '--gzip-only'], {
  UNFALLATLAS_DATA_MODE: 'gzip-only',
});
run('scripts/check-context-datasets.js', [], { UNFALLATLAS_DATA_MODE: 'gzip-only' });
run('scripts/check-slope-plausibility.js', [], { UNFALLATLAS_DATA_MODE: 'gzip-only' });
run('scripts/check-data-paths.js', ['--gzip-only', '--min-features', '10'], {
  UNFALLATLAS_DATA_MODE: 'gzip-only',
});

console.log(`[context-enrichment] PASS (${cities.length} city/cities, force=${FORCE})`);
