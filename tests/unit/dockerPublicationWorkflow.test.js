'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/docker-publish.yml');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');

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
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    expect(smoke).toContain('-Pvideo-export-it');
    expect(smoke).not.toContain('npm run');
    expect(smoke).not.toContain('docker build');
    expect(smoke).not.toContain('validate:vendor-provenance');
    expect(smoke).not.toContain('docker/login-action');
    expect(smoke).not.toContain('packages: write');

    expect(publish).toContain("github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/v')");
    expect(publish).toContain('packages: write');
    expect(publish).toContain('-Prelease-site');
    expect(publish).not.toContain('npm run');
    expect(packageJson.scripts['qa:release-site'])
      .toContain('validate:vendor-provenance');
    expect(pom).toContain('<id>video-export-it</id>');
    expect(pom).toContain('<id>release-site</id>');
    expect(publish).toContain('REQUIRE_COMPLETE_VENDOR_PROVENANCE=1');
    expect(publish).toContain('push: true');
    expect(publish.indexOf('-Prelease-site'))
      .toBeLessThan(publish.indexOf('docker/login-action'));
    expect(publish.indexOf('docker/login-action'))
      .toBeLessThan(publish.indexOf('docker/build-push-action'));
  });

  test('production media packages tolerate transient mirrors and avoid unrelated apt repositories', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');

    expect(dockerfile).toContain('ffmpeg');
    expect(dockerfile).toContain('imagemagick');
    expect(dockerfile.match(/Acquire::Retries=5/g)).toHaveLength(2);
    expect(dockerfile.match(/Dir::Etc::sourcelist=\/etc\/apt\/sources\.list\.d\/ubuntu\.sources/g))
      .toHaveLength(2);
    expect(dockerfile.match(/Dir::Etc::sourceparts=-/g)).toHaveLength(2);
    expect(dockerfile).toContain('DEBIAN_FRONTEND=noninteractive apt-get');
    expect(dockerfile).toContain('test -x /usr/bin/ffmpeg');
    expect(dockerfile).toContain('command -v convert >/dev/null');
  });
});
