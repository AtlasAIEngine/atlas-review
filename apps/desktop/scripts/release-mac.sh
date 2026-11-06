#!/usr/bin/env bash
set -euo pipefail

#
# release-mac.sh — Build, sign, and publish Mac releases (both architectures)
#
# Usage:
#   ./scripts/release-mac.sh              # auto-reads version from tauri.conf.json
#   ./scripts/release-mac.sh 0.24.0       # explicit version (also bumps files)
#   ./scripts/release-mac.sh --build-only # build without publishing
#
# Prerequisites:
#   - apps/desktop/.env.local with APPLE_* credentials
#   - apps/desktop/.env with TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#   - apps/desktop/.tauri_updater_key
#   - gh CLI authenticated
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"

BUILD_ONLY=false
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=true ;;
    *) VERSION="$arg" ;;
  esac
done

cd "$DESKTOP_DIR"

# Read current version if not provided
if [ -z "$VERSION" ]; then
  VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
  echo "Using current version: $VERSION"
else
  # Bump version in both files
  python3 -c "
import json
for f in ['src-tauri/tauri.conf.json', 'package.json']:
    with open(f, 'r') as fh: c = json.load(fh)
    c['version'] = '$VERSION'
    with open(f, 'w') as fh: json.dump(c, fh, indent=2); fh.write('\n')
print('Bumped to $VERSION')
"
  cd "$PROJECT_ROOT"
  git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/package.json
  git commit -m "chore: bump desktop version to $VERSION" || true
  git push || true
  git push origin HEAD:main 2>/dev/null || true
  cd "$DESKTOP_DIR"
fi

STAGING="$PROJECT_ROOT/release-staging/$VERSION"

echo ""
echo "========================================="
echo "  Building AtlasEngine v$VERSION (Mac)"
echo "========================================="
echo ""

# Build Apple Silicon (signed + notarized)
echo "▸ Building aarch64 (Apple Silicon)..."
npm run release:local:build:signed -- --version "$VERSION" --target aarch64-apple-darwin

echo ""
echo "▸ Building x86_64 (Intel)..."
npm run release:local:build:signed -- --version "$VERSION" --target x86_64-apple-darwin

echo ""
echo "✅ Both builds complete. Artifacts in: $STAGING"
ls -lh "$STAGING/"

if [ "$BUILD_ONLY" = true ]; then
  echo ""
  echo "Build-only mode. Skipping publish."
  exit 0
fi

echo ""
echo "▸ Publishing to release repo..."
npm run release:local:publish -- --version "$VERSION" --artifacts-dir "$STAGING"

echo ""
echo "========================================="
echo "  ✅ v$VERSION released!"
echo "  https://github.com/AvinashP/AtlasEngineRelease/releases/tag/v$VERSION"
echo "========================================="
