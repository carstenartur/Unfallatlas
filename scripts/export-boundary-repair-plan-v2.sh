#!/usr/bin/env bash
set -euo pipefail

SOURCE=scripts/export-boundary-repair-plan.sh
TEMP=/tmp/export-boundary-repair-plan-v2.sh
cp "$SOURCE" "$TEMP"

python3 - "$TEMP" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()
old = '''# Moving the canonical context runner from the media-evidence PR into #439 is
# the only additional intentional pre-#442 tree drift besides the automatic
# screenshots inherited from main.
old = '  [[ "$path" == docs/screenshots/*.png ]] || {'
new = '  [[ "$path" == docs/screenshots/*.png || "$path" == scripts/run-context-data-e2e.js ]] || {'
if s.count(old) != 1:
    raise SystemExit('pre-media drift allowlist not found exactly once')
s = s.replace(old, new)
'''
new = '''# Moving the canonical context runner from the media-evidence PR into #439 is
# the only additional intentional pre-#442 tree drift besides the automatic
# screenshots inherited from main. Replace the complete second allowlist block
# so the identical, stricter post-#433 main guard remains unchanged.
old = """mapfile -t pre_media_diff < <(git diff --name-only \"$OLD6\" \"$NEW6\")
for path in \"${pre_media_diff[@]}\"; do
  [[ \"$path\" == docs/screenshots/*.png ]] || {
    echo \"Unexpected #441 tree drift: $path\" >&2
    exit 1
  }
done
"""
new = """mapfile -t pre_media_diff < <(git diff --name-only \"$OLD6\" \"$NEW6\")
for path in \"${pre_media_diff[@]}\"; do
  [[ \"$path\" == docs/screenshots/*.png || \"$path\" == scripts/run-context-data-e2e.js ]] || {
    echo \"Unexpected #441 tree drift: $path\" >&2
    exit 1
  }
done
"""
if s.count(old) != 1:
    raise SystemExit('pre-media drift block not found exactly once')
s = s.replace(old, new)
'''
if s.count(old) != 1:
    raise SystemExit('export-script allowlist transformation not found exactly once')
p.write_text(s.replace(old, new))
PY

bash "$TEMP"
