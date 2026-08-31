#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_OUT_DIR = path.join('out', 'qa', 'npm-security');
const MAX_BUFFER = 64 * 1024 * 1024;
const SEVERITY_RANK = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

function optionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value == null || !String(value).trim() || String(value).startsWith('-')) {
    throw new Error(`${optionName} benötigt einen Wert.`);
  }
  return String(value);
}

function parseArgs(argv) {
  const options = {
    npmCli: process.env.npm_execpath || '',
    outDir: DEFAULT_OUT_DIR,
    enforceRuntimeHighZero: false,
    enforceAllHighZero: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--npm-cli') {
      options.npmCli = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === '--out-dir') {
      options.outDir = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === '--enforce-runtime-high-zero') {
      options.enforceRuntimeHighZero = true;
    } else if (argument === '--enforce-all-high-zero') {
      options.enforceAllHighZero = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unbekanntes Argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/run-npm-security-audit.js --npm-cli <npm-cli.js> [options]',
    '',
    'Options:',
    '  --out-dir <dir>                    Zielverzeichnis für Rohdaten und Bericht',
    '  --enforce-runtime-high-zero        Fehler bei High/Critical in Produktionsabhängigkeiten',
    '  --enforce-all-high-zero            Fehler bei High/Critical in der vollständigen Installation',
  ].join('\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseJsonOutput(result, commandLabel) {
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    throw new Error(`${commandLabel} lieferte kein JSON. stderr: ${String(result.stderr || '').trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${commandLabel} lieferte ungültiges JSON: ${error.message}. `
      + `stderr: ${String(result.stderr || '').trim()}`
    );
  }
}

function runNpm(npmCli, args, cwd, options = {}) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
  });
  if (result.error) throw result.error;

  const acceptedStatuses = options.acceptedStatuses || [0];
  if (!acceptedStatuses.includes(result.status)) {
    throw new Error(
      `${options.label || `npm ${args.join(' ')}`} scheiterte mit Exit-Code ${result.status}. `
      + `stderr: ${String(result.stderr || '').trim()}`
    );
  }
  return result;
}

function runAudit(npmCli, cwd, omitDev) {
  const args = ['audit', '--json'];
  if (omitDev) args.push('--omit=dev');
  const label = omitDev ? 'npm audit --json --omit=dev' : 'npm audit --json';
  const result = runNpm(npmCli, args, cwd, {
    // npm audit returns 1 when findings meet the default audit threshold.
    acceptedStatuses: [0, 1],
    label,
  });
  const report = parseJsonOutput(result, label);
  if (!report || typeof report !== 'object' || !report.metadata || !report.vulnerabilities) {
    throw new Error(`${label} lieferte nicht das erwartete Audit-Report-v2-Schema.`);
  }
  return report;
}

function runExplain(npmCli, cwd, packageName) {
  const result = spawnSync(process.execPath, [npmCli, 'explain', packageName, '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
  });
  if (result.error) throw result.error;

  const stdout = String(result.stdout || '').trim();
  if (result.status !== 0 || !stdout) {
    return {
      available: false,
      exitCode: result.status,
      stderr: String(result.stderr || '').trim(),
    };
  }
  try {
    return { available: true, paths: JSON.parse(stdout) };
  } catch (error) {
    return {
      available: false,
      exitCode: result.status,
      stderr: `npm explain lieferte ungültiges JSON: ${error.message}`,
    };
  }
}

function vulnerabilityCounts(report) {
  const counts = report?.metadata?.vulnerabilities || {};
  return {
    info: Number(counts.info || 0),
    low: Number(counts.low || 0),
    moderate: Number(counts.moderate || 0),
    high: Number(counts.high || 0),
    critical: Number(counts.critical || 0),
    total: Number(counts.total || 0),
  };
}

function maximumSeverity(...values) {
  return values
    .filter(Boolean)
    .sort((left, right) => (SEVERITY_RANK[right] ?? -1) - (SEVERITY_RANK[left] ?? -1))[0]
    || 'unknown';
}

function normalizeVia(via) {
  const advisories = [];
  const transitiveVia = [];
  for (const item of Array.isArray(via) ? via : []) {
    if (typeof item === 'string') {
      transitiveVia.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    advisories.push({
      source: item.source ?? null,
      name: item.name || item.dependency || null,
      dependency: item.dependency || null,
      title: item.title || null,
      url: item.url || null,
      severity: item.severity || null,
      range: item.range || null,
      cwe: Array.isArray(item.cwe) ? item.cwe : [],
      cvss: item.cvss || null,
    });
  }
  return { advisories, transitiveVia };
}

function normalizeFix(fixAvailable) {
  if (fixAvailable === true || fixAvailable === false || fixAvailable == null) return fixAvailable || false;
  return {
    name: fixAvailable.name || null,
    version: fixAvailable.version || null,
    isSemVerMajor: Boolean(fixAvailable.isSemVerMajor),
  };
}

function declarationKinds(packageJson, packageName) {
  const kinds = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (Object.prototype.hasOwnProperty.call(packageJson[section] || {}, packageName)) kinds.push(section);
  }
  return kinds;
}

function buildSummary({ allReport, productionReport, packageJson, packageLock, lockHash, npmVersion, explanations }) {
  const allVulnerabilities = allReport.vulnerabilities || {};
  const productionVulnerabilities = productionReport.vulnerabilities || {};
  const packageNames = [...new Set([
    ...Object.keys(allVulnerabilities),
    ...Object.keys(productionVulnerabilities),
  ])].sort((left, right) => left.localeCompare(right, 'en'));

  const findings = packageNames.map((packageName) => {
    const allFinding = allVulnerabilities[packageName] || null;
    const productionFinding = productionVulnerabilities[packageName] || null;
    const sourceFinding = allFinding || productionFinding || {};
    const via = normalizeVia(sourceFinding.via);
    return {
      package: packageName,
      severity: maximumSeverity(allFinding?.severity, productionFinding?.severity),
      exposure: productionFinding ? 'production' : 'development-only',
      isDirect: Boolean(allFinding?.isDirect || productionFinding?.isDirect),
      declarations: declarationKinds(packageJson, packageName),
      affectedRange: sourceFinding.range || null,
      installedNodes: [...new Set([
        ...(allFinding?.nodes || []),
        ...(productionFinding?.nodes || []),
      ])].sort(),
      effects: [...new Set(sourceFinding.effects || [])].sort(),
      advisories: via.advisories,
      transitiveVia: via.transitiveVia,
      fixAvailable: normalizeFix(sourceFinding.fixAvailable),
      dependencyPaths: explanations[packageName] || { available: false },
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
      architecture: process.arch,
    },
    input: {
      packageVersion: packageJson.version || null,
      lockfileVersion: packageLock.lockfileVersion || null,
      packageLockSha256: lockHash,
    },
    audits: {
      production: {
        command: 'npm audit --json --omit=dev',
        vulnerabilities: vulnerabilityCounts(productionReport),
        dependencies: productionReport.metadata?.dependencies || {},
      },
      all: {
        command: 'npm audit --json',
        vulnerabilities: vulnerabilityCounts(allReport),
        dependencies: allReport.metadata?.dependencies || {},
      },
    },
    findings,
  };
}

function markdownCell(value) {
  return String(value == null ? '' : value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderMarkdown(summary) {
  const lines = [
    '# npm-Sicherheitsaudit',
    '',
    `Erzeugt: ${summary.generatedAt}`,
    '',
    `- Node: \`${summary.environment.node}\``,
    `- npm: \`${summary.environment.npm}\``,
    `- package-lock.json: \`sha256:${summary.input.packageLockSha256}\``,
    `- Produktionsinstallation: ${summary.audits.production.vulnerabilities.high} high, ${summary.audits.production.vulnerabilities.critical} critical`,
    `- Vollständige Installation: ${summary.audits.all.vulnerabilities.high} high, ${summary.audits.all.vulnerabilities.critical} critical`,
    '',
    '| Paket | Schwere | Exposition | Direkt | Bereich | Korrektur | Advisorys |',
    '|---|---:|---|---:|---|---|---|',
  ];

  for (const finding of summary.findings) {
    const fix = finding.fixAvailable && typeof finding.fixAvailable === 'object'
      ? `${finding.fixAvailable.name || finding.package}@${finding.fixAvailable.version || '?'}${finding.fixAvailable.isSemVerMajor ? ' (major)' : ''}`
      : finding.fixAvailable === true ? 'verfügbar' : 'keine automatische';
    const advisories = finding.advisories.length > 0
      ? finding.advisories.map((item) => item.url
        ? `[${item.title || item.source || 'Advisory'}](${item.url})`
        : item.title || item.source || 'Advisory').join(', ')
      : finding.transitiveVia.join(', ');
    lines.push(`| ${markdownCell(finding.package)} | ${markdownCell(finding.severity)} | ${markdownCell(finding.exposure)} | ${finding.isDirect ? 'ja' : 'nein'} | ${markdownCell(finding.affectedRange)} | ${markdownCell(fix)} | ${markdownCell(advisories)} |`);
  }

  lines.push('', '## Abhängigkeitspfade', '');
  for (const finding of summary.findings) {
    lines.push(`### ${finding.package}`, '');
    if (finding.dependencyPaths.available) {
      lines.push('```json', JSON.stringify(finding.dependencyPaths.paths, null, 2), '```', '');
    } else {
      lines.push(`Nicht verfügbar: ${finding.dependencyPaths.stderr || 'keine Diagnose'}`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

function evaluatePolicy(summary, options) {
  const runtime = summary.audits.production.vulnerabilities;
  const all = summary.audits.all.vulnerabilities;
  const violations = [];
  if (options.enforceRuntimeHighZero && runtime.high + runtime.critical > 0) {
    violations.push(`Produktionsabhängigkeiten enthalten ${runtime.high} high und ${runtime.critical} critical Befund/Befunde.`);
  }
  if (options.enforceAllHighZero && all.high + all.critical > 0) {
    violations.push(`Die vollständige Installation enthält ${all.high} high und ${all.critical} critical Befund/Befunde.`);
  }
  return violations;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.npmCli) throw new Error('--npm-cli fehlt und npm_execpath ist nicht gesetzt.');

  const cwd = process.cwd();
  const npmCli = path.resolve(cwd, options.npmCli);
  const outDir = path.resolve(cwd, options.outDir);
  const packageJsonPath = path.join(cwd, 'package.json');
  const packageLockPath = path.join(cwd, 'package-lock.json');
  if (!fs.existsSync(npmCli)) throw new Error(`Gepinnte npm-CLI nicht gefunden: ${npmCli}`);
  if (!fs.existsSync(packageLockPath)) throw new Error('package-lock.json fehlt.');
  fs.mkdirSync(outDir, { recursive: true });

  const packageJson = readJson(packageJsonPath);
  const packageLock = readJson(packageLockPath);
  const npmVersionResult = runNpm(npmCli, ['--version'], cwd, { label: 'npm --version' });
  const npmVersion = String(npmVersionResult.stdout || '').trim();
  const allReport = runAudit(npmCli, cwd, false);
  const productionReport = runAudit(npmCli, cwd, true);

  const packageNames = [...new Set([
    ...Object.keys(allReport.vulnerabilities || {}),
    ...Object.keys(productionReport.vulnerabilities || {}),
  ])].sort((left, right) => left.localeCompare(right, 'en'));
  const explanations = Object.fromEntries(
    packageNames.map((packageName) => [packageName, runExplain(npmCli, cwd, packageName)])
  );

  const summary = buildSummary({
    allReport,
    productionReport,
    packageJson,
    packageLock,
    lockHash: sha256(packageLockPath),
    npmVersion,
    explanations,
  });

  writeJson(path.join(outDir, 'npm-audit-all.json'), allReport);
  writeJson(path.join(outDir, 'npm-audit-production.json'), productionReport);
  writeJson(path.join(outDir, 'npm-audit-summary.json'), summary);
  fs.writeFileSync(path.join(outDir, 'npm-audit-report.md'), renderMarkdown(summary), 'utf8');

  const allCounts = summary.audits.all.vulnerabilities;
  const productionCounts = summary.audits.production.vulnerabilities;
  process.stdout.write(
    `npm audit (${npmVersion}): production=${productionCounts.high} high/${productionCounts.critical} critical; `
    + `all=${allCounts.high} high/${allCounts.critical} critical; `
    + `evidence=${path.relative(cwd, outDir)}\n`
  );

  const violations = evaluatePolicy(summary, options);
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`RELEASE-GATE: ${violation}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`npm security audit failed: ${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildSummary,
  evaluatePolicy,
  maximumSeverity,
  normalizeFix,
  normalizeVia,
  parseArgs,
  renderMarkdown,
  vulnerabilityCounts,
};
