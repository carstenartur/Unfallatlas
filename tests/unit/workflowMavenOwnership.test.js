'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW_DIRECTORY = path.join(ROOT, '.github', 'workflows');
const NON_BUILD_AUTOMATION = new Set([
  'fetchpoi.yml',
  'generate-and-commit.yml',
  'word-compatibility-evidence.yml',
  // Transitional one-off automation only; workflow and this exemption are removed atomically before merge.
  'apply-readme-media-fix.yml',
]);

function workflows() {
  return fs.readdirSync(WORKFLOW_DIRECTORY)
    .filter(name => /\.ya?ml$/i.test(name))
    .sort()
    .map(name => ({
      name,
      source: fs.readFileSync(path.join(WORKFLOW_DIRECTORY, name), 'utf8'),
    }));
}

function executableLines(source) {
  return source.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function jobSections(source) {
  const lines = source.split(/\r?\n/);
  const sections = [];
  let inJobs = false;
  let current = null;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^[^\s]/.test(line) && line.trim()) break;
    const job = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      current = { name: job[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

function workflowSource(name) {
  return fs.readFileSync(path.join(WORKFLOW_DIRECTORY, name), 'utf8');
}

function stepSection(source, stepName) {
  const marker = `      - name: ${stepName}`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const next = source.indexOf('\n      - name: ', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

describe('GitHub Actions delegates repository build and QA to Maven', () => {
  test('build and QA workflow YAML contains no direct Node, npm, Jest, Playwright or JS-Testcontainers orchestration', () => {
    const forbidden = [
      { label: 'npm command', pattern: /\bnpm\s+(?:ci|install|run|test|exec)\b/ },
      { label: 'npx command', pattern: /\bnpx\b/ },
      { label: 'repository Node script', pattern: /\bnode\s+(?:\.\/)?(?:scripts|tests)\// },
      { label: 'Playwright test command', pattern: /\bplaywright\s+test\b/ },
      { label: 'Jest command', pattern: /(?:^|\s)jest(?:\s|$)/ },
      { label: 'JavaScript Testcontainers suite', pattern: /test:integration:tc|test:location-brief-golden:tc/ },
    ];

    const violations = [];
    for (const workflow of workflows()) {
      if (NON_BUILD_AUTOMATION.has(workflow.name)) continue;
      for (const line of executableLines(workflow.source)) {
        for (const rule of forbidden) {
          if (rule.pattern.test(line)) {
            violations.push(`${workflow.name}: ${rule.label}: ${line}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('each Maven-owned workflow job invokes Maven at most once', () => {
    const violations = [];
    for (const workflow of workflows()) {
      if (NON_BUILD_AUTOMATION.has(workflow.name)) continue;
      for (const job of jobSections(workflow.source)) {
        const invocations = job.lines
          .map(line => line.trim())
          .filter(line => /^run:\s+(?:\.\/mvnw|mvn)\b/.test(line)
            || /^(?:\.\/mvnw|mvn)\b/.test(line));
        if (invocations.length > 1) {
          violations.push(`${workflow.name}/${job.name}: ${invocations.join(' | ')}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('specialized workflows call documented Maven profiles', () => {
    const expected = {
      'test.yml': [
        '-Ppages',
        '-Pe2e,system-it,location-brief-golden,context-data-e2e',
        '-Dcontext.city=Hannover',
      ],
      'docker-publish.yml': ['-Pvideo-export-it', '-Prelease-site'],
      'rendered-document-poppler.yml': ['-Pdocument-render'],
      'enrich.yml': ['-Pcontext-data-e2e'],
      'generate-screenshots.yml': ['-Pdocumentation-live'],
      'visual-check.yml': ['-Pdocumentation-live'],
      'regenerate-readme-demo-candidate.yml': ['-Preadme-demo-candidate'],
      'deploy-release.yml': [
        '-Prelease-site,pages,e2e,system-it,location-brief-golden,document-render',
        "'-Dfailsafe.includes=**/*IT.java'",
      ],
      'deploy-pages-current-data.yml': ['-Ppages'],
      'generate-data-deploy-pages.yml': ['-Ppages-regenerated'],
    };
    const byName = new Map(workflows().map(workflow => [workflow.name, workflow.source]));
    for (const [name, fragments] of Object.entries(expected)) {
      expect(byName.has(name)).toBe(true);
      for (const fragment of fragments) expect(byName.get(name)).toContain(fragment);
    }
  });

  test('the root POM owns every workflow-facing QA profile', () => {
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    for (const profile of [
      'pages',
      'pages-regenerated',
      'e2e',
      'system-it',
      'video-export-it',
      'readme-demo-candidate',
      'location-brief-golden',
      'document-render',
      'context-data-e2e',
      'documentation-live',
      'release-site',
    ]) {
      expect(pom).toContain(`<id>${profile}</id>`);
    }
  });

  test('the release workflow has no test-skipping input or Maven bypass', () => {
    const release = workflowSource('deploy-release.yml');

    expect(release).not.toMatch(/^\s+skip_tests:\s*$/m);
    expect(release).not.toContain('inputs.skip_tests');
    expect(release).not.toContain('-DskipTests');
    expect(release).not.toContain('maven.test.skip');
    expect(release).not.toContain('Skip tests');
  });

  test('the release commit runs the complete acceptance matrix before any remote mutation', () => {
    const release = workflowSource('deploy-release.yml');
    const commitRelease = release.indexOf('      - name: Commit release version changes');
    const acceptance = release.indexOf('      - name: Run the canonical release acceptance matrix');
    const firstRemoteMutation = release.indexOf('      - name: Push release commit to remote');
    const acceptanceStep = stepSection(
      release,
      'Run the canonical release acceptance matrix'
    );

    expect(commitRelease).toBeGreaterThan(-1);
    expect(acceptance).toBeGreaterThan(commitRelease);
    expect(firstRemoteMutation).toBeGreaterThan(acceptance);
    expect(acceptanceStep).toContain("PLAYWRIGHT_INSTALL_SYSTEM_DEPS: '1'");
    expect(acceptanceStep).toContain(
      '-Prelease-site,pages,e2e,system-it,location-brief-golden,document-render'
    );
    expect(acceptanceStep).toContain("'-Dfailsafe.includes=**/*IT.java'");
    expect(acceptanceStep).toContain('| tee out/qa/maven-release-acceptance.log');
    expect(acceptanceStep).not.toMatch(
      /\n\s+if:\s*\$\{\{\s*!?inputs\.dry_run\s*\}\}/
    );
  });

  test('release diagnostics survive failures and dry runs cannot mutate remote release state', () => {
    const release = workflowSource('deploy-release.yml');
    const evidence = stepSection(release, 'Upload release acceptance evidence');
    const dryRunAssets = stepSection(release, 'Upload dry-run release candidate assets');

    expect(evidence).toContain('if: always()');
    for (const pathFragment of [
      'out/qa/',
      'coverage/',
      'playwright-report/',
      'test-results/',
      '_site/build-manifest.json',
      'analysis-service/target/surefire-reports/',
      'qa-system-tests/target/failsafe-reports/',
      'qa-system-tests/target/testcontainers-logs/',
    ]) {
      expect(evidence).toContain(pathFragment);
    }

    expect(dryRunAssets).toContain('if: ${{ inputs.dry_run }}');
    expect(dryRunAssets).toContain('unfallatlas-website-${{ steps.versions.outputs.release }}.zip');

    for (const stepName of [
      'Push release commit to remote',
      'Create annotated Git tag',
      'Create maintenance branch',
      'Create draft GitHub Release',
      'Upload JAR and website bundle to draft release',
      'Publish GitHub Release',
      'Bump to next SNAPSHOT version and metadata',
      'Commit next development version',
      'Push next development branch and open PR',
    ]) {
      const section = stepSection(release, stepName);
      expect(section).not.toBe('');
      expect(section).toContain('if: ${{ !inputs.dry_run }}');
    }
  });
  test('the release guide documents the same non-skippable acceptance contract', () => {
    const guide = fs.readFileSync(path.join(ROOT, 'docs', 'RELEASING.md'), 'utf8');

    expect(guide).not.toContain('`skip_tests`');
    expect(guide).toContain(
      '-Prelease-site,pages,e2e,system-it,location-brief-golden,document-render'
    );
    expect(guide).toContain("'-Dfailsafe.includes=**/*IT.java'");
    expect(guide).toContain('There is deliberately **no test-skipping release input**');
    expect(guide).toContain('release-acceptance-evidence');
    expect(guide).toContain('release-dry-run-candidate-<version>');
  });

  test('release version commits stage only declared metadata paths', () => {
    const release = workflowSource('deploy-release.yml');

    expect(release).not.toContain('git add -A');
    for (const stepName of [
      'Commit release version changes',
      'Commit next development version',
    ]) {
      const section = stepSection(release, stepName);
      expect(section).toContain('git add --');
      for (const metadataPath of [
        'pom.xml',
        'analysis-service/pom.xml',
        'qa-system-tests/pom.xml',
        'package.json',
        'package-lock.json',
        'CITATION.cff',
        'CITATION.md',
        '.zenodo.json',
        'codemeta.json',
      ]) {
        expect(section).toContain(metadataPath);
      }
      expect(section).toContain('git diff --cached --quiet');
    }
  });

});
