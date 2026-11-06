# Windows installation and upgrade check

Interactive Windows testing is deferred to the maintainer's separate Windows machine. The release is built for Windows x64; CI verifies compilation and starts the bundled backend against a fresh temporary SQLite profile.

1. Download `AtlasReview-windows-x64-setup.exe` and SHA256SUMS from the latest release. In PowerShell, use `Get-FileHash .\AtlasReview-windows-x64-setup.exe -Algorithm SHA256` and compare it with the listed alias checksum.
2. Close AtlasEngine before an upgrade. Privately back up the existing application profile, normally `%APPDATA%\com.atlasengine.desktop`, including its database and encryption key. Existing development installs may use a separate `dev.atlasengine.desktop` profile.
3. Run the installer. The installed application retains the AtlasEngine name and identifier for compatibility. Windows installers currently have updater signatures but no Authenticode certificate; record any SmartScreen prompt when testing.
4. Launch the app and verify the setup screen or existing projects appear. Confirm prior provider credentials remain usable after an upgrade.
5. Import a small local Git repository, configure your own provider access, and complete a branch review. If GitHub is configured, open a PR review and verify findings and explicit publication actions.
6. Configure the MCP integration, restart the agent, and request a read-only review status check.
7. Check that the updater can read the new release feed. A same-version installation should report no available update.
8. Record Windows version, installer version, first-launch behavior, review completion, upgrade data retention, and any errors. Remove credentials and private code from shared logs.

A clean-install profile and an existing-user upgrade are separate checks. Do not delete your working profile to simulate a clean install; use a separate Windows account or a disposable environment.
