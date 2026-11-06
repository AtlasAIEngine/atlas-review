# Atlas Review MCP Server

MCP server for Atlas review workflows across branch review and PR review scopes.

It exposes:
- Tools (`atlas_review_*`) for review execution, status, findings, outcomes, and config across `branch_review` and `pr_review`
- Prompts for triage and fix planning
- Resources (`atlas://review/current*`) for current review status and findings

## Quick Start (Recommended)

```bash
cd mcp-review-server
npm run build
node dist/bin/atlas-review-mcp.js setup --auto
```

Then restart your agent client.

## Prerequisites

- Atlas backend running (`http://127.0.0.1:3000/api` by default)
- Current repository imported in Atlas (or `ATLAS_AUTO_IMPORT=true`)
- At least one active review-capable provider configured in Atlas

## Setup CLI

Use the built-in setup command:

```bash
node dist/bin/atlas-review-mcp.js setup --help
```

Common commands:

```bash
# List supported agents + detection status
node dist/bin/atlas-review-mcp.js setup --list

# Auto-configure detected shipped agents
node dist/bin/atlas-review-mcp.js setup --auto

# Preview auto mode without writing
node dist/bin/atlas-review-mcp.js setup --auto --dry-run

# Configure one shipped agent
node dist/bin/atlas-review-mcp.js setup --agent=codex

# Emit generated snippet
node dist/bin/atlas-review-mcp.js setup --agent=claude-code --json

# Override backend URL or server name
node dist/bin/atlas-review-mcp.js setup --agent=claude-code --backend-url=http://127.0.0.1:3001/api --name=atlas-review-dev

# Interactive mode (choose agents manually)
node dist/bin/atlas-review-mcp.js setup
```

Verified support status, documented config paths, and deferred contracts live in [docs/setup-support-matrix.md](docs/setup-support-matrix.md).

Write behavior is the default for interactive, `--auto`, and shipped `--agent=<id>` flows. The only non-write execution modes are `--dry-run`, `--json`, and `--list`.

Atlas backend/settings MCP assist can apply the same shipped auto-write setup flow for Codex, Claude Code, Gemini CLI, Claude Desktop, and VS Code. For Codex and Claude Code, the same sync action also manages Atlas global workflow guidance. Manual-only agents such as Cursor remain snippet-only in Settings, the first-run setup wizard, and the CLI.

Atlas uses this workflow-guidance precedence model for supported agents:

- Atlas-managed global guidance is the default onboarding path
- repo-local `AGENTS.md` / `CLAUDE.md` guidance is a project-level override
- manual snippet copy is a break-glass fallback only when Atlas cannot safely manage the global files

Atlas Desktop also surfaces the same setup contract inside the first-run setup wizard so users can enable shipped integrations immediately and still copy exact command, path, and snippet guidance for manual-only agents before adding their first project.

## Build and Doctor

```bash
cd mcp-review-server
npm run build
npm run mcp:doctor
```

`mcp:doctor` checks:
- backend reachability
- CWD project resolution
- active review provider context

## Environment Variables

- `ATLAS_BACKEND_URL` (default: `http://localhost:3000/api`)
- `ATLAS_API_TOKEN` (optional bearer token)
- `ATLAS_AUTO_IMPORT` (default: `false`)
- `ATLAS_REQUEST_TIMEOUT_MS` (default: `120000`)
- `ATLAS_ENABLE_WATCHER_SYNC` (default: `false`)

## Verified Agent Support

Shipped v1 automatic setup is currently documented for:

- Codex
- Claude Code
- Gemini CLI
- Claude Desktop
- VS Code

Cursor remains available for manual snippet generation, and Atlas can detect the documented home/workspace paths plus the app-support user config used on macOS and Windows. Automatic writes stay provisional until Cursor's remaining path and reload assumptions are verified. See [docs/setup-support-matrix.md](docs/setup-support-matrix.md) for the evidence-backed matrix, deferred legacy paths, and source links.

## Managed Global Guidance

Atlas-managed global workflow guidance is currently shipped for:

- Codex via the canonical `atlas-review-global` skill
- Claude Code via the Atlas-managed block in `~/.claude/CLAUDE.md`

`setup --auto` and shipped single-agent `setup --agent=<id>` flows keep the MCP config and the managed global guidance in sync for those clients. Repo-local Agent Rules remain available when a repository needs behavior that differs from the global default.

## Manual Snippet Reference

Prefer generating the exact snippet and config path for your machine:

```bash
node dist/bin/atlas-review-mcp.js setup --agent=claude-code --json
```

Use the static examples below as a shape reference only.

Canonical server entry:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/mcp-review-server/dist/bin/atlas-review-mcp.js"],
  "env": { "ATLAS_BACKEND_URL": "http://127.0.0.1:3000/api" }
}
```

Codex TOML section:

```toml
[mcp_servers."atlas-review"]
command = "node"
args = ["/absolute/path/to/mcp-review-server/dist/bin/atlas-review-mcp.js"]

[mcp_servers."atlas-review".env]
ATLAS_BACKEND_URL = "http://127.0.0.1:3000/api"
```

## Prompt and Resource Names

- Prompts:
  - `review_current_branch`
  - `triage_high_risk_findings`
  - `prepare_fix_plan_from_findings`
- Resources:
  - `atlas://review/current`
  - `atlas://review/current/status`
  - `atlas://review/current/findings`

## Shared Review Target Model

The MCP surface keeps one shared review target model instead of separate branch-review and PR-review namespaces.

- Default behavior: current review resources and prompts try `branch_review` first.
- Safe fallback: if no branch review resolves, Atlas will use `pr_review` only when the current branch maps to exactly one PR review.
- Explicit PR targeting: pass `reviewType: "pr_review"` plus `prReviewId` or `githubPrNumber` to shared tools.
- Ambiguous PR context: Atlas returns a deterministic disambiguation error instead of guessing.

Supported review-target inputs on shared tools:

- `reviewType`: `branch_review` or `pr_review`
- `branchReviewId`
- `displayId`
- `prReviewId`
- `githubPrNumber`

PR review execution through `atlas_review_run_current` is queue-only. `mode: "immediate"` is rejected for PR scope with `INVALID_INPUT`.

## First Workflow

1. `atlas_review_status`
2. `atlas_review_latest`
3. `atlas_review_run_current`
4. Read `atlas://review/current`
5. Use `review_current_branch` prompt for either branch or PR review context

Explicit PR review example:

```json
{
  "reviewType": "pr_review",
  "githubPrNumber": 65
}
```

Ambiguous current-branch fallback example:

- If two PR reviews share the current branch head, shared tools and `atlas://review/current*` fail closed.
- Resolve that ambiguity with `prReviewId` or `githubPrNumber` instead of relying on cwd fallback.

## Troubleshooting

- Start with [docs/troubleshooting.md](docs/troubleshooting.md) for malformed config, missing build output, permission failures, and unsupported-agent guidance.
- Atlas Settings > MCP and the desktop first-run wizard reuse the same guidance contract, so command, docs, restart hint, and snippet output should match the CLI.
- Run `npm run mcp:doctor` first.
- If build is missing: `cd mcp-review-server && npm run build`.
- If backend fails: validate `curl -sS http://127.0.0.1:3000/health`.
- If project resolution fails: run from git repo root or set `ATLAS_AUTO_IMPORT=true`.
- If provider check fails: set an active review provider in Atlas settings.

## Verification Checklist

```bash
cd mcp-review-server
npm run build
npm run verify:setup-docs
```

Expected outcomes:
- `setup --list` reports supported agents, support status, and the target config path.
- `setup --auto --dry-run` reports config path, backup status, changed status, and restart hints without mutating files.

## Rollout Runbook

Go/no-go:
- Go only if `npm run verify:setup-docs` passes and Settings > MCP plus the desktop first-run setup wizard show the same shipped-agent write contract, command/path/docs guidance, and manual-snippet fallback as the CLI.
- No-go if the MCP build is missing, a supported agent shows malformed config without a clear remediation, or any manual-snippet-only agent appears as an Atlas-managed auto-write target.

Rollback:
1. Keep the CLI as the source of truth and stop relying on shipped-agent auto-setup in Settings or the wizard until the mismatch is fixed.
2. Rebuild the MCP server: `cd mcp-review-server && npm run build`.
3. Re-run `npm run verify:setup-docs`.
4. If the issue persists, use `setup --list`, `setup --auto --dry-run`, and per-agent `--json` snippet generation while the UI assist is being repaired.
