'use strict';

const fs = require('fs');
const path = require('path');

describe('reviewed screenshot acceptance support files', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/visual-check.yml'),
    'utf8'
  );
  const acceptance = workflow.slice(
    workflow.indexOf('  accept-reviewed-screenshots:')
  );

  test('replaces only generated media and preserves reviewed documentation support files', () => {
    expect(acceptance).toContain(
      "GENERATED_MEDIA_SUFFIXES = {'.apng', '.gif', '.jpeg', '.jpg', '.png', '.webp'}"
    );
    expect(acceptance).not.toContain('shutil.rmtree(destination_shots)');
    expect(acceptance).toContain("if existing.suffix.lower() in GENERATED_MEDIA_SUFFIXES:");
    expect(acceptance).toContain('existing.unlink()');
    expect(acceptance).toContain('shutil.copyfile(source, target)');
    expect(acceptance).toContain('accepted screenshot copy mismatch');
    expect(acceptance).toContain('reviewed screenshot support tree contains a link');
  });
});
