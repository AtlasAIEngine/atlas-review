# Contributor agent guidance

Use Node.js 22. Run `npm run setup` to install locked dependencies and `npm run dev` for the local review application. Keep changes focused and run the relevant checks in CONTRIBUTING.md.

Never commit credentials, local environment files, runtime data, user repositories, or signing keys. Do not publish review comments or releases unless the task authorizes it.

Preserve the desktop application identifier, data paths, and updater public key unless implementing a tested migration. Hosted sync is optional.

Never use an em dash or an en dash in new text. Preserve existing third-party content when needed.
