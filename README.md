<div align="center">

# Atlas Review

**Understand the change. Find the risk. Review with context.**

Local-first AI code review with guided code walkthroughs, an organized PR inbox, and MCP integration for your coding agent.

[Install](#install) · [Walkthroughs](#understand-the-change-with-code-walkthroughs) · [Pull requests](#organize-your-pull-requests) · [Agent integration](#review-with-your-coding-agent) · [Contribute](#contribute) · [YouTube](https://www.youtube.com/@LoomtideAI)

[![Checks](https://github.com/Loomtide/atlas-review/actions/workflows/checks.yml/badge.svg)](https://github.com/Loomtide/atlas-review/actions/workflows/checks.yml)
[![Release](https://img.shields.io/github/v/release/Loomtide/atlas-review)](https://github.com/Loomtide/atlas-review/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<a href="https://youtu.be/FYymR-1wp4w"><img src="docs/assets/readme/product-demo.png" alt="Atlas displays inline review findings while Claude Code uses Atlas MCP to investigate and fix them. Watch the product demo." width="880" /></a>

**[Watch the 19-second demo](https://youtu.be/FYymR-1wp4w)** · [View the MP4](docs/assets/readme/product-demo.mp4)

</div>

## Install

| Platform | Download |
| --- | --- |
| macOS, Apple Silicon | [Download DMG](https://github.com/Loomtide/atlas-review/releases/latest/download/AtlasReview-macos-aarch64.dmg) |
| macOS, Intel | [Download ZIP](https://github.com/Loomtide/atlas-review/releases/latest/download/AtlasReview-macos-x86_64.zip) |
| Windows, x64 | [Download installer](https://github.com/Loomtide/atlas-review/releases/latest/download/AtlasReview-windows-x64-setup.exe) |

1. Install and open Atlas Review.
2. Configure your AI provider or supported authenticated CLI in **Settings**.
3. Import a local Git repository and review a branch. Connect GitHub to bring in pull requests.

The installed app retains the **AtlasEngine** name and data paths for upgrade compatibility. Mac builds are signed and notarized. Windows installers do not currently have an Authenticode certificate and may show a SmartScreen prompt. Linux desktop packages are not currently published. See [release notes and checksums](https://github.com/Loomtide/atlas-review/releases/latest).

## Understand the change with code walkthroughs

A file list tells you what changed. A walkthrough helps you understand how the pieces fit together.

Atlas groups changes into logical steps, explains each step, and puts the relevant code diff beside it. Follow the change in a meaningful order, inspect the implementation, and mark steps as read as you go. Walkthroughs are available for branch and pull request reviews.

![Code walkthrough with seven logical steps, an explanation of the selected change, and its grouped files and inline diff](docs/assets/readme/walkthrough.png)

## Organize your pull requests

Keep your own PRs, other people's changes, and recently completed work in one Kanban view. Search by PR number, title, or author, and see change sizes and review status before opening a review.

![Pull request board with Your PRs, Others' PRs, and Recently completed columns, plus change sizes and review status](docs/assets/readme/pull-requests.png)

## Review large PRs without losing your place

Large changes need both a responsive diff viewer and a way to make sense of the work. Atlas renders the file feed progressively as you scroll, keeping navigation responsive without rendering every expanded diff at once.

Use file filters to narrow the scope, switch between unified and split diffs, or follow the walkthrough one logical step at a time. Jump from a finding to the relevant code instead of searching through the whole PR.

## Take the review through to a decision

Read inline findings, ask Atlas about a change, and draft replies with the diff and GitHub conversation in view. Track findings as addressed or dismissed, then choose which comments to publish to GitHub.

![Review chat beside a scoped code diff and GitHub conversation, with a draft reply ready for inspection](docs/assets/readme/review-chat.png)

[Watch the PR review clip on YouTube](https://youtu.be/kFwrdiDfIzU)

## Review your branch before opening a PR

Run a review against a local branch before pushing to GitHub. Inspect findings and walkthroughs while the code is still fresh, fix issues, and review the updated branch from the same application.

[Watch the 9-second branch review demo on YouTube](https://youtu.be/9h1fay9hpSk)

## Review with your coding agent

The bundled MCP server lets your agent run reviews, read findings, and record outcomes from its own workflow. For example:

> Use Atlas to review this branch. Investigate the high-risk findings, fix the confirmed issues, and record the outcomes after verification.

Configure integrations through the app's first-run setup or **Settings > MCP**. Automatic setup is available for Codex, Claude Code, Gemini CLI, Claude Desktop, and VS Code. Cursor uses manual configuration. Restart your agent after setup.

For source installations, preview detected agent setup with the app running:

```sh
node mcp-review-server/dist/bin/atlas-review-mcp.js setup --auto --dry-run
```

Omit `--dry-run` to apply setup. See the [MCP guide](mcp-review-server/README.md) and [agent support matrix](mcp-review-server/docs/setup-support-matrix.md).

## Your providers, your local workspace

Bring your own provider access or supported authenticated CLI. See the [model catalog](docs/MODELS.md) for Codex and Claude choices. Availability and usage charges depend on your provider and account.

- Application state and encrypted credentials are stored in your local profile using SQLite.
- Review requests send selected repository content and context to your configured AI provider.
- GitHub features contact GitHub; official builds also check GitHub for updates.
- Hosted review sync is optional and disabled for new installations unless configured.

See [configuration and privacy](docs/CONFIGURATION.md). AI findings can be incorrect or miss issues; inspect recommendations before applying fixes or publishing a review.

## Run from source

Install Git and [Node.js 22](.nvmrc), then:

```sh
git clone https://github.com/Loomtide/atlas-review.git
cd atlas-review
npm run setup
npm run dev
```

Open the URL printed by Vite, normally `http://127.0.0.1:5173`, and choose **Open App** on your first visit. Setup installs locked dependencies and builds the MCP server. Local review uses SQLite and requires no Docker, PostgreSQL, Redis, cloud account, or signing key. Native dependencies may require compiler tools.

Development shares the existing app data directory by default. Set `ATLAS_DATA_DIR` to an absolute writable directory to use an isolated profile. Keep the profile's `.env` out of Git. See [configuration](docs/CONFIGURATION.md).

<details>
<summary><strong>Build a desktop installer</strong></summary>

Install Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). After `npm run setup`:

```sh
npm run desktop:build:unsigned
```

This creates a local installer without official updater signatures and needs no maintainer credentials. Use `npm run desktop:dev` for native development. Forks must configure their own update signing key and feed before distributing updates. See [release maintenance](docs/RELEASING.md).

</details>

## Contribute

[Report a bug or request a feature](https://github.com/Loomtide/atlas-review/issues). For development setup and checks, see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Atlas Review is a [Loomtide](https://github.com/Loomtide) project, licensed under [MIT](LICENSE). Bundled dependencies retain their respective licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
