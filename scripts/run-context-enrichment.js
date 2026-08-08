'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REQUESTED_CITY = String(process.env.CONTEXT_CITY || '').trim();
const FORCE = /^(?:1|true|yes)$/i.test(String(process.env.FORCE_CONTEXT || 'false'));
const REQUIRE_HANNOVER_DGM1 = /^(?:1|true|yes)$/i.test(
  String(process.env.CONTEXT_REQUIRE_HANNOVER_DGM1 || 'false'),
);
const SELECTED_FILE = path.join(ROOT, '.build', 'context-selected-cities.txt');
const DGM1_PROFILE_FILE = path.resolve(
  ROOT,
  String(process.env.HANNOVER_DGM1_PROFILE_FILE || '.build/context-provider/hannover-dgm1-road-profiles.json'),
);

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

function citySlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dgm1Configuration() {
  const root = String(process.env.HANNOVER_DGM1_ROOT || '').trim();
  const manifest = String(process.env.HANNOVER_DGM1_MANIFEST || '').trim();
  const manifestSha256 = String(process.env.HANNOVER_DGM1_MANIFEST_SHA256 || '').trim();
  const supplied = [root, manifest, manifestSha256].filter(Boolean).length;
  if (supplied > 0 && supplied < 3) {
    throw new Error(
      'Incomplete Hannover DGM1 configuration: HANNOVER_DGM1_ROOT, ' +
      'HANNOVER_DGM1_MANIFEST and HANNOVER_DGM1_MANIFEST_SHA256 are an atomic contract',
    );
  }
  if (manifestSha256 && !/^[a-f0-9]{64}$/i.test(manifestSha256)) {
    throw new Error('HANNOVER_DGM1_MANIFEST_SHA256 must be exactly 64 hexadecimal characters');
  }
  return supplied === 3 ? { root, manifest, manifestSha256 } : null;
}

function applyHannoverDgm1(city) {
  if (citySlug(city) !== 'hannover') return false;
  const precomputed = String(process.env.HANNOVER_DGM1_PRECOMPUTED_PROFILES || '').trim();
  const configuration = dgm1Configuration();

  if (precomputed) {
    run('scripts/apply-hannover-dgm1-road-profiles.js', [
      '--city', city,
      '--profiles', precomputed,
    ]);
    return true;
  }

  if (configuration) {
    fs.mkdirSync(path.dirname(DGM1_PROFILE_FILE), { recursive: true });
    const producerArgs = [
      '--osm', path.join(ROOT, '.enrichment-cache', 'osm', 'osm_hannover.json'),
      '--dgm-root', configuration.root,
      '--dgm-manifest', configuration.manifest,
      '--dgm-manifest-sha256', configuration.manifestSha256,
      '--output', DGM1_PROFILE_FILE,
    ];
    if (FORCE) producerArgs.push('--force-context');
    run('scripts/producers/hannover_dgm1_road_profile_producer.js', producerArgs);
    run('scripts/apply-hannover-dgm1-road-profiles.js', [
      '--city', city,
      '--profiles', DGM1_PROFILE_FILE,
    ]);
    return true;
  }

  if (REQUIRE_HANNOVER_DGM1) {
    throw new Error(
      'Hannover DGM1 is required, but neither a precomputed profile artifact nor the ' +
      'complete pinned DGM1 snapshot configuration was supplied',
    );
  }
  console.warn(
    '[context-enrichment] Hannover DGM1 is not configured; retaining the explicitly ' +
    'labelled coarse SRTM terrain fallback for this run',
  );
  return false;
}

const cities = configuredCities();
if (cities.length === 0) throw new Error('No context cities were selected');
fs.mkdirSync(path.dirname(SELECTED_FILE), { recursive: true });
fs.writeFileSync(SELECTED_FILE, `${cities.join('\n')}\n`);
console.log(`[context-enrichment] Selected ${cities.length} city/cities; browser contract uses ${cities[0]}`);

let dgm1Applied = false;
for (const city of cities) {
  const args = ['--city', city];
  if (FORCE) args.push('--force');
  run('scripts/generate-context-city.js', args);
  if (applyHannoverDgm1(city)) dgm1Applied = true;
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

console.log(
  `[context-enrichment] PASS (${cities.length} city/cities, force=${FORCE}, ` +
  `hannoverDgm1=${dgm1Applied})`,
);