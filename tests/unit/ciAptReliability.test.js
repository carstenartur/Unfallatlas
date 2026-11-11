'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('CI package installation reliability', () => {
  test('direct archive and security entries can fail over without changing suites or signing keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-apt-'));
    try {
      const sources = path.join(dir, 'sources.list.d');
      fs.mkdirSync(sources);
      fs.writeFileSync(path.join(dir, 'sources.list'), 'deb http://azure.archive.ubuntu.com/ubuntu/ noble-updates main universe\n');
      const security = path.join(sources, 'ubuntu.sources');
      fs.writeFileSync(security, 'URIs: http://security.ubuntu.com/ubuntu\nSuites: noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n');
      const ports = path.join(sources, 'ports.list');
      fs.writeFileSync(ports, 'deb http://ports.ubuntu.com/ubuntu-ports noble main\n');
      const configure = () => execFileSync('sh', [path.join(ROOT, 'scripts/configure-ubuntu-mirrors.sh'), dir]);
      const runnerList = path.join(dir, 'apt-mirrors.txt');
      const originalMirrors = 'https://security.ubuntu.com/ubuntu\nhttps://custom.example/ubuntu\n';
      fs.writeFileSync(runnerList, originalMirrors);
      configure();
      configure();
      const augmented = fs.readFileSync(runnerList, 'utf8');
      expect(augmented.startsWith(originalMirrors)).toBe(true);
      expect(augmented).toContain('https://mirrors.edge.kernel.org/ubuntu\tpriority:0');
      expect(fs.readFileSync(path.join(dir, 'apt.conf.d/80-unfallatlas-ci-languages'), 'utf8')).toContain('Acquire::Languages "none";');
      expect(augmented.match(/mirrors\.edge\.kernel\.org/g)).toHaveLength(1);
      fs.writeFileSync(runnerList, 'https://ports.ubuntu.com/ubuntu-ports\n');
      configure();
      expect(fs.readFileSync(runnerList, 'utf8')).toBe('https://ports.ubuntu.com/ubuntu-ports\n');
      expect(fs.readFileSync(path.join(dir, 'sources.list'), 'utf8')).toBe('deb mirror+file:' + dir + '/ua-ubuntu-mirrors.txt noble-updates main universe\n');
      expect(fs.readFileSync(security, 'utf8')).toBe('URIs: mirror+file:' + dir + '/apt-security-mirrors.txt\nSuites: noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n');
      expect(fs.readFileSync(ports, 'utf8')).toContain('http://ports.ubuntu.com/ubuntu-ports');
      for (const name of ['ua-ubuntu-mirrors.txt', 'apt-security-mirrors.txt']) {
        const mirrors = fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n');
        expect(mirrors[1]).toContain(name === 'ua-ubuntu-mirrors.txt' ? 'https://archive.ubuntu.com/ubuntu' : 'https://security.ubuntu.com/ubuntu');
        expect(mirrors[0]).toBe('https://mirrors.edge.kernel.org/ubuntu\tpriority:0');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('all Docker APT layers retry transient mirrors, bound connections and verify binaries', () => {
    const applicationDockerfile = read('Dockerfile');
    const analysisDockerfile = read('analysis-service/Dockerfile');

    expect(applicationDockerfile.match(/Acquire::Retries=5/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::ForceIPv4=true/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::Languages=none/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::http::Timeout=30/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::https::Timeout=30/g)).toHaveLength(2);
    expect(applicationDockerfile).toContain('sh /tmp/configure-ubuntu-mirrors.sh');
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
    expect(workflow).toContain('sudo sh scripts/configure-ubuntu-mirrors.sh');
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
    expect(extendedQa).toContain('sudo sh scripts/configure-ubuntu-mirrors.sh');
    expect(extendedQa).toContain('PLAYWRIGHT_INSTALL_SYSTEM_DEPS: \'1\'');
    expect(extendedQa).toContain('set -euo pipefail');
  });

  test.each(['visual-check', 'generate-screenshots', 'live-pages-runtime-health'])(
    '%s configures mirrors before the live documentation browser install',
    (workflowName) => {
      const workflow = read('.github/workflows/' + workflowName + '.yml');
      const configure = workflow.indexOf('sudo sh scripts/configure-ubuntu-mirrors.sh');
      expect(configure).toBeGreaterThan(-1);
      expect(workflow.indexOf('-Pdocumentation-live')).toBeGreaterThan(configure);
    }
  );

  test('release acceptance provisions browser and document dependencies before the full matrix', () => {
    const workflow = read('.github/workflows/deploy-release.yml');
    const reclaimDisk = workflow.indexOf(
      'Reclaim hosted-runner disk for release acceptance matrix'
    );
    const installDependencies = workflow.indexOf('Install release QA system dependencies');
    const runAcceptance = workflow.indexOf('Run the canonical release acceptance matrix');
    const dependencySection = workflow.slice(installDependencies, runAcceptance);
    const acceptanceSection = workflow.slice(runAcceptance);

    expect(reclaimDisk).toBeGreaterThan(-1);
    expect(installDependencies).toBeGreaterThan(reclaimDisk);
    expect(runAcceptance).toBeGreaterThan(installDependencies);
    expect(workflow).toContain('timeout-minutes: 180');
    expect(workflow).toContain('docker info >/dev/null');
    expect(workflow).toContain('docker system prune --all --force --volumes');

    expect(dependencySection).toContain('sudo sh scripts/configure-ubuntu-mirrors.sh');
    expect(dependencySection).toContain('-o Acquire::Retries=5');
    expect(dependencySection).toContain('-o Acquire::ForceIPv4=true');
    expect(dependencySection).toContain('-o Acquire::Languages=none');
    expect(dependencySection).toContain('-o Acquire::http::Timeout=30');
    expect(dependencySection).toContain('-o Acquire::https::Timeout=30');
    expect(dependencySection).toContain('timeout --signal=TERM 10m');
    expect(dependencySection).toContain('timeout --signal=TERM 20m');
    expect(dependencySection).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(dependencySection).toContain('libreoffice-writer');
    expect(dependencySection).toContain('poppler-utils');
    expect(dependencySection).toContain('command -v libreoffice >/dev/null');
    expect(dependencySection).toContain('command -v pdftoppm >/dev/null');
    expect(dependencySection).toContain('command -v pdftotext >/dev/null');
    expect(acceptanceSection).toContain('PLAYWRIGHT_INSTALL_SYSTEM_DEPS: \'1\'');
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
