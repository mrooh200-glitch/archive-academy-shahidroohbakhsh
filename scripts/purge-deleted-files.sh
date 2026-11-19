#!/usr/bin/env bash
# Finds files that exist only in git HISTORY (deleted from the working tree long ago)
# and, optionally, erases them from history to shrink the repository.
#
#   scripts/purge-deleted-files.sh                 # dry run: list files + sizes (safe)
#   scripts/purge-deleted-files.sh --min-size 1    # only files totalling >= 1 MB in history
#   scripts/purge-deleted-files.sh --apply         # backup, rewrite history, gc
#   scripts/purge-deleted-files.sh --old-versions  # ALSO drop old versions of files that still exist
#                                                  # (keeps only the version currently in HEAD)
#
# WARNING: --apply REWRITES HISTORY. Afterwards you must force-push, and every
# other clone must be re-cloned. A mirror backup is made first.
set -euo pipefail

APPLY=0
MIN_MB=0
OLD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --old-versions) OLD=1 ;;
    --min-size) MIN_MB="${2:?need MB value}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"
LIST="$(mktemp)"; IDS="$(mktemp)"; trap 'rm -f "$LIST" "$IDS"' EXIT

# Paths present in any commit but absent from HEAD, with total bytes stored.
python3 - "$MIN_MB" "$OLD" "$IDS" > "$LIST" <<'PY'
import subprocess, sys
min_bytes = float(sys.argv[1]) * 1024 * 1024
old, ids_file = sys.argv[2] == "1", sys.argv[3]
git = lambda *a, **k: subprocess.run(("git",) + a, capture_output=True, check=True, **k).stdout
head = set(git("ls-tree", "-r", "-z", "--name-only", "HEAD").decode().split("\0")) - {""}
head_shas = {l.split()[2] for l in git("ls-tree", "-r", "HEAD").decode().splitlines()}
objs = git("rev-list", "--objects", "--all").decode().splitlines()
paths, order = {}, []
for line in objs:
    sha, _, path = line.partition(" ")
    if path and sha not in paths:
        paths[sha] = path
        order.append(sha)
meta = subprocess.run(["git", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
                      input="\n".join(order) + "\n", capture_output=True, text=True, check=True).stdout
totals, ids = {}, []
for line in meta.splitlines():
    sha, typ, size = line.split()
    if typ != "blob":
        continue
    path = paths[sha]
    # default: whole path gone from HEAD; --old-versions: any blob not used by HEAD
    if (old and sha not in head_shas) or (not old and path not in head):
        totals[path] = totals.get(path, 0) + int(size)
        ids.append((path, sha))
keep = {p for p, s in totals.items() if s >= min_bytes}
open(ids_file, "w").write("".join(sha + "\n" for p, sha in ids if p in keep))
for p, s in sorted(totals.items(), key=lambda x: -x[1]):
    if p in keep:
        print(f"{s}\t{p}")
PY

COUNT=$(wc -l < "$LIST")
TOTAL=$(awk -F'\t' '{s+=$1} END {printf "%.1f", s/1048576}' "$LIST")
echo "Files to purge: $COUNT  (~${TOTAL} MB of blobs, before compression)"
echo "-----"
awk -F'\t' '{printf "%8.2f MB  %s\n", $1/1048576, $2}' "$LIST" | head -50
[ "$COUNT" -gt 50 ] && echo "... ($((COUNT-50)) more)"
[ "$COUNT" -eq 0 ] && { echo "Nothing to purge."; exit 0; }

if [ "$APPLY" -ne 1 ]; then
  echo "-----"
  echo "Dry run only. Nothing changed. Re-run with --apply to purge."
  exit 0
fi

command -v git-filter-repo >/dev/null 2>&1 || {
  echo "git-filter-repo not found. Install: pip install git-filter-repo" >&2; exit 1; }

BACKUP="../$(basename "$PWD")-backup-$(date +%Y%m%d-%H%M%S).git"
echo "-----"
echo "Backup mirror -> $BACKUP"
git clone --mirror . "$BACKUP" >/dev/null 2>&1

if [ "$OLD" -eq 1 ]; then
  # strip every blob not used by HEAD (deleted files + old versions)
  git filter-repo --strip-blobs-with-ids "$IDS" --force
else
  PATHS="$(mktemp)"; trap 'rm -f "$LIST" "$IDS" "$PATHS"' EXIT
  cut -f2- "$LIST" | sed 's/^/literal:/' > "$PATHS"
  git filter-repo --invert-paths --paths-from-file "$PATHS" --force
fi
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo "-----"
echo "Done. New size:"; git count-objects -vH | grep size-pack
cat <<MSG
Next steps (manual, on purpose):
  git remote add origin <url>        # filter-repo removes 'origin'
  git push --force --all origin
  git push --force --tags origin
Then re-clone everywhere else. Backup kept at: $BACKUP
MSG
