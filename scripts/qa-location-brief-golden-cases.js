#!/usr/bin/env node
'use strict';

/**
 * Fast, Docker-free fachliche preflight for issue #296.
 *
 * This command deliberately stops before persistence. It reads the real
 * Bonn/Hannover accident files, builds the same deterministic Location Action
 * Briefs as the server and checks patterns, evidence, measures, confidence and
 * a score-based local ranking. The Testcontainers suite remains the binding
 * end-to-end gate for persistence and Spring Batch ranking.
 */

const fs = require('fs');
const path = require('path');
const { buildLocationBrief } = require('../server/location-brief');
const { buildStructuredFromCase } = require('./lib/location-brief-golden-case-data');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FIXTURE = path.resolve(REPO_ROOT, 'tests/fixtures/location-brief-golden-cases.json');
const DEFAULT_JSON = path.resolve(REPO_ROOT, 'out/qa/location-brief-golden-preflight.json');
const DEFAULT_MARKDOWN = path.resolve(REPO_ROOT, 'out/qa/location-brief-golden-preflight.md');
const PROFILE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_FIXTURE,
    json: DEFAULT_JSON,
    markdown: DEFAULT_MARKDOWN,
    failOnMismatch: true
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--fixture') options.fixture = path.resolve(argv[++index]);
    else if (arg === '--json') options.json = path.resolve(argv[++index]);
    else if (arg === '--markdown') options.markdown = path.resolve(argv[++index]);
    else if (arg === '--no-fail') options.failOnMismatch = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  return [
    'Usage: node scripts/qa-location-brief-golden-cases.js [options]',
    '',
    'Options:',
    '  --fixture <path>   Golden-case definition (default: tests/fixtures/location-brief-golden-cases.json)',
    '  --json <path>      JSON report path (default: out/qa/location-brief-golden-preflight.json)',
    '  --markdown <path>  Markdown report path (default: out/qa/location-brief-golden-preflight.md)',
    '  --no-fail          Write the diagnostic report but do not exit non-zero on mismatches',
    '  -h, --help         Show this help'
  ].join('\n');
}

function addCheck(checks, id, passed, expected, actual, note) {
  checks.push({
    id,
    passed: Boolean(passed),
    expected,
    actual,
    ...(note ? { note } : {})
  });
}

function includesForbiddenClaim(brief, claim) {
  const text = [
    brief.problemSummary,
    ...(brief.uncertainties?.notes || []),
    ...(brief.conflictPatterns || []).map((pattern) => pattern.rationale || '')
  ].join(' ');
  return text.includes(claim);
}

function evaluateCase(city, caseDef, profile) {
  const structured = buildStructuredFromCase({ ...caseDef, city }, { repoRoot: REPO_ROOT });
  const brief = buildLocationBrief({
    structured,
    locationId: `${city.toLowerCase()}::${caseDef.caseId}`,
    profile,
    contextHints: caseDef.contextHints,
    politicalContext: caseDef.politicalContext
  });

  const conflictPatterns = brief.conflictPatterns || [];
  const recommended = brief.recommendedMeasures || [];
  const candidates = brief.candidateMeasures || [];
  const patterns = conflictPatterns.map((pattern) => pattern.id);
  const recommendedMeasures = recommended.map((measure) => measure.id);
  const candidateMeasures = candidates.map((measure) => measure.id);
  const allMeasureIds = [...new Set([...recommendedMeasures, ...candidateMeasures])];
  const checks = [];

  addCheck(
    checks,
    'minimum-accident-count',
    structured.severity.total >= Number(caseDef.expectedMinAccidents || 0),
    `>= ${Number(caseDef.expectedMinAccidents || 0)}`,
    structured.severity.total
  );

  for (const expectedPattern of (caseDef.expectedPatterns || [])) {
    const pattern = conflictPatterns.find((item) => item.id === expectedPattern);
    addCheck(checks, `pattern:${expectedPattern}`, Boolean(pattern), true, Boolean(pattern));
    addCheck(
      checks,
      `pattern-evidence:${expectedPattern}`,
      Boolean(pattern && Array.isArray(pattern.evidence) && pattern.evidence.length > 0),
      'at least one evidence item',
      pattern && Array.isArray(pattern.evidence) ? pattern.evidence.length : 0
    );
  }

  if ((caseDef.expectedMeasureIdsAnyOf || []).length > 0) {
    const matching = caseDef.expectedMeasureIdsAnyOf.filter((id) => allMeasureIds.includes(id));
    addCheck(checks, 'expected-measure-any-of', matching.length > 0, caseDef.expectedMeasureIdsAnyOf, matching);
  }

  for (const forbiddenMeasure of (caseDef.mustNotHaveMeasureIds || [])) {
    addCheck(
      checks,
      `forbidden-recommended-measure:${forbiddenMeasure}`,
      !recommendedMeasures.includes(forbiddenMeasure),
      false,
      recommendedMeasures.includes(forbiddenMeasure)
    );
  }

  for (const forbiddenClaim of (caseDef.mustNotContainClaims || [])) {
    const contained = includesForbiddenClaim(brief, forbiddenClaim);
    addCheck(checks, `forbidden-claim:${forbiddenClaim}`, !contained, false, contained);
  }

  const genericReasons = recommended.filter((measure) => {
    if (typeof measure.whyPreselected !== 'string' || !measure.whyPreselected.trim()) return true;
    const hasStructuredReason = (measure.matchedConflictPatterns || []).length > 0
      || (measure.matchedRiskFactors || []).length > 0;
    return !hasStructuredReason && !/datenlage|vor[- ]?ort|monitoring/i.test(measure.whyPreselected);
  }).map((measure) => measure.id);
  addCheck(checks, 'specific-why-preselected', genericReasons.length === 0, [], genericReasons);

  if (caseDef.expectedWeakDataBasis) {
    addCheck(checks, 'weak-data-basis', brief.uncertainties?.weakDataBasis === true, true, brief.uncertainties?.weakDataBasis);
    addCheck(checks, 'weak-data-confidence', brief.confidence?.overall === 'low', 'low', brief.confidence?.overall);
  }

  if (caseDef.expectPolicyReadiness) {
    addCheck(
      checks,
      'policy-readiness',
      brief.politicalContext?.policyReadiness === caseDef.expectPolicyReadiness,
      caseDef.expectPolicyReadiness,
      brief.politicalContext?.policyReadiness
    );
  }

  if (caseDef.expectPolicyReadinessMin) {
    const actual = brief.politicalContext?.policyReadiness;
    addCheck(
      checks,
      'minimum-policy-readiness',
      PROFILE_RANK[actual] >= PROFILE_RANK[caseDef.expectPolicyReadinessMin],
      `>= ${caseDef.expectPolicyReadinessMin}`,
      actual
    );
  }

  return {
    caseId: caseDef.caseId,
    kind: caseDef.kind,
    description: caseDef.description,
    bbox: caseDef.bbox,
    accidentCount: structured.severity.total,
    severeAccidentCount: Number(structured.severity.bySev['1'] || 0)
      + Number(structured.severity.bySev['2'] || 0),
    score: brief.deterministicFindings?.activeProfileScore?.total,
    patterns,
    patternEvidence: Object.fromEntries(conflictPatterns.map((pattern) => [pattern.id, pattern.evidence || []])),
    recommendedMeasures,
    candidateMeasures,
    whyPreselected: Object.fromEntries(recommended.map((measure) => [measure.id, measure.whyPreselected || ''])),
    confidence: brief.confidence,
    uncertainties: brief.uncertainties,
    policyReadiness: brief.politicalContext?.policyReadiness,
    checks,
    passed: checks.every((check) => check.passed)
  };
}

function applyLocalRanking(cityResult, caseDefinitions) {
  const sorted = cityResult.cases.slice().sort((a, b) => {
    const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
    return scoreDiff !== 0 ? scoreDiff : a.caseId.localeCompare(b.caseId);
  });
  sorted.forEach((item, index) => { item.localPreflightRank = index + 1; });

  const byId = new Map(sorted.map((item) => [item.caseId, item]));
  const positiveRanks = [];

  for (const caseDef of caseDefinitions) {
    const result = byId.get(caseDef.caseId);
    if (!result || caseDef.kind !== 'positive') continue;
    positiveRanks.push(result.localPreflightRank);
    addCheck(
      result.checks,
      'local-preflight-top-n',
      result.localPreflightRank <= Number(caseDef.expectedTopN),
      `<= ${caseDef.expectedTopN}`,
      result.localPreflightRank,
      'Diagnostic only; the binding rank is produced by Spring Batch in the Testcontainers suite.'
    );
  }

  const lowestPositiveRank = positiveRanks.length > 0 ? Math.max(...positiveRanks) : 0;
  for (const caseDef of caseDefinitions.filter((item) => item.kind === 'negative')) {
    const result = byId.get(caseDef.caseId);
    if (!result) continue;
    addCheck(
      result.checks,
      'negative-below-positive-cases',
      result.localPreflightRank > lowestPositiveRank,
      `> ${lowestPositiveRank}`,
      result.localPreflightRank,
      'Diagnostic only; the binding rank is produced by Spring Batch in the Testcontainers suite.'
    );
  }

  for (const result of cityResult.cases) {
    result.passed = result.checks.every((check) => check.passed);
  }
}

function buildArtifact(fixturePath) {
  const profile = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const artifact = {
    schemaVersion: 'locationBriefGoldenPreflight.v1',
    generatedAt: new Date().toISOString(),
    profile: profile.profile,
    mode: 'node-preflight',
    pipelineRoles: {
      realAccidentDataAndBoundingBoxes: true,
      nodeComputesLocationBriefs: true,
      fixtureSuppliesSelectedContextHints: true,
      analysisServicePersistenceChecked: false,
      springBatchRankingChecked: false,
      bindingEndToEndCommand: 'npm run test:location-brief-golden:tc'
    },
    cities: []
  };

  for (const cityDef of profile.cities || []) {
    const cityResult = {
      city: cityDef.city,
      cases: (cityDef.cases || []).map((caseDef) => evaluateCase(cityDef.city, caseDef, profile.profile))
    };
    applyLocalRanking(cityResult, cityDef.cases || []);
    artifact.cities.push(cityResult);
  }

  const cases = artifact.cities.flatMap((city) => city.cases);
  const failedChecks = artifact.cities.flatMap((city) => city.cases.flatMap((item) => item.checks
    .filter((check) => !check.passed)
    .map((check) => ({ city: city.city, caseId: item.caseId, ...check }))
  ));

  artifact.summary = {
    cityCount: artifact.cities.length,
    caseCount: cases.length,
    positiveCaseCount: cases.filter((item) => item.kind === 'positive').length,
    negativeCaseCount: cases.filter((item) => item.kind === 'negative').length,
    passedCaseCount: cases.filter((item) => item.passed).length,
    failedCaseCount: cases.filter((item) => !item.passed).length,
    failedCheckCount: failedChecks.length,
    passed: failedChecks.length === 0
  };
  artifact.failedChecks = failedChecks;
  return artifact;
}

/**
 * Encode untrusted values for a GitHub-flavoured Markdown table cell.
 * HTML entities avoid ambiguous multi-stage backslash escaping: a source
 * backslash cannot escape the entity used for a following pipe character.
 */
function markdownCell(value) {
  return String(value ?? '')
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\\/g, '&#92;')
    .replace(/\|/g, '&#124;');
}

function renderMarkdown(artifact) {
  const lines = [
    '# Location Action Brief Golden-Case Preflight',
    '',
    `Generated: ${artifact.generatedAt}`,
    '',
    `Result: **${artifact.summary.passed ? 'PASS' : 'FAIL'}** — ${artifact.summary.passedCaseCount}/${artifact.summary.caseCount} cases passed.`,
    '',
    'This preflight uses the real Bonn/Hannover accident coordinates and the fixture bounding boxes. Selected context hints and political references are fixture inputs. Persistence and the binding Spring Batch ranking are checked only by `npm run test:location-brief-golden:tc`.',
    ''
  ];

  for (const city of artifact.cities) {
    lines.push(
      `## ${markdownCell(city.city)}`,
      '',
      '| Case | Kind | Accidents | Severe | Score | Local rank | Patterns | Recommended measures | Confidence | Result |',
      '|---|---:|---:|---:|---:|---:|---|---|---|---|'
    );
    for (const item of city.cases.slice().sort((a, b) => a.localPreflightRank - b.localPreflightRank)) {
      lines.push(`| ${[
        markdownCell(item.caseId),
        markdownCell(item.kind),
        item.accidentCount,
        item.severeAccidentCount,
        Number(item.score || 0).toFixed(3),
        item.localPreflightRank,
        markdownCell(item.patterns.join(', ')),
        markdownCell(item.recommendedMeasures.join(', ')),
        markdownCell(item.confidence?.overall),
        item.passed ? 'PASS' : 'FAIL'
      ].join(' | ')} |`);
    }
    lines.push('');
  }

  if (artifact.failedChecks.length > 0) {
    lines.push('## Mismatches', '');
    for (const failure of artifact.failedChecks) {
      lines.push(
        `- **${markdownCell(failure.city)} / ${markdownCell(failure.caseId)} / ${markdownCell(failure.id)}:** `
        + `expected ${markdownCell(JSON.stringify(failure.expected))}, `
        + `got ${markdownCell(JSON.stringify(failure.actual))}.`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Interpretation boundary',
    '',
    '- A passing result shows deterministic consistency with the currently curated expectations; it does not prove accident causation.',
    '- The positive fixtures intentionally contain selected context hints. They therefore do not demonstrate automatic discovery of those hints from raw accident data alone.',
    '- The negative controls test restraint for sparse data and unsuitable high-specificity measures.',
    '- Human review of at least one Bonn and one Hannover result remains the closure gate for issue #296.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const artifact = buildArtifact(options.fixture);
  writeFile(options.json, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFile(options.markdown, renderMarkdown(artifact));

  process.stdout.write([
    `Golden-case preflight: ${artifact.summary.passed ? 'PASS' : 'FAIL'}`,
    `Cases: ${artifact.summary.passedCaseCount}/${artifact.summary.caseCount}`,
    `JSON: ${options.json}`,
    `Markdown: ${options.markdown}`,
    ''
  ].join('\n'));
  if (!artifact.summary.passed && options.failOnMismatch) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[location-brief-golden-preflight] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  evaluateCase,
  applyLocalRanking,
  buildArtifact,
  markdownCell,
  renderMarkdown
};
