# Release maintenance

Official releases are built from version tags in this repository. The application bundle remains AtlasEngine for upgrade compatibility; public download aliases use AtlasReview. Keep package.json, its lock, Cargo.toml, Cargo.lock, and tauri.conf.json versions aligned. Use increasing versions; do not reset the version while supporting existing installations.

## Credentials

Contributor builds use `npm run desktop:build:unsigned` and need no release secrets. Official builds require `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep the private key outside the repository and preserve the matching public key for existing users.

Optional Apple signing requires `APPLE_CERTIFICATE` (base64 P12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`, and `KEYCHAIN_PASSWORD`. Configure all of them or none. Windows code signing is optional through `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, and `WINDOWS_TIMESTAMP_URL`; installer updater signing is required independently. Inspect the workflow for the supported certificate format.

Store secrets in GitHub Actions secrets. The normal workflow publishes to this repository using its short-lived GitHub token; no cross-repository publication token is needed. Pull request checks do not receive signing secrets.

## Procedure

1. Run CI and review the version and toolchain changes. Tag the exact intended main commit with `v<version>` and push the tag.
2. The workflow builds Windows x64 and Mac Apple Silicon/Intel, validates required files and signatures, creates fixed-name download aliases, and writes SHA256SUMS and source metadata.
3. Inspect the draft release, CI logs, signing status, and installers. Test fresh installs and an upgrade on each supported platform before publishing the draft using `gh release edit <tag> --draft=false --latest` (omit `--latest` for prereleases).
4. Validate unauthenticated download links and updater manifests after publication. Stable builds use the latest release's `stable.json` asset. Do not mark a prerelease as latest stable.

Releases are assembled as drafts so failed or partial builds cannot advance the public updater feed. Do not publish a draft that has missing platforms or failed checks. A published release must include its exact source SHA, checksums, license notices, and accurate code-signing status. OS signing does not guarantee Windows SmartScreen reputation.

## Existing users

Old builds use `AvinashP/AtlasEngineRelease` and its stable manifest. Keep that repository and manifest available. Only after testing an upgrade with the preserved updater key should maintainers update the legacy manifest to reference the new signed release assets. This compatibility publication is a separate maintainer action with access to the old repository. Never delete the old feed during the launch.

A legacy release mirrored for download continuity must explicitly identify its origin and must not claim to have been built from the new curated source tree.
