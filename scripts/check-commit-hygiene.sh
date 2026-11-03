#!/bin/sh
# usage: scripts/check-commit-hygiene.sh <base-ref>
set -eu
base="${1:?base ref required}"
range="$base..HEAD"
fail=0
if git log --format='%an <%ae>%n%cn <%ce>%n%B' "$range" | \
   grep -Eiq 'co-authored-by|generated with|noreply@anthropic\.com|claude|anthropic'; then
  echo "Attribution found in commit messages or author metadata" >&2; fail=1
fi
git log --format='%s' "$range" | while IFS= read -r s; do
  printf '%s' "$s" | grep -Eq '^(feat|fix|docs|test|refactor|perf|build|ci|chore)(\([a-z0-9-]+\))?!?: .{3,}$' \
    || { echo "Bad subject: $s" >&2; exit 1; }
done || fail=1
if git ls-files | grep -Eq '(^|/)(CLAUDE(\.local)?\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|\.claude/|\.cursor/)'; then
  echo "Assistant config file is tracked" >&2; fail=1
fi
exit "$fail"
