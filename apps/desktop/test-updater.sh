#!/usr/bin/env bash
#
# Local auto-updater test script for AtlasEngine Desktop
#
# This script:
# 1. Builds a "new" version (0.22.0) as the update artifact
# 2. Manually signs the .app.tar.gz
# 3. Reverts to the "old" version (0.21.0) with localhost endpoint
# 4. Rebuilds the old version
# 5. Serves the update via a local HTTP server
# 6. Launches the old app so it discovers and installs the update
#
# Prerequisites:
#   - Signing key at apps/desktop/.tauri_updater_key
#   - Rust toolchain + cargo tauri CLI installed
#
# Usage: cd apps/desktop && bash test-updater.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAURI_CONF="$SCRIPT_DIR/src-tauri/tauri.conf.json"
CARGO_TOML="$SCRIPT_DIR/src-tauri/Cargo.toml"
PACKAGE_JSON="$SCRIPT_DIR/package.json"
BUNDLE_DIR="$SCRIPT_DIR/src-tauri/target/release/bundle/macos"
TEST_DIR="$SCRIPT_DIR/test-updates"
SERVE_DIR="$TEST_DIR/serve"
DEFAULT_UPDATER_PRIVATE_KEY="$SCRIPT_DIR/.tauri_updater_key"
DEFAULT_UPDATER_PUBLIC_KEY_FILE="$SCRIPT_DIR/.tauri_updater_key.pub"

OLD_VERSION="0.21.0"
NEW_VERSION="0.22.0"
LOCAL_PORT=8080

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[updater-test]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }

cleanup() {
    log "Cleaning up..."
    local restored=0
    # Kill local server if running
    if [[ -n "${SERVER_PID:-}" ]]; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi
    # Restore original configs
    if [[ -f "$TAURI_CONF.bak" ]]; then
        mv "$TAURI_CONF.bak" "$TAURI_CONF"
        restored=1
    fi
    if [[ -f "$CARGO_TOML.bak" ]]; then
        mv "$CARGO_TOML.bak" "$CARGO_TOML"
        restored=1
    fi
    if [[ -f "$PACKAGE_JSON.bak" ]]; then
        mv "$PACKAGE_JSON.bak" "$PACKAGE_JSON"
        restored=1
    fi
    if [[ "$restored" -eq 1 ]]; then
        success "Restored original desktop version/config files"
    fi
    if [[ -n "${TEMP_UPDATER_PRIVATE_KEY:-}" ]]; then
        rm -f "$TEMP_UPDATER_PRIVATE_KEY" "${TEMP_UPDATER_PRIVATE_KEY}.pub"
        success "Removed temporary updater signing key"
    fi
}
trap cleanup EXIT

# Check prerequisites
check_prereqs() {
    log "Checking prerequisites..."

    if [[ ! -f "$DEFAULT_UPDATER_PRIVATE_KEY" ]]; then
        error "Signing key not found at $DEFAULT_UPDATER_PRIVATE_KEY"
    fi

    if ! command -v cargo &>/dev/null; then
        error "cargo not found. Install Rust toolchain."
    fi

    if ! cargo tauri --version &>/dev/null; then
        error "cargo tauri CLI not found. Install with: cargo install tauri-cli"
    fi

    if ! command -v python3 &>/dev/null; then
        error "python3 not found (needed for HTTP server)"
    fi

    success "All prerequisites met"
}

resolve_signing_credentials() {
    if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
        UPDATER_PRIVATE_KEY_PATH="$DEFAULT_UPDATER_PRIVATE_KEY"
        UPDATER_PUBLIC_KEY="$(cat "$DEFAULT_UPDATER_PUBLIC_KEY_FILE")"
        export UPDATER_PRIVATE_KEY_PATH UPDATER_PUBLIC_KEY
        success "Using configured updater signing key"
        return
    fi

    TEMP_UPDATER_PRIVATE_KEY="/tmp/atlasengine-updater-test-key-$$"
    log "No updater signing password provided; generating temporary test signing key..."
    cargo tauri signer generate -w "$TEMP_UPDATER_PRIVATE_KEY" -p test --ci >/tmp/atlasengine-updater-keygen.out

    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="test"
    UPDATER_PRIVATE_KEY_PATH="$TEMP_UPDATER_PRIVATE_KEY"
    UPDATER_PUBLIC_KEY="$(cat "${TEMP_UPDATER_PRIVATE_KEY}.pub")"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD UPDATER_PRIVATE_KEY_PATH UPDATER_PUBLIC_KEY

    success "Using temporary updater signing key for this local test"
}

# Back up config and set version + endpoint
set_config() {
    local version="$1"
    local endpoint="$2"

    python3 -c "
import json
from pathlib import Path

with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['version'] = '$version'
conf['plugins']['updater']['endpoints'] = ['$endpoint']
conf['plugins']['updater']['pubkey'] = __import__('os').environ['UPDATER_PUBLIC_KEY']
# Allow HTTP for local testing
if '$endpoint'.startswith('http://'):
    conf['plugins']['updater']['dangerousInsecureTransportProtocol'] = True
elif 'dangerousInsecureTransportProtocol' in conf['plugins']['updater']:
    del conf['plugins']['updater']['dangerousInsecureTransportProtocol']
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')

cargo_path = Path('$CARGO_TOML')
cargo_text = cargo_path.read_text()
cargo_path.write_text(__import__('re').sub(
    r'^version = \".*\"$',
    'version = \"$version\"',
    cargo_text,
    count=1,
    flags=__import__('re').MULTILINE,
))

package_path = Path('$PACKAGE_JSON')
package = json.loads(package_path.read_text())
package['version'] = '$version'
package_path.write_text(json.dumps(package, indent=2) + '\n')
"
    success "Set desktop version=$version, endpoint=$endpoint"
}

# Build the Tauri app (without signing — we sign manually after)
build_app() {
    local version="$1"
    log "Building AtlasEngine v${version}... (this takes a few minutes)"

    cd "$SCRIPT_DIR"

    # Temporarily disable updater artifacts to skip the signing step
    # The build produces .app, we'll tar+sign manually
    python3 -c "
import json
with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['bundle']['createUpdaterArtifacts'] = False
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')
"

    # Build app bundle only (no DMG)
    cargo tauri build --bundles app 2>&1 | tail -5

    # Re-enable updater artifacts in config
    python3 -c "
import json
with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['bundle']['createUpdaterArtifacts'] = True
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')
"

    if [[ ! -d "$BUNDLE_DIR/AtlasEngine.app" ]]; then
        error "Build failed - no AtlasEngine.app produced"
    fi

    success "Built v${version} successfully"
}

# Create the updater tar.gz + signature manually
create_updater_artifact() {
    log "Creating updater artifact..."

    cd "$BUNDLE_DIR"

    # Create the tar.gz (exclude macOS resource fork files that break Tauri's unpacker)
    COPYFILE_DISABLE=1 tar czf AtlasEngine.app.tar.gz AtlasEngine.app

    # Sign using env var for password
    cargo tauri signer sign "$BUNDLE_DIR/AtlasEngine.app.tar.gz" \
        --private-key-path "$UPDATER_PRIVATE_KEY_PATH" 2>&1

    if [[ ! -f "$BUNDLE_DIR/AtlasEngine.app.tar.gz.sig" ]]; then
        error "Signing failed - no .sig file produced"
    fi

    success "Created and signed updater artifact"
}

# ---- Main Flow ----

echo ""
echo "==========================================="
echo "  AtlasEngine Auto-Updater Local Test"
echo "==========================================="
echo ""

check_prereqs
resolve_signing_credentials

# Back up config
cp "$TAURI_CONF" "$TAURI_CONF.bak"
cp "$CARGO_TOML" "$CARGO_TOML.bak"
cp "$PACKAGE_JSON" "$PACKAGE_JSON.bak"
success "Backed up desktop version/config files"

# ---- Step 1: Build the NEW version (the update artifact) ----
echo ""
log "=== Step 1: Building NEW version (v${NEW_VERSION}) ==="
set_config "$NEW_VERSION" "http://localhost:${LOCAL_PORT}/stable.json"
build_app "$NEW_VERSION"
create_updater_artifact

# Save the update artifacts
mkdir -p "$SERVE_DIR"
cp "$BUNDLE_DIR/AtlasEngine.app.tar.gz" "$SERVE_DIR/"
cp "$BUNDLE_DIR/AtlasEngine.app.tar.gz.sig" "$SERVE_DIR/"
success "Saved update artifacts to $SERVE_DIR/"

# Read the signature for the manifest
SIGNATURE="$(cat "$SERVE_DIR/AtlasEngine.app.tar.gz.sig")"

# Generate the test manifest
cat > "$SERVE_DIR/stable.json" <<EOF
{
  "version": "${NEW_VERSION}",
  "notes": "Test update to v${NEW_VERSION}\\n\\n- Auto-updater verification\\n- Local testing",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "http://localhost:${LOCAL_PORT}/AtlasEngine.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "http://localhost:${LOCAL_PORT}/AtlasEngine.app.tar.gz"
    }
  }
}
EOF
success "Generated update manifest at $SERVE_DIR/stable.json"

# ---- Step 2: Build the OLD version (the app that will receive the update) ----
echo ""
log "=== Step 2: Building OLD version (v${OLD_VERSION}) ==="
set_config "$OLD_VERSION" "http://localhost:${LOCAL_PORT}/stable.json"
build_app "$OLD_VERSION"

# ---- Step 3: Start local update server ----
echo ""
log "=== Step 3: Starting local update server ==="

cd "$SERVE_DIR"
python3 -m http.server "$LOCAL_PORT" &
SERVER_PID=$!
sleep 1

# Verify server is running
if curl -s "http://localhost:${LOCAL_PORT}/stable.json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Serving update v{d[\"version\"]}')" 2>/dev/null; then
    success "Update server running on http://localhost:${LOCAL_PORT}"
else
    error "Failed to start update server"
fi

# ---- Step 4: Launch the old app ----
echo ""
log "=== Step 4: Launching AtlasEngine v${OLD_VERSION} ==="
echo ""
echo "==========================================="
echo "  What to look for:"
echo "  1. App starts at v${OLD_VERSION}"
echo "  2. After ~3 seconds, blue update banner appears"
echo "  3. Click 'Update Now' to download"
echo "  4. Progress bar fills up"
echo "  5. App restarts at v${NEW_VERSION}"
echo "==========================================="
echo ""
warn "Press Ctrl+C to stop the test when done"
echo ""

# Launch the built app
open "$BUNDLE_DIR/AtlasEngine.app"

# Keep the script running (server alive) until Ctrl+C
wait "$SERVER_PID"
