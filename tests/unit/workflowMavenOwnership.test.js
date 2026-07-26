'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW_DIRECTORY = path.join(ROOT, '.github', 'workflows');

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

describe('GitHub Actions delegates repository build and QA to Maven', () => {
  test('workflow YAML contains no direct Node, npm, Jest, Playwright or JS-Testcontainers orchestration', () => {
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

  test('each workflow job invokes Maven at most once', () => {
    const violations = [];
    for (const workflow of workflows()) {
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
      'test.yml': ['-Ppages', '-Pe2e,system-it,location-brief-golden'],
      'docker-publish.yml': ['-Pvideo-export-it', '-Prelease-site'],
      'rendered-document-poppler.yml': ['-Pdocument-render'],
      'enrich.yml': ['-Pcontext-data-e2e'],
      'generate-screenshots.yml': ['-Pdocumentation-live'],
      'visual-check.yml': ['-Pdocumentation-live'],
      'deploy-release.yml': ['-Prelease-site'],
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
      'location-brief-golden',
      'document-render',
      'context-data-e2e',
      'documentation-live',
      'release-site',
    ]) {
      expect(pom).toContain(`<id>${profile}</id>`);
    }
  });
});
