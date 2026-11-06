# MCP Setup Troubleshooting

Use this guide when `atlas-review-mcp setup` does not complete cleanly.

## First Checks

```bash
cd mcp-review-server
npm run build
npm run mcp:doctor
node dist/bin/atlas-review-mcp.js setup --list
node dist/bin/atlas-review-mcp.js setup --auto --dry-run
```

These commands verify:
- the compiled MCP binary exists
- Atlas backend connectivity works
- the current repository can be resolved
- the detected agent configs and target paths match what you expect

Atlas Settings > MCP and the desktop first-run wizard should show the same support labels, docs links, commands, and snippet output as these CLI checks.

For Codex and Claude Code, Atlas-managed global guidance is part of the same default setup flow as MCP registration. Repo-local `AGENTS.md` / `CLAUDE.md` guidance should be treated as project-level overrides rather than the default onboarding path.

## Malformed Config Files

Symptoms:
- `contains invalid JSON`
- `contains malformed TOML`
- `expected an object wrapper for MCP entries`

Behavior:
- setup fails closed
- the existing config file is left untouched
- no partial rewrite is attempted

Recovery:
1. Open the reported config path.
2. Fix the malformed syntax or move the file aside manually.
3. Re-run `setup --list` to confirm the target path.
4. Re-run `setup --auto --dry-run` before the write command.

## Missing Binary Or Build Output

Symptoms:
- `Build mcp-review-server first`
- `Setup module not found`

Recovery:

```bash
cd mcp-review-server
npm run build
node dist/bin/atlas-review-mcp.js setup --list
```

## Permission Failures

Symptoms:
- `Failed to prepare config directory`
- `Failed to create backup`
- `Failed to replace config file`

Behavior:
- Atlas creates a backup before replacing an existing config
- backup or rename failures abort the write instead of leaving a partial config behind

Recovery:
1. Check write permissions for the reported directory.
2. Confirm the parent directory exists and is writable.
3. Retry with `--dry-run` first if you want to confirm the target path without writing.

## Unsupported Or Deferred Agents

Symptoms:
- `Unsupported agent`
- `not in the shipped v1 auto-write path`

Recovery:
1. Run `setup --list` to inspect the current support status.
2. For `experimental` or `deferred` agents, generate a snippet only:

```bash
node dist/bin/atlas-review-mcp.js setup --agent=cursor --json
```

3. Apply the snippet manually after reviewing the target path and the client's current documentation.

Rollback guidance:
- Keep using CLI-first verification only (`setup --list`, `setup --auto --dry-run`, and per-agent `--json`) until the UI assist and the CLI output match again.
- Settings > MCP and the first-run wizard should never be treated as a write path in v1.

## Managed Global Guidance Conflicts

Symptoms:
- `Refusing to overwrite a non-Atlas skill`
- `Found an incomplete Atlas-managed Claude guidance block`
- Settings > MCP shows `Workflow guidance: Manual cleanup required`

Behavior:
- Atlas does not overwrite non-Atlas global skills or partial managed Claude blocks
- MCP config and workflow-guidance files are treated separately
- repo-local Agent Rules can still be used as a temporary project-level override while the global files are repaired

Recovery:
1. Inspect the reported workflow-guidance path from Settings > MCP or `setup --list`.
2. Remove or repair the conflicting global file manually.
3. Re-run `setup --agent=codex`, `setup --agent=claude-code`, or `setup --auto`.
4. Confirm the workflow guidance state returns to `Managed global default active`.

## Verification After A Successful Write

Run the client-specific verification command or restart step from the setup output. Then re-run:

```bash
node dist/bin/atlas-review-mcp.js setup --list
```

Expected result:
- the target agent shows as `configured`
- the config path matches the file you intended to update
- Settings > MCP and the first-run wizard should now mirror the same command, docs link, restart hint, and snippet output.
