'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

describe('Maven-owned context-data transient fallback', () => {
  test('the context-data-e2e profile tolerates only verified stale data after transient provider failures', () => {
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const profile = /<profile>\s*<id>context-data-e2e<\/id>([\s\S]*?)<\/profile>/.exec(pom);

    expect(profile).not.toBeNull();
    expect(profile[1]).toContain(
      '<context.allowStaleOnTransient>true</context.allowStaleOnTransient>'
    );
    expect(profile[1]).toContain(
      '<CONTEXT_ALLOW_STALE_ON_TRANSIENT>${context.allowStaleOnTransient}</CONTEXT_ALLOW_STALE_ON_TRANSIENT>'
    );
  });
});
