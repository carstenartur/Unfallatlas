#!/usr/bin/env bash
# Rebuild the published docx browser bundle using the supplier's source and npm lock.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
commit=f227ee1b1df33e72829b4250c156488be2fae193
archive_sha=dc7145fb583d8363d034d4d1aa780942c38ec2f8156e46d9d9ae7dc1921600a4
lock_sha=79336671d6bb75e1bf53d6f019241a4f186bb0cb18308a0514c141a0a8bac7e8
bundle_sha=436e003b7fc506af50f46ec0eb863d4dfba0f74090c7c5db71249f233f1e48c0
check_hash() {
  printf '%s  %s\n' "$1" "$2" | sha256sum --check --status
}
if (( $# > 1 )); then
  echo "Usage: bash scripts/verify-docx-upstream.sh [local-source-archive]" >&2
  exit 2
fi
package_bundle="$repo_root/node_modules/docx/dist/index.iife.js"
check_hash "$bundle_sha" "$package_bundle" || { echo "Installed docx browser bundle differs from the recorded release." >&2; exit 1; }
build_dir=$(mktemp -d)
trap 'rm -rf -- "$build_dir"' EXIT
archive="$build_dir/source.tar.gz"
if (( $# == 1 )); then
  cp -- "$1" "$archive"
else
  curl --fail --location --silent --show-error "https://codeload.github.com/dolanmiu/docx/tar.gz/$commit" --output "$archive"
fi
check_hash "$archive_sha" "$archive" || { echo "docx source archive checksum mismatch." >&2; exit 1; }
tar -xzf "$archive" -C "$build_dir"
cd "$build_dir/docx-$commit"
check_hash "$lock_sha" package-lock.json || { echo "docx upstream npm lock checksum mismatch." >&2; exit 1; }
gzip -dc "$repo_root/vendor/docx-build/npm-lock.json.gz" | cmp - package-lock.json
node --version
npm --version
npm ci --no-audit --no-fund
npm run build
python3 "$repo_root/scripts/verify-docx-runtime-sources.py"
cmp dist/index.iife.js "$package_bundle"
sha256sum dist/index.iife.js
