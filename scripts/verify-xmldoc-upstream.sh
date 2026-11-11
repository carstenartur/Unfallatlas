#!/usr/bin/env bash
# Reproduce the xmldoc module and source map actually imported by pdfmake.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
inputs="$repo_root/vendor/pdfmake-build/xmldoc"
if (( $# < 1 || $# > 2 )); then
  echo "Usage: bash scripts/verify-xmldoc-upstream.sh installed-xmldoc [local-source-archive]" >&2
  exit 2
fi
package=$(cd "$1" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
archive="$work/source.tar.gz"
read_lock() { node -p 'require(process.argv[1])[process.argv[2]]' "$inputs/source.json" "$1"; }
if (( $# == 2 )); then
  cp -- "$2" "$archive"
else
  curl --fail --location --silent --show-error "$(read_lock archiveUrl)" --output "$archive"
fi
printf '%s  %s\n' "$(read_lock archiveSha256)" "$archive" | sha256sum --check
mkdir "$work/source" "$work/compiler"
tar -xzf "$archive" -C "$work/source" --strip-components=1
printf '%s  %s\n' "$(read_lock sourceSha256)" "$work/source/xmldoc.ts" | sha256sum --check
cp -- "$inputs"/package*.json "$work/compiler/"
npm ci --prefix "$work/compiler" --ignore-scripts --no-audit --no-fund
ln -s "$work/compiler/node_modules" "$work/source/node_modules"
"$work/compiler/node_modules/.bin/tsc" --project "$work/source" --sourceMap
cmp "$work/source/dist/xmldoc.js" "$package/dist/xmldoc.js"
cmp "$work/source/dist/xmldoc.js.map" "$package/dist/xmldoc.js.map"
cmp "$work/source/LICENSE" "$package/LICENSE"
sha256sum "$work/source/dist/xmldoc.js" "$work/source/dist/xmldoc.js.map"
