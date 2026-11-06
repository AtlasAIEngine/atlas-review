# Open source launch verification

Atlas Review is prepared from the working source snapshot identified in SOURCE_MANIFEST.md. The first public installer release is 0.25.26. Existing application identifiers, updater verification key, and data paths are preserved.

## Source and local checks

- Clean Node.js 22 installation from synchronized per-package lockfiles.
- Full backend suite: 146 files passed; 2,224 tests passed and 5 skipped.
- Frontend production build and all 178 frontend unit tests passed.
- All 143 MCP tests passed.
- Fresh SQLite initialization and repeat initialization passed.
- A fresh-profile local backend reached a healthy state without PostgreSQL or Docker setup.
- Bundled Node.js and native dependency startup passed on local Apple Silicon.
- New model catalog, CLI arguments, API request shape, and pricing-tier boundary checks passed.
- Redacted Gitleaks scans passed for the selected source and new Git history, using narrow exceptions for verified synthetic fixtures.
- Tracked-file checks and public documentation link checks passed.

[Launch CI checks](https://github.com/AtlasAIEngine/atlas-review/actions/runs/42182882937) passed for source commit `8e457674dab5fa137ca32228f2f1943a34d6b8dd`. Installer provenance is recorded separately in each release's SOURCE.json.

## Installer checks

Official builds must pass the per-platform bundled-backend smoke test, artifact completeness checks, updater signature verification, checksum verification, and package-content inspection before publication. The final release assets and CI run provide the platform build evidence.

Interactive Windows installation and upgrade testing is deferred to the maintainer's separate Windows machine, by explicit agreement. Automated Windows compilation and packaged-backend checks remain required. A provider account's model availability depends on its permissions and CLI version; the catalog checks do not represent a paid live review on every model.

## Legacy downloads

The old 0.25.24 Mac updater package contained internal benchmark artifacts. It is not mirrored into this repository. The maintainer authorized removal of old installer downloads after clean replacements are verified. The legacy updater feed remains available and is migrated to the new signed assets after publication.

## Dependency audit

At launch preparation on 2026-11-06, npm audit reported no high or critical advisories across the retained packages. Moderate dependency advisories remain: seven backend entries and eight frontend entries, including transitive dependency chains. MCP and desktop build package audits reported none. See DEPENDENCY_STATUS.md for scope and follow-up.
