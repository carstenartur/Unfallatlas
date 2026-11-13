#!/usr/bin/env bash
# Verify the decoded npm dictionary against both the publisher's file and RFC 7932.
set -euo pipefail
if (( $# != 1 )); then
  echo 'Usage: bash scripts/verify-brotli-dictionary-upstream.sh path/to/node_modules/brotli' >&2
  exit 2
fi
repo_root=$(cd "$(dirname "$0")/.." && pwd)
original=https://raw.githubusercontent.com/google/brotli/ed738e842d2fbdf2d6459e39267a633c4a9b2f5d
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
curl --fail --location --silent --show-error --retry 2 "$original/c/common/dictionary.bin" --output "$work/dictionary.bin"
curl --fail --location --silent --show-error --retry 2 "$original/LICENSE" --output "$work/LICENSE"
curl --fail --location --silent --show-error --retry 2 https://www.rfc-editor.org/rfc/rfc7932.txt --output "$work/rfc.txt"
cmp "$work/LICENSE" "$repo_root/vendor/pdfmake-build/licenses/Brotli-MIT.txt"
node - "$1/dec/dictionary.bin.js" "$work" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { brotliDecompressSync } = require('node:zlib');
const wrapper = fs.readFileSync(process.argv[2], 'utf8');
const work = process.argv[3];
const bytes = brotliDecompressSync(Buffer.from(/^module\.exports="([A-Za-z0-9+/=]+)";\n$/.exec(wrapper)[1], 'base64'), { maxOutputLength: 122784 });
const appendix = fs.readFileSync(path.join(work, 'rfc.txt'), 'utf8').split('Appendix A.  Static Dictionary Data\n').at(-1).split('Appendix B.')[0];
const hex = [...appendix.matchAll(/^[ \t]*([0-9a-f]{2,})[ \t]*$/gm)].map(match => match[1]).join('');
if (bytes.length !== 122784 || !bytes.equals(Buffer.from(hex, 'hex')) || !bytes.equals(fs.readFileSync(path.join(work, 'dictionary.bin')))) {
  throw new Error('RFC, original release and decoded npm dictionary differ');
}
console.log('Verified all 122784 dictionary bytes against RFC 7932 and the Brotli release.');
NODE
