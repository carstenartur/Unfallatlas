'use strict';

const {
  buildSummary,
  evaluatePolicy,
  normalizeVia,
  renderMarkdown,
  vulnerabilityCounts,
} = require('../../scripts/run-npm-security-audit');

function auditReport(vulnerabilities, counts) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
        ...counts,
      },
      dependencies: { prod: 10, dev: 20, optional: 0, peer: 0, total: 30 },
    },
  };
}

describe('npm security audit evidence', () => {
  test('classifies production and development-only findings with advisory and path evidence', () => {
    const runtimeFinding = {
      name: 'runtime-package',
      severity: 'high',
      isDirect: true,
      via: [{
        source: 123,
        name: 'runtime-package',
        dependency: 'runtime-package',
        title: 'Runtime advisory',
        url: 'https://github.com/advisories/GHSA-test-runtime',
        severity: 'high',
        range: '<2.0.0',
        cwe: ['CWE-79'],
        cvss: { score: 8.1, vectorString: 'CVSS:3.1/TEST' },
      }],
      effects: [],
      range: '<2.0.0',
      nodes: ['node_modules/runtime-package'],
      fixAvailable: { name: 'runtime-package', version: '2.0.0', isSemVerMajor: true },
    };
    const devFinding = {
      name: 'dev-package',
      severity: 'high',
      isDirect: false,
      via: ['test-runner'],
      effects: [],
      range: '<3.0.0',
      nodes: ['node_modules/dev-package'],
      fixAvailable: false,
    };
    const allReport = auditReport(
      { 'runtime-package': runtimeFinding, 'dev-package': devFinding },
      { high: 2, total: 2 }
    );
    const productionReport = auditReport(
      { 'runtime-package': runtimeFinding },
      { high: 1, total: 1 }
    );

    const summary = buildSummary({
      allReport,
      productionReport,
      packageJson: {
        version: '2.1.4',
        dependencies: { 'runtime-package': '1.0.0' },
        devDependencies: { 'test-runner': '4.0.0' },
      },
      packageLock: { lockfileVersion: 3 },
      lockHash: 'abc123',
      npmVersion: '11.19.1',
      explanations: {
        'runtime-package': { available: true, paths: [{ name: 'runtime-package' }] },
        'dev-package': { available: true, paths: [{ name: 'test-runner', dependencies: [{ name: 'dev-package' }] }] },
      },
    });

    expect(summary.environment.npm).toBe('11.19.1');
    expect(summary.input.packageLockSha256).toBe('abc123');
    expect(summary.audits.production.vulnerabilities.high).toBe(1);
    expect(summary.audits.all.vulnerabilities.high).toBe(2);

    const runtime = summary.findings.find((finding) => finding.package === 'runtime-package');
    expect(runtime).toMatchObject({
      exposure: 'production',
      isDirect: true,
      declarations: ['dependencies'],
      affectedRange: '<2.0.0',
    });
    expect(runtime.advisories).toEqual([
      expect.objectContaining({
        title: 'Runtime advisory',
        url: 'https://github.com/advisories/GHSA-test-runtime',
      }),
    ]);
    expect(runtime.fixAvailable).toEqual({
      name: 'runtime-package',
      version: '2.0.0',
      isSemVerMajor: true,
    });

    const development = summary.findings.find((finding) => finding.package === 'dev-package');
    expect(development.exposure).toBe('development-only');
    expect(development.transitiveVia).toEqual(['test-runner']);
    expect(development.dependencyPaths.available).toBe(true);

    const markdown = renderMarkdown(summary);
    expect(markdown).toContain('Runtime advisory');
    expect(markdown).toContain('development-only');
    expect(markdown).toContain('package-lock.json');
  });

  test('enforces production and full-installation thresholds independently', () => {
    const summary = {
      audits: {
        production: { vulnerabilities: { high: 0, critical: 0 } },
        all: { vulnerabilities: { high: 2, critical: 0 } },
      },
    };

    expect(evaluatePolicy(summary, {
      enforceRuntimeHighZero: true,
      enforceAllHighZero: false,
    })).toEqual([]);
    expect(evaluatePolicy(summary, {
      enforceRuntimeHighZero: false,
      enforceAllHighZero: true,
    })).toHaveLength(1);
  });

  test('normalizes transitive and advisory via entries without losing identifiers', () => {
    expect(normalizeVia([
      'parent-package',
      { source: 99, title: 'Advisory', url: 'https://example.test/advisory', severity: 'high' },
    ])).toEqual({
      transitiveVia: ['parent-package'],
      advisories: [expect.objectContaining({ source: 99, title: 'Advisory' })],
    });
    expect(vulnerabilityCounts({ metadata: { vulnerabilities: { high: 4, total: 4 } } }))
      .toEqual({ info: 0, low: 0, moderate: 0, high: 4, critical: 0, total: 4 });
  });
});
