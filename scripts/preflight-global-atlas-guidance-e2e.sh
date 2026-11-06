#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

expected_review_sha="0f1f149857dd62e0fa6a12506994436168444280"
expected_fix_loop_sha="536917ad086b68766f81121092a16f580471ee72"
expected_non_review_sha="0943f768962f4d22e1f5bfec8cafdac6a21a867d"
unrelated_repo="/tmp/example-developer/Projects/AI/atlas-guidance-unrelated-repo"
codex_home="${CODEX_HOME:-$HOME/.codex}"
codex_skill_path="$codex_home/skills/atlas-review-global/SKILL.md"
claude_guidance_path="$HOME/.claude/CLAUDE.md"

status_ok() {
  printf '[OK] %s\n' "$1"
}

status_warn() {
  printf '[WARN] %s\n' "$1"
}

status_fail() {
  printf '[FAIL] %s\n' "$1" >&2
}

check_ref() {
  local ref="$1"
  local expected_sha="$2"
  local actual_sha

  if ! actual_sha="$(git rev-parse --verify --quiet "$ref" 2>/dev/null)"; then
    status_fail "Missing fixture ref: $ref"
    return 1
  fi

  if [ "$actual_sha" = "$expected_sha" ]; then
    status_ok "$ref -> $actual_sha"
  else
    status_warn "$ref -> $actual_sha (manifest expected $expected_sha)"
  fi
}

check_marker() {
  local file_path="$1"
  local marker="$2"
  local label="$3"

  if [ ! -f "$file_path" ]; then
    status_warn "$label missing at $file_path"
    return 0
  fi

  if rg -q --fixed-strings "$marker" "$file_path"; then
    status_ok "$label present in $file_path"
  else
    status_warn "$label not found in $file_path"
  fi
}

check_any_marker() {
  local file_path="$1"
  local label="$2"
  shift 2

  if [ ! -f "$file_path" ]; then
    status_warn "$label missing at $file_path"
    return 0
  fi

  for marker in "$@"; do
    if rg -q --fixed-strings "$marker" "$file_path"; then
      status_ok "$label present in $file_path"
      return 0
    fi
  done

  status_warn "$label not found in $file_path"
}

printf 'Global Atlas Guidance E2E preflight\n'
printf 'Repo root: %s\n\n' "$repo_root"

check_ref "fixture-review-branch" "$expected_review_sha"
check_ref "fixture-fix-loop-branch" "$expected_fix_loop_sha"
check_ref "fixture-non-review-branch" "$expected_non_review_sha"

if [ -d "$unrelated_repo/.git" ] && git -C "$unrelated_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  status_ok "fixture-unrelated-repo ready at $unrelated_repo"
else
  status_fail "fixture-unrelated-repo missing or not a git repo at $unrelated_repo"
  exit 1
fi

printf '\nRepo-local baseline markers\n'
check_marker "$repo_root/AGENTS.md" '<!-- atlas-review-mcp:start -->' 'AGENTS Atlas block'
check_any_marker "$repo_root/CLAUDE.md" 'CLAUDE Atlas block' '<!-- atlas-review-mcp:start -->' '## Atlas Review (MCP)'

printf '\nGlobal managed guidance state\n'
if [ -f "$codex_skill_path" ] && rg -q 'name: atlas-review-global' "$codex_skill_path" && rg -q 'Atlas Review Global Guidance' "$codex_skill_path"; then
  status_ok "Codex managed global guidance installed at $codex_skill_path"
else
  status_warn "Codex managed global guidance not detected at $codex_skill_path"
fi

if [ -f "$claude_guidance_path" ] && rg -q '<!-- atlas-review-global:start -->' "$claude_guidance_path" && rg -q '<!-- atlas-review-global:end -->' "$claude_guidance_path"; then
  status_ok "Claude managed global guidance installed at $claude_guidance_path"
else
  status_warn "Claude managed global guidance not detected at $claude_guidance_path"
fi

printf '\nPreflight complete.\n'
