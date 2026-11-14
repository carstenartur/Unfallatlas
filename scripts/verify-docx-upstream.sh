#!/usr/bin/env bash
# Rebuild the published docx browser bundle using the supplier's source and npm lock.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
commit=dc8bd21a0c4ab447fda0d5ad149f16ee87979de8
archive_sha=9702ad5682f51134a6bc31e0db5af382663a00176f72dda7775e358ae8c656d5
lock_sha=e3454d37dfbc33e77160559f7e1afffbc685d72f19f42869b8f72e7c81d17ad9
bundle_sha=5d3091bf1e4cb622f0f6cdf4a552db8664e3f3a7524205709b52ba20313255d2
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
