#!/usr/bin/env bash
# Rebuild pdfmake's browser export, its source map and Roboto container.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
commit=fa0011f9767fde46d9828d0ce1005563c3dec902
archive_sha=060382006e281c85b4e42f8e15593dbdedde35a745ec00a42541ec64dcb823f0
lock_sha=03de6b450be5877a0036dae5f66115b1cfb06b70645c5c2ea5177707d3625ffe
if (( $# > 1 )); then
  echo "Usage: bash scripts/verify-pdfmake-upstream.sh [local-source-archive]" >&2
  exit 2
fi
build_dir=$(mktemp -d)
trap 'rm -rf -- "$build_dir"' EXIT
archive="$build_dir/source.tar.gz"
if (( $# == 1 )); then
  cp -- "$1" "$archive"
else
  curl --fail --location --silent --show-error "https://codeload.github.com/bpampuch/pdfmake/tar.gz/$commit" --output "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$build_dir"
cd "$build_dir/pdfmake-$commit"
cp -- "$repo_root/vendor/pdfmake-build/npm-lock.json" package-lock.json
printf '%s  %s\n' "$lock_sha" package-lock.json | sha256sum --check
# ajv-keywords 5 requires Ajv 8; the legacy webpack plugin declares webpack 1.
npm pkg set 'devDependencies.ajv=^8.20.0'
node --version
npm --version
npm ci --legacy-peer-deps --no-audit --no-fund
# Compare the five archived notices against the packages actually installed by this build.
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
