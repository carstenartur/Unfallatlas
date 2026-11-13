#!/usr/bin/env bash
# Rebuild the map plug-ins without installing their build tools into the application.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
heat_commit=d4572acbe9fe15120e7d8b802835875839b95646
image_commit=9a4190661d92b3ad8bca4b01199d1aed2498effe
if (( $# > 2 )); then
  echo "Usage: $0 [heat-source.tar.gz [image-source.tar.gz]]" >&2
  exit 2
fi

extract_release() {
  local project=$1 revision=$2 digest=$3 destination=$4 supplied=$5
  local archive="$work/$destination.tar.gz"
  if [[ -n "$supplied" ]]; then
    cp -- "$supplied" "$archive"
  else
    curl --fail --location --silent --show-error \
      "https://codeload.github.com/$project/tar.gz/$revision" --output "$archive"
  fi
  printf '%s  %s\n' "$digest" "$archive" | sha256sum --check
  mkdir "$work/$destination"
  tar -xzf "$archive" --strip-components=1 -C "$work/$destination"
}
extract_release Leaflet/Leaflet.heat "$heat_commit" \
  e1ba78f7a301110dc5fec4c6afc9b63bb228866a428b43c7e43a3aa5b5f1c93d heat "${1:-}"
extract_release mapbox/leaflet-image "$image_commit" \
  435635da76368b8a280d8fc57e77ea93724dc09404319a7bfa2bdd6fa4614b87 image "${2:-}"

(
  cd "$work/heat"
  npm ci --ignore-scripts --no-audit --no-fund
  # Upstream derives the copyright end year from the build clock.
  # Freeze just that input before bundling so a rebuild also works after 2026.
  node --input-type=module <<'JS'
import fs from 'node:fs';
const file = 'build/rolldown-config.js';
const source = fs.readFileSync(file, 'utf8');
const clock = 'new Date().getFullYear()';
if (source.split(clock).length !== 2) throw new Error('Unexpected Leaflet.heat banner');
fs.writeFileSync(file, source.replace(clock, '2026'));
JS
  npm run build
  cmp dist/leaflet-heat-global.js "$root/node_modules/leaflet.heat/dist/leaflet-heat-global.js"
  cmp dist/leaflet-heat-global.js.map "$root/node_modules/leaflet.heat/dist/leaflet-heat-global.js.map"
  sha256sum dist/leaflet-heat-global.js{,.map}
)

mkdir "$work/browserify"
cp "$root/vendor/leaflet-build/"{package.json,package-lock.json} "$work/browserify/"
cp "$work/image/index.js" "$work/browserify/"
(
  cd "$work/browserify"
  npm ci --ignore-scripts --no-audit --no-fund
  node_modules/.bin/browserify -s leafletImage index.js > leaflet-image.js
  cmp leaflet-image.js "$root/node_modules/leaflet-image/leaflet-image.js"
  sha256sum leaflet-image.js
)
