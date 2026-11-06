# Third party notices

Atlas Review is licensed under MIT. Dependencies and bundled tools retain their own copyrights and licenses. Dependency versions and package integrity hashes are recorded in npm lockfiles and `apps/desktop/src-tauri/Cargo.lock`.

The desktop app bundles Node.js (MIT and third-party notices), a Tauri/Rust application and plugins (their respective licenses), and production npm dependencies including React, Express, Monaco, SQLite bindings, and the MCP SDK. The exact dependency license inventory is generated during release preparation and included with release assets. Package authors and license terms are recorded there; it does not replace the licenses shipped by individual packages.

Do not remove dependency license files from packaged resources. Redistributed Node.js license text must be included alongside the bundled runtime. See the release workflow and generated notice inventory for the exact distribution.
