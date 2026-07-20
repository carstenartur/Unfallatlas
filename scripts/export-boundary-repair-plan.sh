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
import os
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
        'expectedRemote': '903244b7d5a91347c7f4795183b1388195559cc0',
        'parent': {'kind': 'main', 'sha': new_base},
        'localCommit': new3,
        'message': 'build: close canonical site and vendor provenance boundary',
        'customPaths': [
            'Dockerfile',
            'package.json',
            'docs/release-checklist.md',
            'docs/site-build.md',
            'tests/unit/siteBuildContract.test.js',
            '.github/workflows/deploy-release.yml',
            '.github/workflows/generate-data-deploy-pages.yml',
        ],
    },
    {
        'pr': 440,
        'branch': 'split/405-5-video-export-contract',
        'expectedRemote': '73c8781fcdff9d65bd4459933171ef47d414d6be',
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
        'expectedRemote': '4baeda2e8775ddb07e33c6edba5a3962865cb49e',
        'parent': {'kind': 'previous', 'pr': 440},
        'localCommit': new6,
        'message': 'docs: close media tooling and workflow boundary',
        'customPaths': [],
    },
    {
        'pr': 442,
        'branch': 'split/405-7-reviewed-media-evidence',
        'expectedRemote': '582d92ed33354da148a2abf1c251c3013e6243b7',
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
    'schemaVersion': 1,
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
