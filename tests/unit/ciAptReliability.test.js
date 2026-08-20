'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('CI package installation reliability', () => {
  test('all Docker APT layers retry transient mirrors, bound connections and verify binaries', () => {
    const applicationDockerfile = read('Dockerfile');
    const analysisDockerfile = read('analysis-service/Dockerfile');

    expect(applicationDockerfile.match(/Acquire::Retries=5/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::ForceIPv4=true/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::Languages=none/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::http::Timeout=30/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::https::Timeout=30/g)).toHaveLength(2);
    expect(applicationDockerfile).toContain('/etc/apt/apt-mirrors.txt');
    expect(applicationDockerfile).toContain('https://archive.ubuntu.com/ubuntu');
    expect(applicationDockerfile).toContain('test -x /usr/bin/ffmpeg');
    expect(applicationDockerfile).toContain('command -v convert >/dev/null');

    expect(analysisDockerfile.match(/Acquire::Retries=5/g)).toHaveLength(2);
    expect(analysisDockerfile.match(/Acquire::http::Timeout=30/g)).toHaveLength(2);
    expect(analysisDockerfile.match(/Acquire::https::Timeout=30/g)).toHaveLength(2);
    expect(analysisDockerfile).toContain('DEBIAN_FRONTEND=noninteractive apt-get');
    expect(analysisDockerfile).toContain('test -x /usr/bin/curl');
  });

  test('rendered-document dependencies bypass a stalled regional mirror and remain bounded', () => {
    const workflow = read('.github/workflows/rendered-document-poppler.yml');

    expect(workflow).toContain('set -euo pipefail');
    expect(workflow).toContain('/etc/apt/apt-mirrors.txt');
    expect(workflow).toContain('https://archive.ubuntu.com/ubuntu');
    expect(workflow).toContain('-o Acquire::Retries=5');
    expect(workflow).toContain('-o Acquire::ForceIPv4=true');
    expect(workflow).toContain('-o Acquire::Languages=none');
    expect(workflow).toContain('-o Acquire::http::Timeout=30');
    expect(workflow).toContain('-o Acquire::https::Timeout=30');
    expect(workflow).toContain('timeout --signal=TERM 10m');
    expect(workflow).toContain('timeout --signal=TERM 20m');
    expect(workflow).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(workflow).toContain('command -v libreoffice >/dev/null');
    expect(workflow).toContain('command -v pdftoppm >/dev/null');
    expect(workflow).toContain('command -v pdftotext >/dev/null');
  });

  test('extended WebKit QA explicitly provisions system dependencies through the stable mirror', () => {
    const workflow = read('.github/workflows/test.yml');
    const extendedQa = workflow.slice(workflow.indexOf('  extended-qa:'));
    const normalizeSources = extendedQa.indexOf(
      'Normalize Ubuntu package sources for Playwright system dependencies'
    );
    const runQa = extendedQa.indexOf('Run the canonical extended QA profiles');

    expect(normalizeSources).toBeGreaterThan(-1);
    expect(runQa).toBeGreaterThan(normalizeSources);
    expect(extendedQa).toContain('/etc/apt/apt-mirrors.txt');
    expect(extendedQa).toContain('https://archive.ubuntu.com/ubuntu');
    expect(extendedQa).toContain('PLAYWRIGHT_INSTALL_SYSTEM_DEPS: \'1\'');
    expect(extendedQa).toContain('set -euo pipefail');
  });

  test('Playwright browser downloads are bounded and do not invoke APT implicitly', () => {
    const packageJson = JSON.parse(read('package.json'));
    const installer = read('scripts/install-playwright-browsers.cjs');

    expect(packageJson.scripts['qa:e2e:prepare'])
      .toContain('scripts/install-playwright-browsers.cjs chromium firefox webkit');
    expect(packageJson.scripts['qa:e2e:prepare']).not.toContain('--with-deps');
    expect(installer).toContain('PLAYWRIGHT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000');
    expect(installer).toContain("args.push('--with-deps')");
    expect(installer).toContain('PLAYWRIGHT_INSTALL_SYSTEM_DEPS');
    expect(installer).toContain('PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT');
  });
});
