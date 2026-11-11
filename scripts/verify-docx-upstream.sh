#!/usr/bin/env bash
# Rebuild the published docx browser bundle using the supplier's source and npm lock.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
commit=ebd29699d5966bffaa9cf829545b8b6d9ed79d9a
archive_sha=b41017ca068e110d7bd00ecd88eb597012bdea3786d61e94e9f61d2a9f881a73
lock_sha=d9d2c3ff7648ef7f7d173f8e97cc0078b1a02ff3f87dd55073c0ec7e13af62f6
bundle_sha=262bb22541dd3f9f1f0323ce4e28093d1a7080124cfbd79db9fb383b3be72a5e
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
node --version
npm --version
npm ci --no-audit --no-fund
npm run build
cmp dist/index.iife.js "$package_bundle"
sha256sum dist/index.iife.js
