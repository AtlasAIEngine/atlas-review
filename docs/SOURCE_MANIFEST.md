# Public source inventory

The initial source is a curated export of AtlasAIEngine/AtlasEngineMVPClaude main at `7889e0ad86e5b9a27eab17cdb31bdb1894c9b96d`. Previous Git history is not included.

| Path | Purpose |
| --- | --- |
| frontend | Review interface and shared application UI |
| backend | Local review services, SQLite persistence, shared runtime, and synthetic tests |
| apps/desktop | Tauri shell, platform hooks, icons, and packaging scripts |
| mcp-review-server | MCP integration, agent setup, and tests |
| shared | Shared runtime helpers |
| templates | Runtime templates referenced by retained application modules |
| scripts | Local setup, verification, packaging, and release tooling |
| .github | Contributor checks and release automation |
| docs | Public configuration, release, and source inventory documentation |

Excluded: old history, internal planning, private real-repository benchmark corpus, machine configuration, local projects/data, build output, cloud backend, dashboard, and the old docs site's screenshots. Synthetic fixtures remain; private repository names and developer paths in retained examples have been generalized. Shared builder modules remain to avoid breaking the verified runtime during publication.

Launch changes include optional hosted sync, reproducible dependency installation, fail-closed MCP bundling, contributor builds without signing keys, and repository-local release publication. Existing application identifiers and storage paths are preserved.
