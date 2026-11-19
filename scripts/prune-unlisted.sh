#!/usr/bin/env bash
# Removes tracked files that are NOT listed in keep.txt, plus always-junk files
# (._*, .DS_Store, *.bak ...). History is kept; this only deletes from the current tree.
#
#   scripts/prune-unlisted.sh                  # dry run: list what would be removed
#   scripts/prune-unlisted.sh --apply          # git rm those files (you commit afterwards)
#   scripts/prune-unlisted.sh --apply --max-delete 50
#
# Safety: aborts if more than --max-delete files (default 20) would be removed,
# so a typo in keep.txt cannot wipe the site.
set -euo pipefail

APPLY=0; MAX=20
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --max-delete) MAX="${2:?number needed}"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"
[ -f keep.txt ] || { echo "keep.txt not found" >&2; exit 1; }

TO_DELETE="$(git ls-files -z | python3 -c '
import sys, re, fnmatch
files = [f for f in sys.stdin.buffer.read().decode().split("\0") if f]
pats = [l.strip() for l in open("keep.txt", encoding="utf-8") if l.strip() and not l.lstrip().startswith("#")]
junk = re.compile(r"(^|/)(\._[^/]*|\.DS_Store|Thumbs\.db|[^/]*~|[^/]*\.(bak|orig|tmp|swp))$|(^|/)(_[a-z]*bak|bak|backup)/")
def kept(f):
    for p in pats:
        if p.endswith("/"):
            if f.startswith(p): return True
        elif fnmatch.fnmatchcase(f, p):
            return True
    return False
for f in files:
    if junk.search(f) or not kept(f):
        print(f)
')"

COUNT=$(printf '%s' "$TO_DELETE" | grep -c . || true)
echo "Files to remove: $COUNT"
[ "$COUNT" -eq 0 ] && exit 0
printf '%s\n' "$TO_DELETE" | sed 's/^/  - /'

if [ "$COUNT" -gt "$MAX" ]; then
  echo "ABORT: $COUNT files exceeds --max-delete $MAX. Check keep.txt." >&2
  exit 2
fi
if [ "$APPLY" -ne 1 ]; then
  echo "Dry run only. Add --apply to remove them."
  exit 0
fi
printf '%s\n' "$TO_DELETE" | xargs -d '\n' git rm -q -f --
echo "Removed $COUNT files (not committed)."
