'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('accident data publication is fail-closed', () => {
  test('the converter may not ignore a failed or empty official year', () => {
    const source = read('convertAmt2gmaps.sh');
    expect(source).not.toMatch(/process_year_to_buffers\s+"\$y"\s*\|\|\s*true/);
    expect(source).toContain('process_year_to_buffers "$y"');
    expect(source).toContain('Required browser fields missing for');
    expect(source).toContain('kein unvollständiger Mehrjahresdatensatz wird veröffentlicht');
    expect(source).toContain('keine verwertbaren Unfallzeilen');
    expect(source).not.toContain('Verarbeitung fehlgeschlagen für Jahr $year (ignoriert');
  });

  test('the refresh workflow runs runtime, JUnit and browser gates before git commit', () => {
    const workflow = read('.github/workflows/generate-and-commit.yml');
    const runtime = workflow.indexOf('npm run validate:accident-runtime');
    const maven = workflow.indexOf('mvn -B -ntp clean verify -Ppages,data-contract-it');
    const commit = workflow.indexOf('git commit -m "Refresh official accident datasets"');

    expect(runtime).toBeGreaterThan(0);
    expect(maven).toBeGreaterThan(runtime);
    expect(commit).toBeGreaterThan(maven);
    expect(workflow).toContain('qa-system-tests/target/failsafe-reports/');
    expect(workflow).toContain('out/qa/accident-runtime-contract.json');
    expect(workflow).toContain('rm -rf .build _site target qa-system-tests/target analysis-service/target');
  });

  test('Maven exposes a lightweight JUnit profile for checked-in data compatibility', () => {
    const pom = read('pom.xml');
    expect(pom).toMatch(/<id>data-contract-it<\/id>[\s\S]*?<failsafe\.includes>\*\*\/CheckedInAccidentDataIT\.java<\/failsafe\.includes>/);
    expect(read('qa-system-tests/src/test/java/de/unfallatlas/qa/CheckedInAccidentDataIT.java'))
      .toContain('validate-accident-runtime-contract.js');
  });
});
