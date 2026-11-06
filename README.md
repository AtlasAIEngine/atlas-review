# Atlas Review

Local-first AI code review for branches and pull requests, with a desktop app and MCP integration for coding agents.

[Windows x64](https://github.com/AtlasAIEngine/atlas-review/releases/latest/download/AtlasReview-windows-x64-setup.exe) | [Mac Apple Silicon](https://github.com/AtlasAIEngine/atlas-review/releases/latest/download/AtlasReview-macos-aarch64.dmg) | [Mac Intel](https://github.com/AtlasAIEngine/atlas-review/releases/latest/download/AtlasReview-macos-x86_64.zip) | [All releases](https://github.com/AtlasAIEngine/atlas-review/releases)

## What it does

- Review local branches and GitHub pull requests with configured AI providers.
- Explore findings, code diffs, and walkthroughs; track addressed and dismissed findings.
- Connect coding agents through the bundled Atlas Review MCP server.
- Keep local application state in SQLite. Hosted review sync is optional.

You provide your own AI provider access or supported authenticated CLI. GitHub features require your authorization. AI reviews can miss issues or produce incorrect findings; inspect recommendations before applying or publishing them.

## Install

Download the installer for your operating system above. Windows supports x64; Mac builds are available for Apple Silicon and Intel. The existing bundle and data-directory name remains `AtlasEngine` for upgrade compatibility, so the installed application may display that name.

Launch the app, configure a review provider in Settings, and import a local Git repository. Connect GitHub when you want to review or publish to pull requests. See each release for its code-signing status and SHA-256 checksums. Linux desktop packages are not part of the initial supported release matrix.

## Run from source

Install Git and Node.js 22 (see [.nvmrc](.nvmrc)), then:

```sh
git clone https://github.com/AtlasAIEngine/atlas-review.git
cd atlas-review
npm run setup
npm run dev
```

Open the URL printed by Vite (normally `http://127.0.0.1:5173`). The backend listens on localhost and uses SQLite. Docker, PostgreSQL, Redis, cloud accounts, and signing keys are not required for local review. Compiler tools may be required if native Node dependencies cannot use a prebuilt binary. The setup command installs dependencies from the included lockfiles and builds the MCP server.

Development shares the existing app data directory by default. To use an isolated profile, set `ATLAS_DATA_DIR` to an absolute writable directory before launching. Runtime configuration is in that profile's `.env`; never commit it. See [configuration](docs/CONFIGURATION.md).

## Build the desktop app

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), Rust, and the platform compiler tools. After `npm run setup`:

```sh
npm run desktop:build:unsigned
```

This creates a local installer without official updater signatures. It needs no maintainer credentials. `npm run desktop:dev` runs the native development app. Official releases use a separate signing workflow. Forks must supply their own update signing key and feed before distributing updates.

See the [supported model catalog](docs/MODELS.md) for current Codex and Claude choices.

## MCP integration

With the application running, preview detected agent setup:

```sh
node mcp-review-server/dist/bin/atlas-review-mcp.js setup --auto --dry-run
```

Apply setup by omitting `--dry-run`, then restart the agent. See the [MCP guide](mcp-review-server/README.md) for agent support and configuration. MCP can execute reviews and publish review actions when requested, so use it only with repositories you trust.

## Data and services

Application state and encrypted credentials live in your local profile. Review requests send selected repository content and context to your configured AI provider. GitHub operations contact GitHub, and official builds check GitHub for updates. Hosted review sync is disabled for new installations unless explicitly configured; existing saved settings are preserved. See [configuration and privacy](docs/CONFIGURATION.md).

The source retains shared builder/runtime modules to preserve the working application. Hosted deployment, billing, and dashboard services are outside the supported local review setup.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [release maintenance](docs/RELEASING.md). Licensed under [MIT](LICENSE); bundled dependencies retain their respective licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).
