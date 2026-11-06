# Configuration and privacy

Local review runs with SQLite through `backend/server-desktop.js`. `npm run dev` selects this entry point automatically. The legacy server entry points support additional infrastructure but are not required for the desktop review workflow.

## Local profile

Set `ATLAS_DATA_DIR` to an absolute writable directory for an isolated profile. Otherwise existing AtlasEngine data paths are retained: `~/Library/Application Support/AtlasEngine` on Mac, `%APPDATA%/AtlasEngine` on Windows, and `~/.local/share/AtlasEngine` on Linux. The profile contains the database, local configuration, logs, and token-encryption material. Back it up privately and never commit it.

The application creates installation-specific encryption material. Configure AI providers in Settings or use a supported authenticated provider CLI. Do not place provider secrets in frontend `VITE_*` variables: those values become public in browser bundles.

## GitHub

The desktop device flow has a default public GitHub App client ID. Client IDs are public metadata, not client secrets. You authorize your own account and repository access. Fork operators can set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_NAME` for their own app with device flow enabled. Local review does not require GitHub sign-in. Do not embed GitHub App private keys or client secrets in desktop binaries.

## Optional hosted sync

Fresh installations do not receive a default hosted sync server. Configure `ATLAS_REVIEW_SYNC_SERVER_URL` only if you intend to use an existing compatible service. Sync can transfer review state and findings to that service; its operator controls retention and access. `ATLAS_REVIEW_SYNC_AUTH_TOKEN` configures authentication where supported. Existing saved sync settings survive upgrades. Clear those settings if you no longer want sync.

The hosted service is not deployed by these setup instructions. Cloud deployment, billing, and dashboard services are optional and outside the supported local setup.

## Network access

AI review transmits selected code/context to your provider under that provider's account and privacy terms. GitHub features contact GitHub, and updater checks contact the configured release feed. Dependency installation downloads packages and build tools. Do not submit private code to a provider or sync service without appropriate authorization.
