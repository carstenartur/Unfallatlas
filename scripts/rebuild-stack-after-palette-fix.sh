#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin main \
  split/405-2-accessibility-task-surface \
  split/405-3-canonical-build \
  split/405-4-vendor-provenance \
  split/405-5-video-export-contract \
  split/405-6-media-validation \
  split/405-7-reviewed-media-evidence \
  --prune

B2=split/405-2-accessibility-task-surface
B3=split/405-3-canonical-build
B4=split/405-4-vendor-provenance
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

OLD_MAIN=7fcfeaef098df7904860c95b2f811ebfac761942
OLD2=a9169b95bce3cd4400f63dde75b31ffe0274cc8a
OLD3=3e19f9ce9224d82a098618a6a357becbbe6b8eb4
OLD4=26b6bc417803f4b2a86ee27f841e5a0eb117b25c
OLD5=6d2ff5af964477a402ace9946b11724c6513e549
OLD6=fa0c0ba61724840fdc7966156cfa4f453d63e65c
OLD7=df0304f869e980ced44cc072502c86239aeebab1
PALETTE_FILE=tests/integration/videoExport.testcontainers.test.js
NEW_BASE=$(git rev-parse origin/main)

if ! git merge-base --is-ancestor "$OLD_MAIN" "$NEW_BASE"; then
  echo "Current main is not descended from the pre-fix main baseline" >&2
  exit 1
fi

# The merged fix must be present on main before the stack is touched.
git show "$NEW_BASE:$PALETTE_FILE" > /tmp/main-palette-test.js
for marker in \
  'const parseHexColor = (value) =>' \
  'const channelTolerance = 14;' \
  'result.trafficPaletteSize === 4'; do
  grep -F "$marker" /tmp/main-palette-test.js >/dev/null || {
    echo "Merged palette contract marker missing from main: $marker" >&2
    exit 1
  }
done

# Later PRs 6 and 7 must not modify the palette test; otherwise the controlled
# carry-forward below would need another explicit merge boundary.
for range in "$OLD5:$OLD6" "$OLD6:$OLD7"; do
  base=${range%%:*}; head=${range##*:}
  if ! git diff --quiet "$base" "$head" -- "$PALETTE_FILE"; then
    echo "Unexpected later modification of $PALETTE_FILE in $range" >&2
    exit 1
  fi
done

apply_changed_paths() {
  local old_base=$1 old_head=$2
  local status path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git rm -f --ignore-unmatch -- "$path" ;;
      *)  git checkout "$old_head" -- "$path" ;;
    esac
  done < <(git diff --no-renames --name-status -z "$old_base" "$old_head")
}

verify_reviewed_delta() {
  local old_base=$1 old_head=$2 new_head=$3 except_path=${4:-}
  local status path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    [[ -n "$except_path" && "$path" == "$except_path" ]] && continue
    case "$status" in
      D*)
        if git cat-file -e "$new_head:$path" 2>/dev/null; then
          echo "Deleted reviewed path unexpectedly exists: $path" >&2
          return 1
        fi
        ;;
      *)
        if [[ "$(git rev-parse "$old_head:$path")" != "$(git rev-parse "$new_head:$path")" ]]; then
          echo "Reviewed path differs after rebuild: $path" >&2
          return 1
        fi
        ;;
    esac
  done < <(git diff --no-renames --name-status -z "$old_base" "$old_head")
}

apply_palette_contract_to_file() {
  local path=$1
  python3 - "$path" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
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
  // Traffic is intentionally rendered at 95% opacity over the wide slope
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
  const counts = {
    canvases: 0,
    slopePixels: 0,
    trafficPixels: 0,
    slopePaletteSize: slopePalette.length,
    trafficPaletteSize: trafficPalette.length,
  };
"""
if old not in s:
    raise SystemExit('stale palette counter block not found in reviewed PR 5 file')
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
    raise SystemExit('browser result condition not found in reviewed PR 5 file')
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
    raise SystemExit('palette assertions not found in reviewed PR 5 file')
p.write_text(s.replace(old_expect, new_expect, 1))
PY
}

commit_and_push() {
  local branch=$1 message=$2
  git add -A
  git diff --cached --check
  git diff --cached --quiet && { echo "Empty rebuilt delta for $branch" >&2; exit 1; }
  git commit -m "$message"
  git push --force-with-lease origin "$branch"
}

# Parts 2–4 inherit the merged test-contract fix from main unchanged.
git checkout -B "$B2" "$NEW_BASE"
apply_changed_paths "$OLD_MAIN" "$OLD2"
commit_and_push "$B2" "ux: rebuild accessibility task surface after palette contract fix"
NEW2=$(git rev-parse HEAD)
verify_reviewed_delta "$OLD_MAIN" "$OLD2" "$NEW2"
[[ "$(git rev-parse "$NEW_BASE:$PALETTE_FILE")" == "$(git rev-parse "$NEW2:$PALETTE_FILE")" ]] || exit 1

git checkout -B "$B3" "$NEW2"
apply_changed_paths "$OLD2" "$OLD3"
commit_and_push "$B3" "build: rebuild canonical site construction after palette fix"
NEW3=$(git rev-parse HEAD)
verify_reviewed_delta "$OLD2" "$OLD3" "$NEW3"
[[ "$(git rev-parse "$NEW2:$PALETTE_FILE")" == "$(git rev-parse "$NEW3:$PALETTE_FILE")" ]] || exit 1

git checkout -B "$B4" "$NEW3"
apply_changed_paths "$OLD3" "$OLD4"
commit_and_push "$B4" "build: rebuild vendor provenance after palette fix"
NEW4=$(git rev-parse HEAD)
verify_reviewed_delta "$OLD3" "$OLD4" "$NEW4"
[[ "$(git rev-parse "$NEW3:$PALETTE_FILE")" == "$(git rev-parse "$NEW4:$PALETTE_FILE")" ]] || exit 1

# Part 5 owns the full video/context integration file. Reapply its reviewed
# delta first, then carry the independently reviewed palette contract into that
# newer file without replacing any of Part 5's video assertions.
git checkout -B "$B5" "$NEW4"
apply_changed_paths "$OLD4" "$OLD5"
git show "$OLD5:$PALETTE_FILE" > "$PALETTE_FILE"
apply_palette_contract_to_file "$PALETTE_FILE"
cp "$PALETTE_FILE" /tmp/expected-pr5-palette.js
commit_and_push "$B5" "export: rebuild video evidence contract with palette-safe canvas QA"
NEW5=$(git rev-parse HEAD)
verify_reviewed_delta "$OLD4" "$OLD5" "$NEW5" "$PALETTE_FILE"
cmp -s <(git show "$NEW5:$PALETTE_FILE") /tmp/expected-pr5-palette.js || {
  echo "Rebuilt PR 5 palette test differs from controlled expected file" >&2
  exit 1
}

# Parts 6–7 do not touch the palette test and therefore preserve the fixed PR 5
# blob exactly while retaining all reviewed media tooling/assets.
git checkout -B "$B6" "$NEW5"
apply_changed_paths "$OLD5" "$OLD6"
commit_and_push "$B6" "docs: rebuild media validation after palette fix"
NEW6=$(git rev-parse HEAD)
verify_reviewed_delta "$OLD5" "$OLD6" "$NEW6"
[[ "$(git rev-parse "$NEW5:$PALETTE_FILE")" == "$(git rev-parse "$NEW6:$PALETTE_FILE")" ]] || exit 1

git checkout -B "$B7" "$NEW6"
apply_changed_paths "$OLD6" "$OLD7"
commit_and_push "$B7" "docs: rebuild reviewed media evidence after palette fix"
NEW7=$(git rev-parse HEAD)
verify_reviewed_delta "$OLD6" "$OLD7" "$NEW7"
[[ "$(git rev-parse "$NEW6:$PALETTE_FILE")" == "$(git rev-parse "$NEW7:$PALETTE_FILE")" ]] || exit 1

# The final product tree must differ from the previously verified final stack in
# exactly one path: the corrected integration-test contract.
mapfile -t final_diff < <(git diff --name-only "$OLD7" "$NEW7")
if [[ ${#final_diff[@]} -ne 1 || "${final_diff[0]}" != "$PALETTE_FILE" ]]; then
  echo "Unexpected final stack differences:" >&2
  printf '  %s\n' "${final_diff[@]}" >&2
  exit 1
fi
cmp -s <(git show "$NEW7:$PALETTE_FILE") /tmp/expected-pr5-palette.js || exit 1

cat > /tmp/comment.md <<EOF
Stack rebuilt after merging the context-canvas palette contract:

- #433, #439 and #434 inherit the merged test fix from current \`main\` unchanged.
- #440 retains its complete reviewed video/export delta and receives the same controlled palette/compositing contract in its newer integration-test file.
- #441 and #442 preserve that fixed blob while retaining their reviewed deltas.
- The final #442 tree differs from the previously verified final stack in exactly one path: \`$PALETTE_FILE\`.

New heads:
- #433 \`$NEW2\`
- #439 \`$NEW3\`
- #434 \`$NEW4\`
- #440 \`$NEW5\`
- #441 \`$NEW6\`
- #442 \`$NEW7\`
EOF
gh pr comment 433 --body-file /tmp/comment.md
