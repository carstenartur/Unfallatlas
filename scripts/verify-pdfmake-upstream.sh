#!/usr/bin/env bash
# Rebuild pdfmake's browser export, its source map and Roboto container.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
commit=9c0d9c96a21e20b278547380a1ec9d9e6cb4b89a
archive_sha=cced114d012c15f9e042b6a2419f8953388623e5520a34026c8c9253262da162
lock_sha=774707993a725893f1c7506bdbfa493394a51b2e56cb76804133b1f37b73af70
if (( $# > 2 )); then
  echo "Usage: bash scripts/verify-pdfmake-upstream.sh [local-source-archive [local-roboto-archive]]" >&2
  exit 2
fi
# Reproduce the embedded UCD and shaper data against the app lock installed by Maven.
python3 "$repo_root/scripts/reproduce-pdf-unicode.py"
build_dir=$(mktemp -d)
trap 'rm -rf -- "$build_dir"' EXIT
archive="$build_dir/source.tar.gz"
font_lock="$repo_root/vendor/pdfmake-build/roboto-release.json"
font_archive="$build_dir/roboto.zip"
if (( $# == 2 )); then
  cp -- "$2" "$font_archive"
else
  font_url=$(node -p 'require(process.argv[1]).archiveUrl' "$font_lock")
  curl --fail --location --silent --show-error "$font_url" --output "$font_archive"
fi
if (( $# >= 1 )); then
  cp -- "$1" "$archive"
else
  curl --fail --location --silent --show-error "https://codeload.github.com/bpampuch/pdfmake/tar.gz/$commit" --output "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$build_dir"
cd "$build_dir/pdfmake-$commit"
# Verify the typeface publisher's static web TTFs against the actual generator inputs.
python3 - "$font_lock" "$font_archive" <<'PYFONT'
import hashlib
import json
import sys
import zipfile
from pathlib import Path

lock = json.loads(Path(sys.argv[1]).read_bytes())
archive = Path(sys.argv[2])
if hashlib.sha256(archive.read_bytes()).hexdigest() != lock['archiveSha256']:
    sys.exit('Roboto release archive checksum mismatch')
with zipfile.ZipFile(archive) as release:
    for name, entry in lock['files'].items():
        raw = release.read(entry['path'])
        if hashlib.sha256(raw).hexdigest() != entry['sha256'] or raw != (Path('fonts/Roboto') / name).read_bytes():
            sys.exit('Roboto release differs from the VFS input: ' + name)
PYFONT
bash "$repo_root/scripts/verify-roboto-upstream.sh" "$font_archive"
cp -- "$repo_root/vendor/pdfmake-build/npm-lock.json" package-lock.json
printf '%s  %s\n' "$lock_sha" package-lock.json | sha256sum --check
# ajv-keywords 5 requires Ajv 8; the legacy webpack plugin declares webpack 1.
npm pkg set 'devDependencies.ajv=^8.20.0'
node --version
npm --version
npm ci --no-audit --no-fund
bash "$repo_root/scripts/verify-xmldoc-upstream.sh" "$PWD/node_modules/xmldoc"
bash "$repo_root/scripts/verify-brotli-dictionary-upstream.sh" "$PWD/node_modules/brotli"
python3 "$repo_root/scripts/verify-brotli-c-port.py" "$PWD/node_modules/brotli"
python3 "$repo_root/scripts/verify-pdfkit-parser.py" "$PWD/node_modules/pdfkit"
# Compare each archived notice against every package that supplies it.
node - "$repo_root/vendor/pdfmake-build" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const files = JSON.parse(fs.readFileSync(path.join(root, 'license-files.json'), 'utf8'));
for (const [lockPath, license] of Object.entries(files)) {
  const original = fs.readFileSync(path.join(lockPath, license.source));
  const archived = fs.readFileSync(path.join(root, 'licenses', license.file));
  if (!original.equals(archived)) throw new Error('License differs from installed PDF build dependency: ' + lockPath);
}
NODE
node "$repo_root/vendor/pdfmake-build/webpack.cjs"
npm run build:vfs
for file in pdfmake.min.js pdfmake.min.js.map vfs_fonts.js; do
  cmp "build/$file" "$repo_root/node_modules/pdfmake/build/$file"
  sha256sum "build/$file"
done
