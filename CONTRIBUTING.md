# Contributing to Atlas Review

Use Node.js 22, Git, and `npm run setup`. Follow the README for local development and optional desktop prerequisites. Create a branch, keep changes focused, explain user-visible behavior, and include relevant validation in your pull request.

## Checks

```sh
npm run check:public
npm --prefix frontend run build
npm --prefix backend test -- src/services/__tests__/reviewSyncSettings.test.js src/services/__tests__/verificationService.test.js
npm --prefix mcp-review-server test
```

Run additional focused tests for changed behavior. Backend tests use Vitest; frontend tests use Playwright, including Node-based unit tests under `npm --prefix frontend run test:unit`. Some integration tests need explicit provider access or platform dependencies; do not add real credentials to fixtures. CI checks do not require maintainer secrets.

Keep lockfiles synchronized when dependencies change. Never include environment files, private keys, local databases, user repositories, or generated installers. Gitleaks exceptions must be restricted to a verified synthetic fixture and reviewed alongside the test.

Preserve application identifiers and storage paths unless your change includes an upgrade migration. Do not change official updater keys or feeds for an unrelated patch. Report vulnerabilities privately through the process in SECURITY.md.
