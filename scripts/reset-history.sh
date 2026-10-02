#!/usr/bin/env bash
# Keeps ONLY the current files of this repository and erases ALL old history.
# After running, the repo has a single commit containing today's files.
#
#   scripts/reset-history.sh            # dry run: shows what would happen (safe)
#   scripts/reset-history.sh --apply    # backup + junk removal + wipe history (local only)
#   scripts/reset-history.sh --apply --push
#                                       # same, then force-push the branch to origin
#   scripts/reset-history.sh --apply --push --delete-other-branches
#                                       # also delete every other branch/tag on origin
#
# Run it on the branch you want to keep (usually main), with no uncommitted changes.
# A full mirror backup is created next to the repo before anything is changed.
set -euo pipefail

APPLY=0; PUSH=0; DEL_OTHERS=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --push) PUSH=1 ;;
    --delete-other-branches) DEL_OTHERS=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 1 ;;
  esac
done
[ "$PUSH" -eq 1 ] && [ "$APPLY" -eq 0 ] && { echo "--push needs --apply" >&2; exit 1; }
[ "$DEL_OTHERS" -eq 1 ] && [ "$PUSH" -eq 0 ] && { echo "--delete-other-branches needs --push" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
BRANCH="$(git symbolic-ref --short HEAD)"
[ -z "$(git status --porcelain)" ] || { echo "Uncommitted changes present. Commit or stash first." >&2; exit 1; }

# Junk files that should never be kept (macOS/Windows leftovers, backups, temp files).
JUNK="$(git ls-files | grep -E '(^|/)(\._[^/]*|\.DS_Store|Thumbs\.db|[^/]*~|[^/]*\.(bak|orig|tmp|swp))$|(^|/)(_[a-z]*bak|bak|backup)/' || true)"

echo "Branch to keep:      $BRANCH"
echo "Commits in history:  $(git rev-list --count HEAD)"
echo "Current .git size:   $(du -sh .git | cut -f1)"
echo "Tracked files:       $(git ls-files | wc -l)"
echo "Junk files to drop:  $(printf '%s' "$JUNK" | grep -c . || true)"
[ -n "$JUNK" ] && printf '%s\n' "$JUNK" | sed 's/^/    - /'
if git remote get-url origin >/dev/null 2>&1; then
  echo "Other remote branches: $(git branch -r | grep -v "origin/$BRANCH$" | grep -v 'HEAD' | tr -d ' ' | tr '\n' ' ')"
fi

if [ "$APPLY" -ne 1 ]; then
  echo "-----"
  echo "Dry run only. Nothing changed. Add --apply to wipe the history."
  exit 0
fi

BACKUP="../$(basename "$PWD")-backup-$(date +%Y%m%d-%H%M%S).git"
echo "-----"
echo "Backup mirror -> $BACKUP"
git clone --mirror . "$BACKUP" >/dev/null 2>&1

[ -n "$JUNK" ] && printf '%s\n' "$JUNK" | xargs -d '\n' git rm -q -r -f --

TMP="reset-tmp-$$"
git checkout -q --orphan "$TMP"
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo repo-owner)}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo owner@example.com)}" \
    commit -q -m "Clean snapshot: current files only"
git branch -M "$TMP" "$BRANCH"
# drop old tags and every other local branch so nothing keeps the old history alive
git tag -l | xargs -r git tag -d >/dev/null
git for-each-ref --format='%(refname:short)' refs/heads | { grep -vx "$BRANCH" || true; } | xargs -r git branch -D >/dev/null
git reflog expire --expire=now --all
git gc --prune=now --aggressive -q
echo "Done locally. Commits: $(git rev-list --count HEAD)   .git size: $(du -sh .git | cut -f1)"

if [ "$PUSH" -eq 1 ]; then
  git push --force -u origin "$BRANCH"
  if [ "$DEL_OTHERS" -eq 1 ]; then
    git ls-remote --heads --tags origin | awk '{print $2}' | { grep -v "^refs/heads/$BRANCH$" || true; } | { grep -v '\^{}$' || true; } \
      | while read -r ref; do git push origin --delete "$ref" || true; done
  fi
  echo "Pushed. On other computers: delete the old clone and run git clone again."
else
  echo "Not pushed. To publish: git push --force -u origin $BRANCH"
fi
echo "Backup kept at: $BACKUP"
