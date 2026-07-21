'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/docker-publish.yml');

describe('Docker publication workflow boundary', () => {
  test('main and relevant PRs smoke-build without publishing while releases retain the provenance gate', () => {
    const workflow = fs.readFileSync(WORKFLOW, 'utf8');
    const smokeStart = workflow.indexOf('  main-smoke:');
    const publishStart = workflow.indexOf('  publish:');

    expect(smokeStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(smokeStart);

    const smoke = workflow.slice(smokeStart, publishStart);
    const publish = workflow.slice(publishStart);

    expect(workflow).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(workflow).toMatch(/pull_request:\s*\n\s*branches: \[main\]/);
    expect(workflow).toContain("- '.github/workflows/docker-publish.yml'");
    expect(workflow).toContain("- 'Dockerfile'");
    expect(workflow).toContain("- 'package-lock.json'");

    expect(smoke).toContain(
      "github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main')"
    );
    expect(smoke).toContain('npm run validate:media');
    expect(smoke).toContain('docker build');
    expect(smoke).toContain('REQUIRE_COMPLETE_VENDOR_PROVENANCE=0');
    expect(smoke).not.toContain('validate:vendor-provenance -- --require-complete');
    expect(smoke).not.toContain('docker/login-action');
    expect(smoke).not.toContain('packages: write');

    expect(publish).toContain("github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/v')");
    expect(publish).toContain('packages: write');
    expect(publish).toContain('npm run validate:media');
    expect(publish).toContain('npm run validate:vendor-provenance -- --require-complete');
    expect(publish).toContain('REQUIRE_COMPLETE_VENDOR_PROVENANCE=1');
    expect(publish).toContain('push: true');
    expect(publish.indexOf('validate:vendor-provenance -- --require-complete'))
      .toBeLessThan(publish.indexOf('docker/login-action'));
    expect(publish.indexOf('docker/login-action'))
      .toBeLessThan(publish.indexOf('docker/build-push-action'));
  });
});
