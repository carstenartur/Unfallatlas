'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function runDockerAptFixture(failures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-docker-apt-'));
  try {
    const aptDir = path.join(dir, 'apt');
    const archives = path.join(dir, 'archives');
    const lists = path.join(dir, 'lists');
    fs.mkdirSync(path.join(aptDir, 'sources.list.d'), { recursive: true });
    fs.mkdirSync(path.join(archives, 'partial'), { recursive: true });
    fs.mkdirSync(path.join(lists, 'partial'), { recursive: true });
    const source = path.join(aptDir, 'sources.list.d', 'ubuntu.sources');
    fs.writeFileSync(source, 'URIs: http://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /keys/ubuntu.gpg\n\nURIs: http://security.ubuntu.com/ubuntu\nSuites: noble-security\nComponents: main universe\nSigned-By: /keys/ubuntu.gpg\n');
    const commandLog = path.join(dir, 'commands');
    const mockCommand = (name, body) =>
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nset -eu\n' + body + '\n', { mode: 0o755 });
    mockCommand('dpkg', 'exit 0');
    mockCommand('convert', 'exit 0');
    mockCommand('rm', [
      'for operand do',
      '  case "$operand" in',
      '    -f|-rf|"$APT_FIXTURE_ROOT"/*) ;;',
      '    *) exit 92 ;;',
      '  esac',
      'done',
      'exec /usr/bin/rm "$@"',
    ].join('\n'));
    mockCommand('timeout', [
      'test "$1" = --kill-after=15s',
      'export ACQUISITION_BUDGET="$2"',
      'shift 2',
      'exec "$@"',
    ].join('\n'));
    mockCommand('apt-get', [
      'mode=preferred',
      'if ! grep -q mirrors.edge.kernel.org "$APT_FIXTURE_DIR"/ua-ubuntu-mirrors.txt; then',
      '  mode=official',
      '  grep -q https://archive.ubuntu.com/ubuntu "$APT_FIXTURE_DIR"/ua-ubuntu-mirrors.txt',
      '  grep -q https://security.ubuntu.com/ubuntu "$APT_FIXTURE_DIR"/apt-security-mirrors.txt',
      '  ! grep -q mirrors.edge.kernel.org "$APT_FIXTURE_DIR"/apt-security-mirrors.txt || exit 90',
      'fi',
      'case " $* " in',
      '  *" update "*)',
      '    phase=update',
      '    case " $* " in *" APT::Update::Error-Mode=any "*) ;; *) exit 93 ;; esac',
      '    rm -f "$APT_FIXTURE_ARCHIVES"/cached.deb ;;',
      '  *" --download-only "*)',
      '    phase=download',
      '    if [ "$mode" = official ] && grep -q "^download preferred " "$APT_FIXTURE_LOG"; then',
      '      test -f "$APT_FIXTURE_ARCHIVES"/cached.deb',
      '    fi',
      '    touch "$APT_FIXTURE_ARCHIVES"/cached.deb ;;',
      '  *" --no-download "*) phase=install; test -f "$APT_FIXTURE_ARCHIVES"/cached.deb ;;',
      '  *" clean "*) exit 0 ;;',
      '  *) exit 91 ;;',
      'esac',
      'printf "%s %s %s\n" "$phase" "$mode" "$ACQUISITION_BUDGET" >> "$APT_FIXTURE_LOG"',
      'case " $APT_FIXTURE_FAILURES " in',
      '  *" $phase:$mode:124 "*) exit 124 ;;',
      '  *" $phase:$mode:137 "*) exit 137 ;;',
      '  *" $phase:$mode:1 "*) exit 1 ;;',
      'esac',
    ].join('\n'));
    const dockerfile = read('Dockerfile');
    const start = dockerfile.indexOf('RUN set -eux; \\');
    const end = dockerfile.indexOf('\n\n', start);
    mockCommand('ffmpeg', 'exit 0');
    const command = dockerfile.slice(start + 4, end)
      .replaceAll('/etc/apt', '"$APT_FIXTURE_DIR"')
      .replaceAll('/var/cache/apt/archives', '"$APT_FIXTURE_ARCHIVES"')
      .replaceAll('/var/lib/apt/lists', '"$APT_FIXTURE_LISTS"')
      .replaceAll('/usr/bin/ffmpeg', '"$APT_FIXTURE_ROOT"/ffmpeg')
      .replaceAll('sh /tmp/configure-ubuntu-mirrors.sh',
        'sh "$APT_FIXTURE_CONFIG" "$APT_FIXTURE_DIR"');
    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        ACQUISITION_BUDGET: 'local',
        APT_FIXTURE_ROOT: dir,
        APT_FIXTURE_CONFIG: path.join(ROOT, 'scripts/configure-ubuntu-mirrors.sh'),
        APT_FIXTURE_DIR: aptDir,
        APT_FIXTURE_ARCHIVES: archives,
        APT_FIXTURE_LISTS: lists,
        APT_FIXTURE_FAILURES: failures.join(' '),
        APT_FIXTURE_LOG: commandLog,
      },
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      commands: fs.existsSync(commandLog) ? fs.readFileSync(commandLog, 'utf8').trim().split('\n') : [],
      sources: fs.readFileSync(source, 'utf8'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  test('application Docker APT layers retry transient mirrors, bound connections and verify binaries', () => {
    const applicationDockerfile = read('Dockerfile');

    expect(applicationDockerfile.match(/Acquire::Retries=5/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::ForceIPv4=true/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::Languages=none/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::http::Timeout=30/g)).toHaveLength(2);
    expect(applicationDockerfile.match(/Acquire::https::Timeout=30/g)).toHaveLength(2);
    expect(applicationDockerfile).toContain('sh /tmp/configure-ubuntu-mirrors.sh');
    expect(applicationDockerfile).toContain('test -x /usr/bin/ffmpeg');
    expect(applicationDockerfile).toContain('command -v convert >/dev/null');
  });

  test.each([
    ['healthy mirrors', [], 0, ['update preferred 5m', 'download preferred 8m', 'install preferred local']],
    ['timed-out index fetch', ['update:preferred:124'], 0, [
      'update preferred 5m', 'update official 5m', 'download official 8m', 'install official local',
    ]],
    ['killed package fetch', ['download:preferred:137'], 0, [
      'update preferred 5m', 'download preferred 8m', 'download official 8m', 'install official local',
    ]],
    ['both index attempts fail', ['update:preferred:124', 'update:official:1'], 1, [
      'update preferred 5m', 'update official 5m',
    ]],
    ['both package attempts fail', ['download:preferred:137', 'download:official:1'], 1, [
      'update preferred 5m', 'download preferred 8m', 'download official 8m',
    ]],
    ['official download fails after index fallback', ['update:preferred:124', 'download:official:137'], 137, [
      'update preferred 5m', 'update official 5m', 'download official 8m',
    ]],
    ['local package installation fails', ['install:preferred:1'], 1, [
      'update preferred 5m', 'download preferred 8m', 'install preferred local',
    ]],
  ])('Docker acquires packages before one local installation when %s', (_scenario, failures, status, commands) => {
    const result = runDockerAptFixture(failures);
    expect(result.commands).toEqual(commands);
    expect(result.status).toBe(status);
    expect(result.sources.match(/Signed-By: \/keys\/ubuntu.gpg/g)).toHaveLength(2);
    expect(result.sources.match(/Components: main universe/g)).toHaveLength(2);
    expect(result.sources).toContain('Suites: noble noble-updates');
    expect(result.sources).toContain('Suites: noble-security');
  });

  test('analysis healthcheck runs the locally compiled HTTP probe on its runtime JRE', () => {
    const dockerfile = read('analysis-service/Dockerfile');
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM eclipse-temurin:'));
    expect(runtime).not.toMatch(/\bapt-get\b/);
    expect(runtime).toContain('COPY --from=build /workspace/target/classes/de/unfallatlas/analysis/health/ContainerHealthCheck.class /app/healthcheck/de/unfallatlas/analysis/health/ContainerHealthCheck.class');
    expect(runtime).toContain('CMD ["java", "-Xmx16m", "-XX:+UseSerialGC", "-cp", "/app/healthcheck", "de.unfallatlas.analysis.health.ContainerHealthCheck"]');
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
