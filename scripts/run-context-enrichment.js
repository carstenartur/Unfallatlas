'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateAll: validateContextDatasets } = require('./check-context-datasets');
const { slugify } = require('./lib/static-data-validation');

const ROOT = path.resolve(__dirname, '..');
const SELECTED_FILE = path.join(ROOT, '.build', 'context-selected-cities.txt');
const SUMMARY_FILE = path.join(ROOT, '.build', 'context-provider', 'context-enrichment-summary.json');
const DGM1_PROFILE_FILE = path.resolve(
  ROOT,
  String(process.env.HANNOVER_DGM1_PROFILE_FILE || '.build/context-provider/hannover-dgm1-road-profiles.json'),
);

const TRANSIENT_PROVIDER_PATTERNS = Object.freeze([
  { id: 'overpass-rate-limit', pattern: /Overpass HTTP 429\b/i },
  { id: 'overpass-server-error', pattern: /Overpass HTTP 5\d\d\b/i },
  { id: 'network-reset', pattern: /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|socket hang up)\b/i },
  { id: 'network-timeout', pattern: /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/i },
  { id: 'dns-temporary', pattern: /\b(?:EAI_AGAIN|temporary failure in name resolution)\b/i },
  { id: 'network-unreachable', pattern: /\b(?:ENETUNREACH|EHOSTUNREACH)\b/i },
  { id: 'provider-temporary', pattern: /\b(?:fetch failed|service unavailable|bad gateway|gateway timeout)\b/i },
]);

const NON_TRANSIENT_FAILURE_PATTERNS = Object.freeze([
  { id: 'invalid-accident-input', pattern: /Invalid accident GeoJSON|Missing input artifact/i },
  { id: 'producer-contract', pattern: /Producer preflight failed|producer did not create|producer skipped/i },
  { id: 'staged-validation', pattern: /Staged context validation failed|Enrichment produced no context data/i },
  { id: 'configuration', pattern: /Incomplete Hannover DGM1 configuration|DGM1 is required|Unknown city/i },
  { id: 'integrity', pattern: /(?:hash|fingerprint|integrity|schemaVersion).*mismatch|invalid JSON/i },
  { id: 'local-resource', pattern: /\b(?:ENOSPC|ENOMEM|EACCES|EPERM)\b/i },
  { id: 'programming-error', pattern: /\b(?:SyntaxError|ReferenceError|TypeError)\b/i },
]);

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value));
}

function currentOptions() {
  return {
    requestedCity: String(process.env.CONTEXT_CITY || '').trim(),
    force: envFlag('FORCE_CONTEXT'),
    requireHannoverDgm1: envFlag('CONTEXT_REQUIRE_HANNOVER_DGM1'),
    allowStaleOnTransient: envFlag('CONTEXT_ALLOW_STALE_ON_TRANSIENT'),
  };
}

function execute(relativeScript, args = [], env = {}, options = {}) {
  const capture = Boolean(options.capture);
  const result = spawnSync(process.execPath, [path.join(ROOT, relativeScript), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error && !options.allowFailure) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const error = new Error(`${relativeScript} exited with status ${result.status}`);
    error.result = result;
    throw error;
  }
  return result;
}

function run(relativeScript, args = [], env = {}) {
  return execute(relativeScript, args, env);
}

function configuredCities(requestedCity = currentOptions().requestedCity) {
  if (requestedCity) return [requestedCity];
  const source = fs.readFileSync(path.join(ROOT, 'cities.txt'), 'utf8');
  return source.split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function citySlug(value) {
  return slugify(value);
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

function applyHannoverDgm1(city, options = currentOptions()) {
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
    if (options.force) producerArgs.push('--force-context');
    run('scripts/producers/hannover_dgm1_road_profile_producer.js', producerArgs);
    run('scripts/apply-hannover-dgm1-road-profiles.js', [
      '--city', city,
      '--profiles', DGM1_PROFILE_FILE,
    ]);
    return true;
  }

  if (options.requireHannoverDgm1) {
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

function processFailureText(result) {
  return [
    result && result.error && result.error.message,
    result && result.stdout,
    result && result.stderr,
  ].filter(Boolean).join('\n');
}

function classifyProviderFailure(value) {
  const text = typeof value === 'string' ? value : processFailureText(value);
  const blocker = NON_TRANSIENT_FAILURE_PATTERNS.find(entry => entry.pattern.test(text));
  const transient = TRANSIENT_PROVIDER_PATTERNS.find(entry => entry.pattern.test(text));
  if (blocker) {
    return Object.freeze({ transient: false, id: blocker.id, evidence: blocker.pattern.source });
  }
  if (transient) {
    return Object.freeze({ transient: true, id: transient.id, evidence: transient.pattern.source });
  }
  return Object.freeze({ transient: false, id: 'unclassified', evidence: null });
}

function fallbackDecision({ allowStaleOnTransient, failureText, existingCity }) {
  const classification = classifyProviderFailure(failureText);
  if (!allowStaleOnTransient) {
    return Object.freeze({ allowed: false, reason: 'fallback-disabled', classification });
  }
  if (!classification.transient) {
    return Object.freeze({ allowed: false, reason: 'non-transient-failure', classification });
  }
  if (!existingCity || existingCity.ok !== true) {
    return Object.freeze({ allowed: false, reason: 'existing-context-invalid', classification });
  }
  return Object.freeze({ allowed: true, reason: 'verified-stale-context', classification });
}

function existingContextCity(city, validator = validateContextDatasets) {
  const slug = citySlug(city);
  const result = validator(ROOT);
  const cityResult = result.cities.find(entry => entry.slug === slug) || null;
  return cityResult && cityResult.ok === true ? cityResult : cityResult || null;
}

function writeSummary(summary) {
  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
}

function refreshCity(city, options, state) {
  const args = ['--city', city];
  if (options.force) args.push('--force');
  const result = execute('scripts/generate-context-city.js', args, {}, {
    capture: true,
    allowFailure: true,
  });

  if (result.error || result.status !== 0) {
    const existing = existingContextCity(city);
    const decision = fallbackDecision({
      allowStaleOnTransient: options.allowStaleOnTransient,
      failureText: processFailureText(result),
      existingCity: existing,
    });
    if (!decision.allowed) {
      const error = result.error || new Error(`scripts/generate-context-city.js exited with status ${result.status}`);
      error.contextFallbackDecision = decision;
      throw error;
    }

    console.warn(
      `[context-enrichment] ${city}: transient provider failure (${decision.classification.id}); ` +
      'retaining the last fully validated public context dataset.',
    );
    state.cities.push({
      city,
      slug: citySlug(city),
      status: 'retained-verified-stale',
      reason: decision.classification.id,
    });
    return { refreshed: false, dgm1Applied: false };
  }

  const dgm1Applied = applyHannoverDgm1(city, options);
  run('scripts/apply-qualitative-traffic-proxy.js', ['--city', city]);
  state.cities.push({
    city,
    slug: citySlug(city),
    status: 'refreshed',
    reason: null,
  });
  return { refreshed: true, dgm1Applied };
}

function validatePublishedTree(cities, refreshedCities = cities, runner = run) {
  const selectedSlugs = new Set(cities.map(citySlug));
  const refreshTargets = refreshedCities.filter(city => selectedSlugs.has(citySlug(city)));
  if (refreshTargets.length > 0) {
    runner('scripts/check-enrichment-inputs.js', refreshTargets.flatMap(city => ['--city', city]));
  } else {
    console.log(
      '[context-enrichment] No city was freshly generated; skipping temporary enrichment-input ' +
      'cache validation while retaining every public-data validation gate.',
    );
  }
  runner('scripts/gzip-static-data.js', ['--check', '--gzip-only'], {
    UNFALLATLAS_DATA_MODE: 'gzip-only',
  });
  runner('scripts/check-context-datasets.js', [], { UNFALLATLAS_DATA_MODE: 'gzip-only' });
  runner('scripts/check-slope-plausibility.js', [], { UNFALLATLAS_DATA_MODE: 'gzip-only' });
  runner('scripts/check-data-paths.js', ['--gzip-only', '--min-features', '10'], {
    UNFALLATLAS_DATA_MODE: 'gzip-only',
  });
}

function rebindAccidentPublicationManifest() {
  run('scripts/validate-accident-publication.js', [
    '--write-manifest',
    '--previous-manifest', 'data/accident-data-release.json',
    '--report', 'out/qa/context-accident-publication.json',
  ]);
  // Prove that the just-written oracle exactly represents the final public
  // bytes. This catches accidental post-manifest mutations in the same run.
  run('scripts/validate-accident-publication.js', [
    '--report', 'out/qa/context-accident-publication-verified.json',
  ]);
}

function main(options = currentOptions()) {
  const startedAt = new Date().toISOString();
  const cities = configuredCities(options.requestedCity);
  if (cities.length === 0) throw new Error('No context cities were selected');

  fs.mkdirSync(path.dirname(SELECTED_FILE), { recursive: true });
  fs.writeFileSync(SELECTED_FILE, `${cities.join('\n')}\n`);
  console.log(
    `[context-enrichment] Selected ${cities.length} city/cities; browser contract uses ${cities[0]}; ` +
    `allowStaleOnTransient=${options.allowStaleOnTransient}`,
  );

  const state = {
    schemaVersion: 1,
    contract: 'unfallwerkbank-context-enrichment-summary/v1',
    startedAt,
    completedAt: null,
    force: options.force,
    allowStaleOnTransient: options.allowStaleOnTransient,
    requestedCity: options.requestedCity || null,
    cities: [],
    totals: null,
  };

  try {
    let dgm1Applied = false;
    for (const city of cities) {
      const result = refreshCity(city, options, state);
      if (result.dgm1Applied) dgm1Applied = true;
    }

    const refreshedCities = state.cities
      .filter(city => city.status === 'refreshed')
      .map(city => city.city);
    validatePublishedTree(cities, refreshedCities);
    rebindAccidentPublicationManifest();

    state.completedAt = new Date().toISOString();
    state.hannoverDgm1Applied = dgm1Applied;
    state.totals = {
      selected: cities.length,
      refreshed: state.cities.filter(city => city.status === 'refreshed').length,
      retainedVerifiedStale: state.cities.filter(city => city.status === 'retained-verified-stale').length,
      failed: 0,
    };
    writeSummary(state);
    console.log(
      `[context-enrichment] PASS (${cities.length} city/cities, force=${options.force}, ` +
      `hannoverDgm1=${dgm1Applied}, staleFallbacks=${state.totals.retainedVerifiedStale})`,
    );
    return state;
  } catch (error) {
    state.completedAt = new Date().toISOString();
    state.totals = {
      selected: cities.length,
      refreshed: state.cities.filter(city => city.status === 'refreshed').length,
      retainedVerifiedStale: state.cities.filter(city => city.status === 'retained-verified-stale').length,
      failed: 1,
    };
    state.error = {
      name: error && error.name ? error.name : 'Error',
      message: error && error.message ? error.message : String(error),
      fallbackDecision: error && error.contextFallbackDecision
        ? error.contextFallbackDecision
        : null,
    };
    writeSummary(state);
    throw error;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[context-enrichment] FAILED:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ROOT,
  SELECTED_FILE,
  SUMMARY_FILE,
  TRANSIENT_PROVIDER_PATTERNS,
  NON_TRANSIENT_FAILURE_PATTERNS,
  envFlag,
  currentOptions,
  execute,
  run,
  configuredCities,
  citySlug,
  dgm1Configuration,
  applyHannoverDgm1,
  processFailureText,
  classifyProviderFailure,
  fallbackDecision,
  existingContextCity,
  writeSummary,
  refreshCity,
  validatePublishedTree,
  rebindAccidentPublicationManifest,
  main,
});