#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

template_path="$repo_root/.planning/future/GLOBAL_ATLAS_GUIDANCE_RUN_MATRIX_TEMPLATE.csv"
output_dir="$repo_root/.planning/future/runs"
timestamp="$(date '+%Y%m%d-%H%M%S')"
repo_path="$repo_root"
unrelated_repo="/tmp/example-developer/Projects/AI/atlas-guidance-unrelated-repo"
dry_run=0
output_path=""

usage() {
  cat <<'EOF'
Usage: bootstrap-global-atlas-guidance-run-matrix.sh [--dry-run] [--output PATH]

Options:
  --dry-run      Print the output path and seeded row count without writing a file
  --output PATH  Write the seeded matrix to PATH instead of the default timestamped path
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --output)
      output_path="${2:-}"
      if [ -z "$output_path" ]; then
        printf 'Missing value for --output\n' >&2
        exit 1
      fi
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ -n "$output_path" ]; then
        printf 'Unexpected argument: %s\n' "$1" >&2
        exit 1
      fi
      output_path="$1"
      shift
      ;;
  esac
done

output_path="${output_path:-$output_dir/global-atlas-guidance-run-matrix-$timestamp.csv}"

mkdir -p "$(dirname "$output_path")"

fixture_branch() {
  case "$1" in
    fixture-review-branch) printf 'fixture-review-branch' ;;
    fixture-fix-loop-branch) printf 'fixture-fix-loop-branch' ;;
    fixture-non-review-branch) printf 'fixture-non-review-branch' ;;
    fixture-unrelated-repo) printf '%s' "$(git -C "$unrelated_repo" rev-parse --abbrev-ref HEAD)" ;;
    *) return 1 ;;
  esac
}

fixture_sha() {
  case "$1" in
    fixture-review-branch) git rev-parse fixture-review-branch ;;
    fixture-fix-loop-branch) git rev-parse fixture-fix-loop-branch ;;
    fixture-non-review-branch) git rev-parse fixture-non-review-branch ;;
    fixture-unrelated-repo) git -C "$unrelated_repo" rev-parse HEAD ;;
    *) return 1 ;;
  esac
}

fixture_path() {
  case "$1" in
    fixture-unrelated-repo) printf '%s' "$unrelated_repo" ;;
    *) printf '%s' "$repo_path" ;;
  esac
}

prompt_for_suite() {
  case "$1" in
    A) printf 'Use atlas review to find issues in this branch' ;;
    B) printf 'Run atlas review, fix the findings, and persist outcomes' ;;
    C) printf 'Review this branch with atlas' ;;
    D) printf 'Find issues in this branch' ;;
    E) printf 'Add a button to settings' ;;
    F) printf 'Use atlas review to find issues in this branch' ;;
    *) return 1 ;;
  esac
}

fixture_for_suite() {
  case "$1" in
    A|C|D|F) printf 'fixture-review-branch' ;;
    B) printf 'fixture-fix-loop-branch' ;;
    E) printf 'fixture-non-review-branch' ;;
    *) return 1 ;;
  esac
}

sample_count_for_suite() {
  case "$1" in
    A|C|D|E) printf '20' ;;
    B|F) printf '10' ;;
    *) return 1 ;;
  esac
}

guidance_for_environment() {
  case "$1" in
    E1) printf 'repo_local' ;;
    E2) printf 'none' ;;
    E3) printf 'codex_global_skill' ;;
    E4) printf 'claude_global_guidance' ;;
    E5) printf 'global_plus_repo_local_override' ;;
    E6) printf 'degraded' ;;
    *) return 1 ;;
  esac
}

repo_local_for_environment() {
  case "$1" in
    E1|E5) printf 'yes' ;;
    E2|E3|E4|E6) printf 'no' ;;
    *) return 1 ;;
  esac
}

atlas_available_for_environment() {
  case "$1" in
    E6) printf 'degraded' ;;
    *) printf 'yes' ;;
  esac
}

append_seed_row() {
  local run_id="$1"
  local agent="$2"
  local environment="$3"
  local suite="$4"
  local fixture_name="$5"
  local prompt="$6"
  local fixture_branch_name
  local fixture_commit_sha
  local fixture_repo_path

  fixture_branch_name="$(fixture_branch "$fixture_name")"
  fixture_commit_sha="$(fixture_sha "$fixture_name")"
  fixture_repo_path="$(fixture_path "$fixture_name")"

  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"%s",%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"%s"\n' \
    "$run_id" \
    "" \
    "$agent" \
    "" \
    "" \
    "" \
    "$environment" \
    "$fixture_name" \
    "$fixture_repo_path" \
    "$fixture_branch_name" \
    "$fixture_commit_sha" \
    "$suite" \
    "$prompt" \
    "$(atlas_available_for_environment "$environment")" \
    "$(guidance_for_environment "$environment")" \
    "$(repo_local_for_environment "$environment")" \
    "" "" "" "" "" "" "" "" \
    ""
}

row_count=0

write_row() {
  if [ "$dry_run" -eq 0 ]; then
    printf '%s\n' "$1" >>"$output_path"
  fi
  row_count=$((row_count + 1))
}

if [ "$dry_run" -eq 0 ]; then
  mkdir -p "$(dirname "$output_path")"
  cp "$template_path" "$output_path"
fi

run_counter=1
for environment in E1 E2 E3 E5 E6; do
  for suite in A B C D E F; do
    fixture_name="$(fixture_for_suite "$suite")"
    sample_count="$(sample_count_for_suite "$suite")"
    for _ in $(seq 1 "$sample_count"); do
      row="$(append_seed_row "$(printf 'seed-%03d' "$run_counter")" "codex" "$environment" "$suite" "$fixture_name" "$(prompt_for_suite "$suite")")"
      write_row "$row"
      run_counter=$((run_counter + 1))
    done
  done
done

for environment in E1 E2 E4 E5 E6; do
  for suite in A B C D E F; do
    fixture_name="$(fixture_for_suite "$suite")"
    sample_count="$(sample_count_for_suite "$suite")"
    for _ in $(seq 1 "$sample_count"); do
      row="$(append_seed_row "$(printf 'seed-%03d' "$run_counter")" "claude-code" "$environment" "$suite" "$fixture_name" "$(prompt_for_suite "$suite")")"
      write_row "$row"
      run_counter=$((run_counter + 1))
    done
  done
done

row="$(append_seed_row "$(printf 'seed-%03d' "$run_counter")" "codex" "E3" "D" "fixture-unrelated-repo" "Find issues in this branch")"
write_row "$row"
run_counter=$((run_counter + 1))
row="$(append_seed_row "$(printf 'seed-%03d' "$run_counter")" "claude-code" "E4" "D" "fixture-unrelated-repo" "Find issues in this branch")"
write_row "$row"

if [ "$dry_run" -eq 1 ]; then
  printf 'Dry run: would seed %s rows into %s\n' "$row_count" "$output_path"
else
  printf 'Seeded run matrix: %s (%s rows)\n' "$output_path" "$row_count"
fi
