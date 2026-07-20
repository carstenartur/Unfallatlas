#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin fix/context-canvas-palette-contract --prune
git checkout -B fix/context-canvas-palette-contract origin/fix/context-canvas-palette-contract

python3 - <<'PY'
from pathlib import Path
p = Path('tests/integration/videoExport.testcontainers.test.js')
s = p.read_text()
old = """  const closeTo = (r, g, b, palette) => palette.some(([pr, pg, pb]) =>
    Math.abs(r - pr) <= 8 && Math.abs(g - pg) <= 8 && Math.abs(b - pb) <= 8
  );
"""
new = """  // Traffic is intentionally rendered at 95% opacity over the wide slope
  // casing on the shared canvas. The resulting core pixel may therefore differ
  // from the traffic legend colour by ceil((1 - 0.95) * 255) = 13 channel
  // values. Allow one additional value for integer rounding; the traffic and
  // slope palettes remain far enough apart that this cannot count slope-only
  // pixels as traffic.
  const channelTolerance = 14;
  const closeTo = (r, g, b, palette) => palette.some(([pr, pg, pb]) =>
    Math.abs(r - pr) <= channelTolerance
      && Math.abs(g - pg) <= channelTolerance
      && Math.abs(b - pb) <= channelTolerance
  );
"""
if old not in s:
    raise SystemExit('expected strict palette tolerance block not found')
s = s.replace(old, new, 1)
old_ok = """      const ok = result.canvases > 0
        && result.slopePixels >= 20
        && result.trafficPixels >= 20
"""
new_ok = """      const ok = result.canvases > 0
        && result.slopePaletteSize >= 5
        && result.trafficPaletteSize === 4
        && result.slopePixels >= 20
        && result.trafficPixels >= 20
"""
if old_ok not in s:
    raise SystemExit('expected browser result condition not found')
s = s.replace(old_ok, new_ok, 1)
old_expect = """    expect(result.canvases).toBeGreaterThan(0);
    expect(result.slopePixels).toBeGreaterThanOrEqual(20);
    expect(result.trafficPixels).toBeGreaterThanOrEqual(20);
"""
new_expect = """    expect(result.canvases).toBeGreaterThan(0);
    expect(result.slopePaletteSize).toBeGreaterThanOrEqual(5);
    expect(result.trafficPaletteSize).toBe(4);
    expect(result.slopePixels).toBeGreaterThanOrEqual(20);
    expect(result.trafficPixels).toBeGreaterThanOrEqual(20);
"""
if old_expect not in s:
    raise SystemExit('expected palette assertions not found')
p.write_text(s.replace(old_expect, new_expect, 1))
PY

git add tests/integration/videoExport.testcontainers.test.js
git diff --cached --check
git diff --cached --stat
git commit -m "test: account for shared-canvas traffic compositing"
git push --force-with-lease origin fix/context-canvas-palette-contract
