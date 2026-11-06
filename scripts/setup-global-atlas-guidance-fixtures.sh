#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

dry_run=0

usage() {
  cat <<'EOF'
Usage: setup-global-atlas-guidance-fixtures.sh [--dry-run]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unexpected argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

ensure_ref() {
  local ref="$1"
  git rev-parse --verify --quiet "$ref" >/dev/null || {
    printf 'Missing required ref: %s\n' "$ref" >&2
    exit 1
  }
}

create_or_update_branch() {
  local branch="$1"
  local source_ref="$2"

  ensure_ref "$source_ref"
  if [ "$dry_run" -eq 1 ]; then
    printf '[DRY RUN] Would prepare %s -> %s (%s)\n' "$branch" "$source_ref" "$(git rev-parse "$source_ref")"
    return 0
  fi
  git branch -f "$branch" "$source_ref" >/dev/null
  printf 'Prepared %s -> %s (%s)\n' "$branch" "$source_ref" "$(git rev-parse "$branch")"
}

prepare_unrelated_repo() {
  local unrelated_repo="/tmp/example-developer/Projects/AI/atlas-guidance-unrelated-repo"

  if [ "$dry_run" -eq 1 ]; then
    printf '[DRY RUN] Would prepare fixture-unrelated-repo at %s\n' "$unrelated_repo"
    return 0
  fi

  mkdir -p "$unrelated_repo"
  if [ ! -d "$unrelated_repo/.git" ]; then
    git init "$unrelated_repo" >/dev/null
  fi

  if [ ! -f "$unrelated_repo/README.md" ]; then
    cat >"$unrelated_repo/README.md" <<'EOF'
# Atlas Guidance Unrelated Repo Fixture

This repository exists only as a negative-control fixture for global Atlas guidance tests.
EOF
  fi

  (
    cd "$unrelated_repo"
    if ! git rev-parse --verify --quiet HEAD >/dev/null; then
      git add README.md
      git -c user.name='Atlas Fixture' -c user.email='atlas-fixture@example.com' commit -m 'Initialize unrelated fixture repo' >/dev/null
    fi
  )

  printf 'Prepared fixture-unrelated-repo at %s\n' "$unrelated_repo"
}

create_or_update_branch "fixture-review-branch" "feature/ReviewImprovements_Part_1"
create_or_update_branch "fixture-fix-loop-branch" "feature/verify-tab-ux"
create_or_update_branch "fixture-non-review-branch" "main"
prepare_unrelated_repo
