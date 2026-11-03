#!/bin/sh
# Copy the hook sources in scripts/git-hooks into this clone's hooks directory.
# Hooks are local to each clone and are not installed by cloning, so run this once per clone.
# It does not change git config; an existing hook that differs is left alone and reported.
set -eu

root=$(git rev-parse --show-toplevel)
hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks)
mkdir -p "$hooks_dir"

status=0
for hook in pre-commit commit-msg pre-push; do
  src="$root/scripts/git-hooks/$hook"
  dest="$hooks_dir/$hook"
  if [ -e "$dest" ] && ! cmp -s "$src" "$dest"; then
    echo "skipped $hook: $dest already exists and differs; remove or merge it, then rerun" >&2
    status=1
    continue
  fi
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "installed $dest"
done
exit "$status"
