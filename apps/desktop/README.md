# Atlas Review desktop

The desktop application is built with Tauri v2 and bundles the local Node.js backend and MCP server. See the [root README](../../README.md) for setup and downloads and [release instructions](../../docs/RELEASING.md) for signing.

Use `npm run desktop:dev` for native development and `npm run desktop:build:unsigned` for a contributor installer. Official release builds require updater signing credentials. The application name, identifier, and storage paths remain AtlasEngine for compatibility with existing installations.
