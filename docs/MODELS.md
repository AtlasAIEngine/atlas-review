# Supported review models

The model picker includes GPT-6.1 Sol, GPT-6 Astra, GPT-6.1 Terra, GPT-6 Luna, GPT-6 Sol, Claude Opus 5.5, Claude Sonnet 5.5, Claude Haiku 5.5, and Claude Fable 5.1 alongside existing models. Availability depends on your account and installed CLI version. Update the provider CLI if it rejects a listed model.

The current catalog is verified against the [OpenAI model catalog](https://developers.openai.com/api/docs/models) and [Anthropic model catalog](https://platform.claude.com/docs/en/models/overview) on 2026-11-06. Existing review routing defaults and saved model selections are preserved. Smaller Haiku models remain available for triage and narration rather than the primary review phase.

Codex runs new models through the CLI's own transport. GPT-6 API review uses text Chat Completions without tools. The legacy builder's Chat Completions tool picker excludes GPT-6 models because their reasoning tool calls require Responses API support. Explicit older Claude versions are passed through unchanged; generic opus, sonnet, and haiku aliases refer to the current CLI defaults.

Usage estimates use the [standard OpenAI rates](https://developers.openai.com/api/docs/pricing) and [standard Claude rates](https://platform.claude.com/docs/en/about-claude/pricing). Long-context pricing tiers are included for GPT-6 and Haiku 5.5. Estimates do not represent subscription charges or account-specific discounts, caching, regional processing, or special service tiers.
