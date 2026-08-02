'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('accident data publication is fail-closed and atomic', () => {
  test('repair and staged installation require every discovered official year', () => {
    const generator = read('scripts/generate-accident-data.js');
    expect(generator).toContain('requiredYears: requiredYears == null ? [] : requiredYears');
    expect(generator).toContain('requiredYears: years');
    expect(generator).not.toContain('requiredYears: highestYear == null ? [] : [highestYear]');
  });

  test('reviewed policy binds the exact official 2025 release', () => {
    const policy = JSON.parse(read('config/accident-data-policy.json'));
    expect(policy.contract).toBe('unfallwerkbank-accident-data-policy/v1');
    expect(policy.firstYear).toBe(2016);
    expect(policy.expectedLatestYear).toBe(2025);
    expect(policy.officialReleaseDate).toBe('2026-07-07');
    expect(policy.minimumConfiguredCities).toBeGreaterThanOrEqual(26);
    expect(policy.canonicalScenarioMinimums['bonn-bike-car-and']).toBeGreaterThan(1);
  });

  test('all product mutations precede the final gates and the payload is reverified afterwards', () => {
    const workflow = read('.github/workflows/generate-and-commit.yml');
    const registryFix = workflow.indexOf('node scripts/check-city-rollout.js --fix');
    const manifest = workflow.indexOf('scripts/validate-accident-publication.js');
    const prepare = workflow.indexOf('npm run prepare:accident-publication');
    const maven = workflow.indexOf('mvn -B -ntp clean verify -Ppages,system-it');
    const verify = workflow.indexOf('npm run verify:accident-publication');
    const publishJob = workflow.indexOf('publish-pull-request:');

    expect(registryFix).toBeGreaterThan(0);
    expect(manifest).toBeGreaterThan(registryFix);
    expect(prepare).toBeGreaterThan(manifest);
    expect(maven).toBeGreaterThan(prepare);
    expect(verify).toBeGreaterThan(maven);
    expect(publishJob).toBeGreaterThan(verify);
  });

  test('build and test jobs never receive persistent write credentials', () => {
    const workflow = read('.github/workflows/generate-and-commit.yml');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('persist-credentials: true');
    expect(workflow.indexOf('permissions:\n      contents: write'))
      .toBeGreaterThan(workflow.indexOf('publish-pull-request:'));
  });

  test('publication stages only the manifest allowlist and opens a PR instead of pushing main', () => {
    const workflow = read('.github/workflows/generate-and-commit.yml');
    expect(workflow).not.toContain('git add -A');
    expect(workflow).not.toContain('git push origin HEAD:${{ github.ref_name }}');
    expect(workflow).not.toContain('HEAD:refs/heads/main');
    expect(workflow).toContain('changed-paths.txt');
    expect(workflow).toContain('git add -- "$file"');
    expect(workflow).toContain('gh pr create');
    expect(workflow).toContain('gh pr edit');
    expect(workflow).toContain('automation/accident-data-refresh');
  });

  test('the write job resets its branch before applying the verified payload', () => {
    const workflow = read('.github/workflows/generate-and-commit.yml');
    const publishJob = workflow.indexOf('publish-pull-request:');
    const reset = workflow.indexOf('git switch -C "$PUBLISH_BRANCH" "$GITHUB_SHA"', publishJob);
    const apply = workflow.indexOf('Verify and apply package without executing repository code', publishJob);
    const stage = workflow.indexOf('Stage exactly the verified allowlist', publishJob);
    expect(reset).toBeGreaterThan(publishJob);
    expect(apply).toBeGreaterThan(reset);
    expect(stage).toBeGreaterThan(apply);
  });

  test('mandatory evidence and immutable payload fail when absent', () => {
    const workflow = read('.github/workflows/generate-and-commit.yml');
    expect(workflow).toContain('accident-data-publication-${{ github.run_id }}');
    expect(workflow).toContain('out/qa/accident-publication.json');
    expect(workflow.match(/if-no-files-found: error/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workflow).not.toContain('if-no-files-found: ignore');
  });

  test('JUnit executes the complete publication audit rather than a parallel Java model', () => {
    const junit = read('qa-system-tests/src/test/java/de/unfallatlas/qa/CheckedInAccidentDataIT.java');
    expect(junit).toContain('validate-accident-publication.js');
    expect(junit).toContain('data/accident-data-release.json');
    expect(junit).toContain('config/accident-data-policy.json');
  });
});
