#!/usr/bin/env bash
set -euo pipefail

git config user.name "Unfallwerkbank QA"
git config user.email "3164220+carstenartur@users.noreply.github.com"
git fetch origin \
  main \
  split/405-1-runtime-readiness \
  split/405-2-accessibility-task-surface \
  split/405-3-canonical-build \
  split/405-4-vendor-provenance \
  split/405-5-video-export-contract \
  split/405-6-media-validation \
  split/405-7-reviewed-media-evidence \
  --prune

# Immutable pre-diagnostic/pre-rebuild review heads.
OLD1=434c5b33acc596f768cda52c3697a086ce1d743c
OLD2=6f532eed03749903e10c1dfee907d730494882ee
OLD3=1881b864d7b4151568253d92b32f17bbe75fec54
OLD4=0709c148eb40a6319e89a13e96d695e7a7eb238d
OLD5=4c59159aa80369aae892e6f3009faeceb3895ea0
OLD6=e336536f98ede31ac1cc7071e1691048555d793e
OLD7=ecb31c7fcff3a4e8da8fc73c4e739a4f049a77d2

B1=split/405-1-runtime-readiness
B2=split/405-2-accessibility-task-surface
B3=split/405-3-canonical-build
B4=split/405-4-vendor-provenance
B5=split/405-5-video-export-contract
B6=split/405-6-media-validation
B7=split/405-7-reviewed-media-evidence

apply_changed_paths() {
  local source=$1 compare_base=$2
  local status path new_path
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path
    case "$status" in
      D*) git rm -f --ignore-unmatch -- "$path" ;;
      R*|C*)
        IFS= read -r -d '' new_path
        git rm -f --ignore-unmatch -- "$path"
        git checkout "$source" -- "$new_path"
        ;;
      *) git checkout "$source" -- "$path" ;;
    esac
  done < <(git diff --name-status -z "$compare_base" "$source")
}

assert_delta_exact() {
  local expected=$1 actual=$2 compare_base=$3
  local mismatches=0 path
  while IFS= read -r -d '' path; do
    if ! git diff --quiet "$expected" "$actual" -- "$path"; then
      echo "Mismatch after rebuild: $path" >&2
      mismatches=$((mismatches + 1))
    fi
  done < <(git diff --name-only -z "$compare_base" "$expected")
  (( mismatches == 0 )) || exit 1
}

commit_push() {
  local branch=$1 message=$2
  git add -A
  git diff --cached --quiet && { echo "No changes for $branch" >&2; exit 1; }
  git commit -m "$message"
  git push --force-with-lease origin "$branch"
}

# Repair PR 1 at the real runtime seam. Start from the current branch so no
# substantive runtime changes are lost, remove diagnostic-only files and
# restore the production visual workflow.
git checkout -B "$B1" "origin/$B1"
git checkout origin/main -- .github/workflows/visual-check.yml
git rm -f --ignore-unmatch .github/workflows/unit-diagnostic.yml
python3 - <<'PY'
from pathlib import Path
p = Path('werkbank_v2.html')
s = p.read_text()
replacements = {
    '<meta name="unfallwerkbank-build" content="2026-01-01 00:00 UTC"/>':
        '<meta name="unfallwerkbank-build" content="2026-07-19 00:00 UTC"/>',
    'window.UA = { BUILD: "2026-01-01 00:00 UTC" }':
        'window.UA = { BUILD: "2026-07-19 00:00 UTC" }',
    'js/ua.core.js?v=2026-01-01': 'js/ua.core.js?v=2026-07-19',
    'js/ua.utils.js?v=2026-01-01': 'js/ua.utils.js?v=2026-07-19',
    'js/ua.popup_context.js?v=2026-01-01': 'js/ua.popup_context.js?v=2026-07-19',
    'js/ua.map_v2.js?v=2026-06-28': 'js/ua.map_v2.js?v=2026-07-19',
    'js/ua.report_v2.js?v=2026-06-28': 'js/ua.report_v2.js?v=2026-07-19',
    'js/ua.app_v2.js?v=2026-06-28': 'js/ua.app_v2.js?v=2026-07-19',
    'js/ua.political-context.js?v=2026-01-01': 'js/ua.political-context.js?v=2026-07-19',
    'js/ua.priorities.js?v=2026-01-01': 'js/ua.priorities.js?v=2026-07-19',
}
for old, new in replacements.items():
    if old not in s:
        raise SystemExit(f'missing expected HTML token: {old}')
    s = s.replace(old, new, 1)
needle = '  <script src="js/ua.map_v2.js?v=2026-07-19"></script>'
lifecycle = '  <script src="js/ua.lifecycle.js?v=2026-07-19"></script>\n'
if 'js/ua.lifecycle.js' not in s:
    if needle not in s:
        raise SystemExit('map_v2 script seam not found')
    s = s.replace(needle, lifecycle + needle, 1)
p.write_text(s)
PY
commit_push "$B1" "fix: load lifecycle before map and app producers"
NEW1=$(git rev-parse HEAD)

# Reconstruct every later branch from the new predecessor while copying the
# exact old delta. Thus OLD2..OLD7 retain their previously reviewed trees.
rebuild() {
  local new_base=$1 branch=$2 old_base=$3 old_head=$4 message=$5
  git checkout -B "$branch" "$new_base"
  apply_changed_paths "$old_head" "$old_base"
  commit_push "$branch" "$message"
  assert_delta_exact "$old_head" HEAD "$old_base"
}

rebuild "$NEW1" "$B2" "$OLD1" "$OLD2" "ux: rebase accessibility task surface after runtime seam fix"
NEW2=$(git rev-parse HEAD)
rebuild "$NEW2" "$B3" "$OLD2" "$OLD3" "build: rebase canonical site construction"
NEW3=$(git rev-parse HEAD)
rebuild "$NEW3" "$B4" "$OLD3" "$OLD4" "build: rebase vendor and license provenance"
NEW4=$(git rev-parse HEAD)
rebuild "$NEW4" "$B5" "$OLD4" "$OLD5" "export: rebase video evidence contract"
NEW5=$(git rev-parse HEAD)
rebuild "$NEW5" "$B6" "$OLD5" "$OLD6" "docs: rebase media validation tooling"
NEW6=$(git rev-parse HEAD)
rebuild "$NEW6" "$B7" "$OLD6" "$OLD7" "docs: rebase reviewed media evidence"
NEW7=$(git rev-parse HEAD)

# Downstream review trees must remain unchanged. Compare the entire old/new
# trees for PRs 2–7, not only their delta paths.
for pair in "$OLD2:$NEW2" "$OLD3:$NEW3" "$OLD4:$NEW4" "$OLD5:$NEW5" "$OLD6:$NEW6" "$OLD7:$NEW7"; do
  old=${pair%%:*}; new=${pair##*:}
  if [[ "$(git rev-parse "$old^{tree}")" != "$(git rev-parse "$new^{tree}")" ]]; then
    echo "Tree mismatch: $old != $new" >&2
    git diff --stat "$old" "$new" >&2 || true
    exit 1
  fi
done

cat > /tmp/comment.md <<EOF
Runtime split seam repaired:

- #437 now loads \`ua.lifecycle.js\` before map/app producers and carries only the required runtime cache-version updates.
- Temporary visual/unit diagnostic workflow files were removed.
- #433, #439, #434, #440, #441 and #442 were rebuilt on the corrected predecessor.
- Their complete Git tree SHAs are identical to their previously reviewed heads; only parent history changed.

New final stack head: \`$NEW7\`.
EOF
gh pr comment 437 --body-file /tmp/comment.md
