#!/usr/bin/env python3
from pathlib import Path

runner = Path('scripts/apply-media-tooling-boundary-fix.sh')
source = runner.read_text()
marker = """    'policy-only fail-closed metadata test',
)
PY

git diff --check
"""
addition = """    'policy-only fail-closed metadata test',
)

screenshot_target_test = \"\"\"  test('new full-screen screenshot candidates target 1280x640', () => {
    const panelAssets = new Set([
      'docs/screenshots/02-stadtauswahl.png',
      'docs/screenshots/03-filter.png',
      'docs/screenshots/08-stundenfilter.png',
    ]);
    const documentPreview = 'docs/screenshots/15-export-pdf-rendered.png';
    for (const asset of manifest.assets.filter(entry => entry.kind === 'screenshot')) {
      if (panelAssets.has(asset.path)) expect(asset.target).toEqual({ width: 440, height: 620 });
      else if (asset.path !== documentPreview) expect(asset.target).toEqual({ width: 1280, height: 640 });
    }
    const screenshotSpec = fs.readFileSync(path.join(ROOT, 'tests/e2e/screenshots.spec.js'), 'utf8');
    expect(screenshotSpec).toMatch(/viewport:\\s*\\{\\s*width:\\s*1280,\\s*height:\\s*640\\s*\\}/);
  });\"\"\"
screenshot_target_replacement = \"\"\"  test('all screenshot candidates target complete 1280x640 frames', () => {
    for (const asset of manifest.assets.filter(entry => entry.kind === 'screenshot')) {
      expect(asset.target).toEqual({ width: 1280, height: 640 });
    }
    const screenshotSpec = fs.readFileSync(path.join(ROOT, 'tests/e2e/screenshots.spec.js'), 'utf8');
    expect(screenshotSpec).toMatch(/viewport:\\s*\\{\\s*width:\\s*1280,\\s*height:\\s*640\\s*\\}/);
  });\"\"\"
replace_once(
    'tests/unit/docMediaPolicy.test.js',
    screenshot_target_test,
    screenshot_target_replacement,
    'full-frame screenshot target test',
)
PY

git diff --check
"""
if source.count(marker) != 1:
    raise SystemExit(f'runner insertion marker found {source.count(marker)} times')
runner.write_text(source.replace(marker, addition))
