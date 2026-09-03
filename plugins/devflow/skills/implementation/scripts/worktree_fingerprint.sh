#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  printf 'usage: %s <repo>\n' "$0" >&2
  exit 2
fi

repo_root="$(git -C "$1" rev-parse --show-toplevel)"
fingerprint_dir="$(mktemp -d "${TMPDIR:-/tmp}/devflow-implementation-fingerprint.XXXXXX")"
cleanup() {
  rm -rf -- "$fingerprint_dir"
}
trap cleanup EXIT

tracked_diff="$fingerprint_dir/tracked.diff"
manifest="$fingerprint_dir/manifest"
git -C "$repo_root" diff --binary HEAD -- . >"$tracked_diff"

{
  printf 'head\0%s\0' "$(git -C "$repo_root" rev-parse HEAD)"
  printf 'tracked\0%s\0' "$(git -C "$repo_root" hash-object "$tracked_diff")"
} >"$manifest"

while IFS= read -r -d '' path; do
  full_path="$repo_root/$path"
  mode=100644
  if [[ -L "$full_path" ]]; then
    target="$(readlink "$full_path")"
    file_hash="$(printf '%s' "$target" | git -C "$repo_root" hash-object --stdin)"
    mode=120000
  elif [[ -d "$full_path" ]]; then
    printf 'untracked directory entry is not supported: %s\n' "$path" >&2
    exit 1
  else
    file_hash="$(git -C "$repo_root" hash-object -- "$path")"
    if [[ -x "$full_path" ]]; then
      mode=100755
    fi
  fi
  printf 'untracked\0%s\0%s\0%s\0' "$path" "$mode" "$file_hash" >>"$manifest"
done < <(git -C "$repo_root" ls-files --others --exclude-standard -z)

git -C "$repo_root" hash-object "$manifest"
