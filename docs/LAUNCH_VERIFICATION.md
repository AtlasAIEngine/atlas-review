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
- A fresh-profile browser dashboard opened without JavaScript errors or backend 5xx responses. The README screenshot uses that empty profile.

[Launch CI checks](https://github.com/AtlasAIEngine/atlas-review/actions/runs/42182882937) passed for source commit `8e457674dab5fa137ca32228f2f1943a34d6b8dd`. Installer provenance is recorded separately in each release's SOURCE.json.

## Installer checks

[Release CI](https://github.com/AtlasAIEngine/atlas-review/actions/runs/42182890282) passed for all three platforms. The published 0.25.26 release contains 23 assets, including Windows EXE/MSI, Apple Silicon DMG, Intel Mac ZIP, updater payloads, checksums, source provenance, and dependency notices.

Downloaded release assets passed SHA256SUMS verification, fixed-download alias comparison, and independent Ed25519 updater signature verification against the preserved application public key. SOURCE.json matches tag v0.25.26 at commit `8e457674dab5fa137ca32228f2f1943a34d6b8dd`.

Both extracted Mac applications passed strict deep code-signature verification and Gatekeeper assessment as Notarized Developer ID. Separate stapled-ticket validation was inconclusive for Apple Silicon because Apple's ticket service lost its connection; the extracted Intel application has no stapled ticket. Gatekeeper's online notarization assessment passed for both. Offline first-run behavior was not verified.

Package inspection checked 1,188 Mac application source files and 15,161 Windows installer paths. No local credential files or internal benchmark artifacts were found by these checks. This complements the source secret scan and CI bundle guards; it is not a guarantee against every possible secret pattern.

All three public latest-download links returned HTTP 200 without authentication. The public stable.json matches the locally verified signed release manifest.

Interactive Windows installation and upgrade testing is deferred to the maintainer's separate Windows machine, by explicit agreement. Automated Windows compilation and packaged-backend checks remain required. A provider account's model availability depends on its permissions and CLI version; the catalog checks do not represent a paid live review on every model.

## Legacy downloads

The old 0.25.24 Mac updater package contained internal benchmark artifacts. It is not mirrored into this repository. The maintainer authorized removal of old installer downloads after clean replacements are verified. The legacy updater feed now points to the verified 0.25.26 assets in the new repository. The legacy README and latest release direct users to Atlas Review. Old installer assets are retired after the new public download links and compatibility feed are verified.

## Dependency audit

At launch preparation on 2026-11-06, npm audit reported no high or critical advisories across the retained packages. Moderate dependency advisories remain: seven backend entries and eight frontend entries, including transitive dependency chains. MCP and desktop build package audits reported none. See DEPENDENCY_STATUS.md for scope and follow-up.

## Repository publication

The repository is public under the MIT license, with fresh source history. GitHub private vulnerability reporting, secret scanning, and secret scanning push protection are enabled. Main requires the source and build checks, with force pushes and branch deletion disabled. Signing credentials are stored in GitHub Actions secrets, outside tracked source.
