'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('accident data publication is fail-closed', () => {
  test('repair and staged installation require every discovered official year', () => {
    const generator = read('scripts/generate-accident-data.js');
    expect(generator).toContain('requiredYears: requiredYears == null ? [] : requiredYears');
    expect(generator).toContain('requiredYears: years');
    expect(generator).not.toContain('requiredYears: highestYear == null ? [] : [highestYear]');
  });

  test('the refresh workflow runs runtime, JUnit and browser gates before git commit', () => {
    const workflow = read('.github/workflows/generate-and-commit.yml');
    const runtime = workflow.indexOf('npm run validate:accident-runtime');
    const maven = workflow.indexOf("mvn -B -ntp clean verify -Ppages,system-it '-Dfailsafe.includes=**/CheckedInAccidentDataIT.java'");
    const commit = workflow.indexOf('git commit -m "Refresh official accident datasets"');

    expect(runtime).toBeGreaterThan(0);
    expect(maven).toBeGreaterThan(runtime);
    expect(commit).toBeGreaterThan(maven);
    expect(workflow).toContain('qa-system-tests/target/failsafe-reports/');
    expect(workflow).toContain('out/qa/accident-runtime-contract.json');
    expect(workflow).toContain('rm -rf .build _site target qa-system-tests/target analysis-service/target');
  });

  test('JUnit executes the same browser-owned runtime validator', () => {
    expect(read('qa-system-tests/src/test/java/de/unfallatlas/qa/CheckedInAccidentDataIT.java'))
      .toContain('validate-accident-runtime-contract.js');
  });
});
