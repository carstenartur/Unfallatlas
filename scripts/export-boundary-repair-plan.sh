#!/usr/bin/env bash
set -euo pipefail

SOURCE=scripts/repair-build-provenance-media-boundaries.sh
TEMP=/tmp/repair-build-provenance-media-boundaries-export.sh
PLAN_DIR=boundary-repair-plan
cp "$SOURCE" "$TEMP"

python3 - "$TEMP" <<'PY'
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
s = p.read_text()

# The first protected reconstruction has already been applied to the remote
# branches. Keep the historic OLD* commits as delta sources, but guard this
# second reconstruction against the exact currently published heads.
current_heads = {
    '[[ "$(git rev-parse origin/$B3)" == "$OLD3" ]]':
        '[[ "$(git rev-parse origin/$B3)" == "cacd04dac0af8cb273aea36f337604d01161b45c" ]]',
    '[[ "$(git rev-parse origin/$B5)" == "$OLD5" ]]':
        '[[ "$(git rev-parse origin/$B5)" == "107dfd3a588f0b2be2347495e922c5c46198f10f" ]]',
    '[[ "$(git rev-parse origin/$B6)" == "$OLD6" ]]':
        '[[ "$(git rev-parse origin/$B6)" == "61c5cf06c9fa0b1a28a27c97381313077fd5b51b" ]]',
    '[[ "$(git rev-parse origin/$B7)" == "$OLD7" ]]':
        '[[ "$(git rev-parse origin/$B7)" == "0305edd65501a0df19dbc0d6000ef07cf86db30d" ]]',
}
for old, new in current_heads.items():
    if s.count(old) != 1:
        raise SystemExit(f'current-head guard not found exactly once: {old}')
    s = s.replace(old, new)

commit_pattern = re.compile(
    r"commit_and_push\(\) \{\n.*?\n\}\n\nstrip_media_from_combined_build\(\)",
    re.S,
)
commit_only = """commit_and_push() {
  local branch=$1 expected_remote=$2 message=$3
  git add -A
  git diff --cached --check
  git diff --cached --quiet && { echo "Empty rebuilt delta for $branch" >&2; exit 1; }
  git commit -m "$message"
}

strip_media_from_combined_build()"""
s, count = commit_pattern.subn(commit_only, s)
if count != 1:
    raise SystemExit('could not replace push function with commit-only function')

# #439 owns every path needed to execute the canonical site and its dedicated
# context-data E2E. The video-specific state contract remains owned by #440.
old = """make_provenance_only_dockerfile

# Closed boundary checks before publishing the branch.
"""
new = """make_provenance_only_dockerfile
git checkout \"$OLD7\" -- scripts/run-context-data-e2e.js
python3 <<'PYVIDEOREF'
from pathlib import Path
p = Path('werkbank_v2.html')
s = p.read_text()
line = '  <script src=\"js/ua.video-export-contract.js?v=2026-07-19\"></script>\\n'
if s.count(line) != 1:
    raise SystemExit('video export contract script reference not found exactly once')
p.write_text(s.replace(line, ''))
PYVIDEOREF

# Closed boundary checks before publishing the branch.
"""
if s.count(old) != 1:
    raise SystemExit('PR 439 ownership insertion point not found exactly once')
s = s.replace(old, new)

old = """grep -F 'ARG REQUIRE_COMPLETE_VENDOR_PROVENANCE=0' Dockerfile >/dev/null
commit_and_push \"$B3\" \"$OLD3\" \"build: close canonical site and vendor provenance boundary\"
"""
new = """grep -F 'ARG REQUIRE_COMPLETE_VENDOR_PROVENANCE=0' Dockerfile >/dev/null
grep -F \"const { buildSite } = require('./build-site');\" scripts/run-context-data-e2e.js >/dev/null
! grep -F 'ua.video-export-contract.js' werkbank_v2.html >/dev/null
commit_and_push \"$B3\" \"$OLD3\" \"build: close canonical site and runtime boundary\"
"""
if s.count(old) != 1:
    raise SystemExit('PR 439 closed-boundary check block not found exactly once')
s = s.replace(old, new)

# #440 introduces both the video contract implementation and its browser load
# point. Restoring the former #439 HTML blob is a deliberate one-line ownership
# change because that blob contains the exact reviewed script order.
old = """make_hermetic_video_workflow
add_video_workflow_contract_test

grep -F 'ARG VIDEO_EXPORT_INTEGRATION_FIXTURE=0' Dockerfile >/dev/null
"""
new = """make_hermetic_video_workflow
add_video_workflow_contract_test
git checkout \"$OLD3\" -- werkbank_v2.html

grep -F 'ARG VIDEO_EXPORT_INTEGRATION_FIXTURE=0' Dockerfile >/dev/null
grep -F 'ua.video-export-contract.js?v=2026-07-19' werkbank_v2.html >/dev/null
"""
if s.count(old) != 1:
    raise SystemExit('PR 440 ownership insertion point not found exactly once')
s = s.replace(old, new)

# Moving the canonical context runner from the media-evidence PR into #439 is
# the only additional intentional pre-#442 tree drift besides the automatic
# screenshots inherited from main.
old = '  [[ "$path" == docs/screenshots/*.png ]] || {'
new = '  [[ "$path" == docs/screenshots/*.png || "$path" == scripts/run-context-data-e2e.js ]] || {'
if s.count(old) != 1:
    raise SystemExit('pre-media drift allowlist not found exactly once')
s = s.replace(old, new)

marker = '# Retarget the shortened stack only after all tree proofs succeeded.\n'
if marker not in s:
    raise SystemExit('repair tail marker not found')
s = s.split(marker, 1)[0]

s += r'''# Export a Git Data API plan only after every local tree proof succeeded.
PLAN_DIR=boundary-repair-plan
rm -rf "$PLAN_DIR"
mkdir -p "$PLAN_DIR/custom"
python3 - "$PLAN_DIR" "$NEW_BASE" "$NEW3" "$NEW5" "$NEW6" "$NEW7" <<'PYPLAN'
from pathlib import Path
import json
import subprocess
import sys

out = Path(sys.argv[1])
new_base, new3, new5, new6, new7 = sys.argv[2:]

def git(*args, text=True):
    return subprocess.check_output(['git', *args], text=text)

def tree_sha(commit):
    return git('rev-parse', f'{commit}^{{tree}}').strip()

def changed_elements(parent, commit):
    raw = git('diff', '--no-renames', '--name-status', '-z', parent, commit, text=False)
    parts = raw.split(b'\0')
    elements = []
    i = 0
    while i < len(parts) and parts[i]:
        status = parts[i].decode(); path = parts[i + 1].decode(); i += 2
        source = parent if status.startswith('D') else commit
        entry = git('ls-tree', '-z', source, '--', path, text=False)
        if not entry:
            raise SystemExit(f'missing tree entry for {source}:{path}')
        meta, actual_path = entry[:-1].split(b'\t', 1)
        mode, obj_type, sha = meta.decode().split(' ')
        if actual_path.decode() != path:
            raise SystemExit(f'ls-tree path mismatch for {path}')
        elements.append({
            'path': path,
            'mode': mode,
            'type': obj_type,
            'sha': None if status.startswith('D') else sha,
        })
    return elements

branches = [
    {
        'pr': 439,
        'branch': 'split/405-3-canonical-build',
        'expectedRemote': 'cacd04dac0af8cb273aea36f337604d01161b45c',
        'parent': {'kind': 'main', 'sha': new_base},
        'localCommit': new3,
        'message': 'build: close canonical site and runtime boundary',
        'customPaths': [
            'Dockerfile',
            'package.json',
            'docs/release-checklist.md',
            'docs/site-build.md',
            'tests/unit/siteBuildContract.test.js',
            '.github/workflows/deploy-release.yml',
            '.github/workflows/generate-data-deploy-pages.yml',
            'werkbank_v2.html',
        ],
    },
    {
        'pr': 440,
        'branch': 'split/405-5-video-export-contract',
        'expectedRemote': '107dfd3a588f0b2be2347495e922c5c46198f10f',
        'parent': {'kind': 'previous', 'pr': 439},
        'localCommit': new5,
        'message': 'export: own video contract and hermetic container evidence',
        'customPaths': [
            '.github/workflows/test.yml',
            'tests/unit/siteBuildContract.test.js',
        ],
    },
    {
        'pr': 441,
        'branch': 'split/405-6-media-validation',
        'expectedRemote': '61c5cf06c9fa0b1a28a27c97381313077fd5b51b',
        'parent': {'kind': 'previous', 'pr': 440},
        'localCommit': new6,
        'message': 'docs: close media tooling and workflow boundary',
        'customPaths': [],
    },
    {
        'pr': 442,
        'branch': 'split/405-7-reviewed-media-evidence',
        'expectedRemote': '0305edd65501a0df19dbc0d6000ef07cf86db30d',
        'parent': {'kind': 'previous', 'pr': 441},
        'localCommit': new7,
        'message': 'docs: restore reviewed media and durable evidence',
        'customPaths': [],
    },
]

previous_local = new_base
for branch in branches:
    commit = branch['localCommit']
    branch['localTree'] = tree_sha(commit)
    branch['elements'] = changed_elements(previous_local, commit)
    element_by_path = {entry['path']: entry for entry in branch['elements']}
    for path in branch['customPaths']:
        if path not in element_by_path or not element_by_path[path]['sha']:
            raise SystemExit(f'custom path missing from branch delta: {branch["pr"]}:{path}')
        destination = out / 'custom' / str(branch['pr']) / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(git('show', f'{commit}:{path}', text=False))
        element_by_path[path]['customFile'] = str(destination.relative_to(out))
    previous_local = commit

plan = {
    'schemaVersion': 2,
    'verifiedOldFinalTree': tree_sha('582d92ed33354da148a2abf1c251c3013e6243b7'),
    'newBase': new_base,
    'branches': branches,
}
(out / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
print(json.dumps({
    'newBase': new_base,
    'heads': {str(branch['pr']): branch['localCommit'] for branch in branches},
    'trees': {str(branch['pr']): branch['localTree'] for branch in branches},
}, indent=2))
PYPLAN
'''

p.write_text(s)
PY

bash "$TEMP"
