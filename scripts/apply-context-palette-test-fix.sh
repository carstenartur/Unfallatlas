#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin fix/context-canvas-palette-contract main --prune
git checkout -B fix/context-canvas-palette-contract origin/fix/context-canvas-palette-contract

python3 - <<'PY'
from pathlib import Path
p = Path('tests/integration/videoExport.testcontainers.test.js')
s = p.read_text()
old = """// Playwright serializes this function into the browser context. Keep it closed
// over browser globals only; no eval or test-only product globals are needed.
function browserPaletteCounter() {
  const slopePalette = [
    [255,255,178], [254,204,92], [253,141,60],
    [240,59,32], [189,0,38], [154,169,184], [189,189,189],
  ];
  const trafficPalette = [
    [255,255,204], [161,218,180], [65,182,196], [34,94,168],
  ];
  const closeTo = (r, g, b, palette) => palette.some(([pr, pg, pb]) =>
    Math.abs(r - pr) <= 8 && Math.abs(g - pg) <= 8 && Math.abs(b - pb) <= 8
  );
  const counts = { canvases: 0, slopePixels: 0, trafficPixels: 0 };
"""
new = """// Playwright serializes this function into the browser context. Keep it closed
// over browser globals and the documented UA.contextRoadLayer public API only;
// duplicating RGB literals here caused the integration contract to drift when
// the traffic palette was made more contrast-safe.
function browserPaletteCounter() {
  const parseHexColor = (value) => {
    const match = /^#([0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!match) return null;
    const rgb = Number.parseInt(match[1], 16);
    return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  };
  const roadLayer = window.UA && window.UA.contextRoadLayer;
  const paletteFrom = (colors) => Object.values(colors || {})
    .map(parseHexColor)
    .filter(Boolean);
  const slopePalette = paletteFrom(roadLayer && roadLayer.SLOPE_COLORS);
  for (const special of [
    roadLayer && roadLayer.SLOPE_LOW_CONFIDENCE_COLOR,
    roadLayer && roadLayer.SLOPE_NO_SIGNAL_COLOR,
  ]) {
    const parsed = parseHexColor(special);
    if (parsed) slopePalette.push(parsed);
  }
  const trafficPalette = paletteFrom(roadLayer && roadLayer.TRAFFIC_COLORS);
  const closeTo = (r, g, b, palette) => palette.some(([pr, pg, pb]) =>
    Math.abs(r - pr) <= 8 && Math.abs(g - pg) <= 8 && Math.abs(b - pb) <= 8
  );
  const counts = {
    canvases: 0,
    slopePixels: 0,
    trafficPixels: 0,
    slopePaletteSize: slopePalette.length,
    trafficPaletteSize: trafficPalette.length,
  };
"""
if old not in s:
    raise SystemExit('expected stale browser palette block not found')
p.write_text(s.replace(old, new, 1))
PY

git add tests/integration/videoExport.testcontainers.test.js
git diff --cached --check
git diff --cached --stat
if git diff --cached --quiet; then
  echo 'No palette contract change produced' >&2
  exit 1
fi
git commit -m "test: derive context canvas palettes from renderer API"
git push --force-with-lease origin fix/context-canvas-palette-contract
