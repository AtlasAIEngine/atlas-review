# MCP Setup Support Matrix

This matrix records the config contracts verified against primary client documentation as of March 7, 2026. Anything not backed by the sources below is not part of the shipped v1 write contract.

## Status Definitions

- `shipped`: the config path, wrapper key, merge target, and restart or refresh flow are documented strongly enough for Atlas to write automatically in v1.
- `experimental`: the agent supports MCP, but Atlas should treat automatic writes as provisional because at least one required contract detail is inferred or only partially documented.
- `deferred`: the current Atlas implementation previously assumed this contract, but it is not verified well enough to ship in the v1 write path.

## Verified Agent Contracts

| Agent | Status | Verified config path(s) | Wrapper / merge target | Restart or refresh flow | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude Code | shipped | `~/.claude.json` for user scope, `.mcp.json` for project scope | `mcpServers["atlas-review"]` | No full app restart is required for normal MCP capability refresh; Claude Code supports dynamic `list_changed` updates and `/mcp` status inspection. | Atlas also manages a workflow-guidance block in `~/.claude/CLAUDE.md` during setup sync. Primary source documents the MCP scopes and wrapper. |
| Claude Code global guidance | shipped | `~/.claude/CLAUDE.md` | Atlas-managed `<!-- atlas-review-global:* -->` block | Refresh Claude Code after setup sync or `setup --agent=claude-code`; incomplete managed blocks are reported as manual-cleanup states. | This is the default workflow-guidance path for Claude Code. Repo-local `CLAUDE.md` remains the project-level override path. |
| Claude Desktop | shipped | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\\Claude\\claude_desktop_config.json` | `mcpServers["atlas-review"]` | Save the file and restart Claude Desktop. | Verified for local stdio-style MCP setup. Anthropic's remote connector flow now prefers in-app Settings > Connectors instead of direct file edits for remote servers. |
| Codex | shipped | `~/.codex/config.toml` | `[mcp_servers."atlas-review"]` | Run `codex mcp list` to verify; restart the active Codex CLI, IDE extension, or app session to pick up new local config reliably. | OpenAI documents shared MCP configuration between CLI and IDE extension. |
| Codex global guidance | shipped | `~/.codex/skills/atlas-review-global/SKILL.md` | Managed Atlas global skill | Restart the active Codex session after setup sync or `setup --agent=codex`; conflicting non-Atlas skills are reported as manual-cleanup states. | This is the default workflow-guidance path for Codex. Repo-local `AGENTS.md` remains the project-level override path. |
| OpenCode | shipped | `~/.config/opencode/opencode.json` | `mcp["atlas-review"]` | Restart the active OpenCode session after setup sync or `setup --agent=opencode`; use `opencode debug config` to verify the merged config if needed. | Atlas writes a documented local MCP entry with `type: "local"`, `command`, `environment`, and `enabled`. |
| OpenCode global guidance | shipped | `~/.config/opencode/skills/atlas-review-global/SKILL.md` | Managed Atlas global skill | Restart the active OpenCode session after setup sync or `setup --agent=opencode`; conflicting non-Atlas skills are reported as manual-cleanup states. | This is the default workflow-guidance path for OpenCode. Repo-local `AGENTS.md` remains the project-level override path. |
| Gemini CLI | shipped | `~/.gemini/settings.json` | `mcpServers["atlas-review"]` | Restart the active Gemini CLI session after setup. | Atlas ships Gemini in the same auto-write MCP flow as the other documented clients. |
| VS Code | shipped | User profile `mcp.json` and workspace `.vscode/mcp.json` | `servers["atlas-review"]` | VS Code restarts MCP servers when config changes are detected; manual management is also available from MCP commands and the `mcp.json` editor. | The `chat.mcp.autoStart` setting controlling automatic restart is documented as experimental, but the config contract itself is documented and shipped. |
| Cursor | experimental | macOS: `~/Library/Application Support/Cursor/User/mcp.json`; Windows: `%APPDATA%\\Cursor\\User\\mcp.json`; documented fallbacks: `~/.cursor/mcp.json` and `.cursor/mcp.json` | `mcpServers["atlas-review"]` | Tools can be toggled from Cursor settings or chat, but the exact file-change reload behavior is not documented clearly enough to promise automatic-write ergonomics. | Atlas detects the app-support user config in addition to the documented home/workspace fallbacks, but automatic writes remain manual-only while Cursor stays experimental. |

## Deferred Contracts Removed From v1 Write Scope

| Contract | Status | Why it is out of scope |
| --- | --- | --- |
| Claude Code `~/.claude/mcp.json` legacy path | deferred | Current Anthropic docs point to `~/.claude.json` and `.mcp.json`; the nested legacy path is not documented as a supported v1 target. |

## Source Notes

- Claude Code MCP docs: <https://code.claude.com/docs/en/mcp>
  - Documents `.mcp.json`, `~/.claude.json`, `mcpServers`, scope behavior, `/mcp`, and dynamic capability refresh.
- Claude Desktop local MCP setup: <https://modelcontextprotocol.io/docs/develop/connect-local-servers>
  - Documents `claude_desktop_config.json`, `mcpServers`, and restart-after-save flow.
- Claude Desktop remote connector guidance: <https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers>
  - Documents that remote servers should be added via Settings > Connectors, not by direct `claude_desktop_config.json` edits.
- Codex Docs MCP guide: <https://developers.openai.com/resources/docs-mcp>
  - Documents shared Codex MCP config, `codex mcp add`, `codex mcp list`, and direct `~/.codex/config.toml` editing.
- OpenCode config docs: <https://opencode.ai/docs/config/>
  - Documents the global config path `~/.config/opencode/opencode.json`, merge precedence, plural `skills/` directory naming, and `mcp` config key.
- OpenCode MCP docs: <https://opencode.ai/docs/mcp-servers/>
  - Documents `mcp.<name>.type = "local"`, array `command`, `environment`, and `enabled` for local servers.
- OpenCode Agent Skills docs: <https://opencode.ai/docs/skills>
  - Documents the canonical global skill path `~/.config/opencode/skills/<name>/SKILL.md` and the required YAML frontmatter fields.
- Gemini CLI docs: <https://github.com/google-gemini/gemini-cli>
  - Atlas ships the `~/.gemini/settings.json` MCP path used by the current Gemini CLI integration.
- VS Code MCP docs: <https://code.visualstudio.com/docs/copilot/customization/mcp-servers>
  - Documents user/workspace `mcp.json`, `servers`, and MCP server restart behavior on config changes.
- Cursor MCP docs: <https://docs.cursor.com/context/model-context-protocol>
  - Documents `mcpServers`, `~/.cursor/mcp.json`, and `.cursor/mcp.json`.
