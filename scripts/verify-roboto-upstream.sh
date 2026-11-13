#!/usr/bin/env bash
# Rebuild the four Roboto TTF inputs used in pdfmake's VFS from Google's glyph sources.
set -euo pipefail
if (( $# < 1 || $# > 2 )); then
  echo 'Usage: bash scripts/verify-roboto-upstream.sh release.zip [source.tar.gz]' >&2
  exit 2
fi
repo_root=$(cd "$(dirname "$0")/.." && pwd)
release=$(realpath "$1")
python_bin=${ROBOTO_PYTHON:-python3.11}
commit=5166f3d07889bf7d3732fb72e09623d7e52f862b
source_sha=4457d6420443e77b43e178df94a15a9465c0ba74774ea1d76602acdd11901e8c
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
archive="$work/source.tar.gz"
if (( $# == 2 )); then
  cp -- "$2" "$archive"
else
  curl --fail --silent --show-error --location \
    "https://codeload.github.com/googlefonts/roboto-3-classic/tar.gz/$commit" --output "$archive"
fi
printf '%s  %s\n' "$source_sha" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$work"
"$python_bin" -m venv "$work/venv"
export PATH="$work/venv/bin:$PATH"
python -m pip install --disable-pip-version-check --only-binary=:all: --require-hashes \
  -r "$repo_root/vendor/pdfmake-build/roboto-requirements.txt"
cd "$work/roboto-3-classic-$commit"
export PYTHONPATH="$PWD"
# Preserve the shipped notice while verifying the publisher's exact wording.
# Its archived copy has only whitespace normalization (an empty line and a trailing space).
python - "$repo_root/licenses/vendor/Roboto-OFL-1.1.txt" <<'PYLICENSE'
from pathlib import Path
import sys

if Path("OFL.txt").read_text().split() != Path(sys.argv[1]).read_text().split():
    sys.exit("Shipped Roboto license differs from the source release")
PYLICENSE
# The release used the wall clock for two name records. Use the font's build time instead.
python - <<'PY'
from pathlib import Path

helpers = Path("scripts/__init__.py")
source = helpers.read_text()
clock = "date.today().year"
if source.count(clock) != 2:
    raise SystemExit("Unexpected upstream version/date code")
helpers.write_text(source.replace(clock, 'date.utcfromtimestamp(int(os.environ["SOURCE_DATE_EPOCH"])).year'))
PY
export SOURCE_DATE_EPOCH=1781710015
mkdir -p fonts/web
fontmake -m sources/Roboto.designspace -o variable --output-path fonts/variable.ttf
python scripts/drop_mvar.py fonts/variable.ttf
python scripts/gen_stat.py fonts/variable.ttf
python -m vttLib mergefile sources/vtt-hinting.ttx fonts/variable.ttf
python -m vttLib compile fonts/variable.ttf fonts/hinted.ttf --ship
python scripts/touchup_for_web.py fonts/hinted.ttf
python scripts/subset_for_web.py fonts/hinted.ttf fonts/web/variable.ttf
python scripts/touchup_for_web.py fonts/web/variable.ttf
python scripts/instantiate_statics.py fonts/web/variable.ttf fonts/web/static

python - "$repo_root/vendor/pdfmake-build/roboto-release.json" "$release" <<'PY'
import hashlib
import io
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

from fontTools.misc.timeTools import epoch_diff
from fontTools.ttLib import TTFont

manifest = json.loads(Path(sys.argv[1]).read_bytes())
archive = Path(sys.argv[2])
if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest["archiveSha256"]:
    sys.exit("Roboto release checksum mismatch")
with zipfile.ZipFile(archive) as fonts:
    for name, entry in sorted(manifest["files"].items()):
        reference = fonts.read(entry["path"])
        with TTFont(io.BytesIO(reference)) as original:
            timestamp = original["head"].modified + epoch_diff
        candidate = Path("fonts/web/static") / name
        subprocess.run(
            [sys.executable, "scripts/touchup_for_web.py", str(candidate)],
            env={**os.environ, "SOURCE_DATE_EPOCH": str(timestamp)}, check=True,
        )
        output = candidate.read_bytes()
        digest = hashlib.sha256(output).hexdigest()
        if digest != entry["sha256"] or output != reference:
            sys.exit("Roboto source rebuild differs from release: " + name)
        print(digest, name, flush=True)
PY
