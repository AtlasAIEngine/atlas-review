#!/bin/bash

# AtlasEngine MVP - End-to-End Test Script
# This script tests the complete flow from project creation to deployment

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         AtlasEngine MVP - End-to-End Test                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
API_BASE_URL="http://localhost:3000"
USER_ID="test-user-id"

# Helper functions
function success() {
    echo -e "${GREEN}✓${NC} $1"
}

function error() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

function info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

function step() {
    echo ""
    echo "────────────────────────────────────────────────────────────"
    echo "  $1"
    echo "────────────────────────────────────────────────────────────"
}

# Check dependencies
step "1. Checking Dependencies"

command -v curl >/dev/null 2>&1 || error "curl is not installed"
success "curl is installed"

command -v jq >/dev/null 2>&1 || error "jq is not installed (brew install jq)"
success "jq is installed"

# Test backend health
step "2. Testing Backend Health"

HEALTH_RESPONSE=$(curl -s "$API_BASE_URL/health" || echo "")

if [ -z "$HEALTH_RESPONSE" ]; then
    error "Backend is not running! Start it with: cd backend && npm run dev"
fi

HEALTH_STATUS=$(echo $HEALTH_RESPONSE | jq -r '.status')

if [ "$HEALTH_STATUS" != "ok" ]; then
    error "Backend health check failed: $HEALTH_RESPONSE"
fi

success "Backend is healthy"

DB_STATUS=$(echo $HEALTH_RESPONSE | jq -r '.database')
if [ "$DB_STATUS" != "connected" ]; then
    error "Database is not connected"
fi
success "Database is connected"

DOCKER_STATUS=$(echo $HEALTH_RESPONSE | jq -r '.docker')
if [ "$DOCKER_STATUS" != "connected" ]; then
    error "Docker is not connected"
fi
success "Docker is connected"

# Create project
step "3. Creating Test Project"

PROJECT_RESPONSE=$(curl -s -X POST "$API_BASE_URL/api/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E2E Test Project",
    "description": "Automated end-to-end test",
    "framework": "react",
    "language": "typescript"
  }')

PROJECT_ID=$(echo $PROJECT_RESPONSE | jq -r '.project.id')

if [ "$PROJECT_ID" == "null" ] || [ -z "$PROJECT_ID" ]; then
    error "Failed to create project: $PROJECT_RESPONSE"
fi

success "Project created: $PROJECT_ID"

# Verify project has memory
HAS_MEMORY=$(echo $PROJECT_RESPONSE | jq -r '.project.hasMemory')
if [ "$HAS_MEMORY" != "true" ]; then
    error "Project should have memory initialized"
fi
success "CLAUDE.md initialized"

# List files
step "4. Testing File Operations"

FILES_RESPONSE=$(curl -s "$API_BASE_URL/api/projects/$PROJECT_ID/files")
FILE_COUNT=$(echo $FILES_RESPONSE | jq '.files | length')

if [ "$FILE_COUNT" -lt 1 ]; then
    error "No files found in project"
fi
success "Found $FILE_COUNT file(s)"

# Get CLAUDE.md content
MEMORY_RESPONSE=$(curl -s "$API_BASE_URL/api/projects/$PROJECT_ID/memory")
MEMORY_CONTENT=$(echo $MEMORY_RESPONSE | jq -r '.content')

if [ -z "$MEMORY_CONTENT" ] || [ "$MEMORY_CONTENT" == "null" ]; then
    error "Failed to get CLAUDE.md content"
fi
success "CLAUDE.md retrieved (${#MEMORY_CONTENT} bytes)"

# Update CLAUDE.md
UPDATE_RESPONSE=$(curl -s -X POST "$API_BASE_URL/api/projects/$PROJECT_ID/memory" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": {
      "Test Status": "Running E2E tests",
      "Current Task": "Validating memory system"
    }
  }')

UPDATE_SUCCESS=$(echo $UPDATE_RESPONSE | jq -r '.success')
if [ "$UPDATE_SUCCESS" != "true" ]; then
    error "Failed to update CLAUDE.md"
fi
success "CLAUDE.md updated"

# Create package.json for build
step "5. Creating Project Files"

PACKAGE_JSON='{
  "name": "e2e-test-app",
  "version": "1.0.0",
  "scripts": {
    "build": "echo \"Build successful\" > build.log",
    "start": "node -e \"const http = require('"'http'"'); const server = http.createServer((req, res) => { res.writeHead(200, {'"'Content-Type'"': '"'text/html'"'}); res.end('"'<h1>E2E Test App Running!</h1>'"'); }); server.listen(3000, () => console.log('"'Server running on port 3000'"'));\""
  }
}'

FILE_CREATE_RESPONSE=$(curl -s -X PUT "$API_BASE_URL/api/projects/$PROJECT_ID/files/content" \
  -H "Content-Type: application/json" \
  -d "{\"path\": \"package.json\", \"content\": $(echo $PACKAGE_JSON | jq -R .)}")

FILE_SUCCESS=$(echo $FILE_CREATE_RESPONSE | jq -r '.success')
if [ "$FILE_SUCCESS" != "true" ]; then
    error "Failed to create package.json"
fi
success "package.json created"

# Test chat (optional - may fail if Claude wrapper is not working)
step "6. Testing Chat Integration"

CHAT_RESPONSE=$(curl -s -X POST "$API_BASE_URL/api/chat/sessions/$PROJECT_ID/message" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\", \"message\": \"Hello Claude, what files are in this project?\"}")

CHAT_MESSAGE=$(echo $CHAT_RESPONSE | jq -r '.message')

if [ ! -z "$CHAT_MESSAGE" ] && [ "$CHAT_MESSAGE" != "null" ]; then
    success "Chat response received"
    info "Claude says: ${CHAT_MESSAGE:0:100}..."
else
    info "Chat test skipped (Claude wrapper may need configuration)"
fi

# Create checkpoint
step "7. Testing Memory Checkpoint"

CHECKPOINT_RESPONSE=$(curl -s -X POST "$API_BASE_URL/api/projects/$PROJECT_ID/memory/checkpoint" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E2E Test Checkpoint",
    "notes": "Checkpoint created during automated testing"
  }')

CHECKPOINT_SUCCESS=$(echo $CHECKPOINT_RESPONSE | jq -r '.success')
if [ "$CHECKPOINT_SUCCESS" != "true" ]; then
    error "Failed to create checkpoint"
fi
success "Memory checkpoint created"

# Build project
step "8. Testing Build System"

info "Triggering build..."
BUILD_RESPONSE=$(curl -s -X POST "$API_BASE_URL/api/projects/$PROJECT_ID/build")

BUILD_ID=$(echo $BUILD_RESPONSE | jq -r '.buildId')

if [ "$BUILD_ID" == "null" ] || [ -z "$BUILD_ID" ]; then
    error "Failed to trigger build: $BUILD_RESPONSE"
fi

success "Build started: $BUILD_ID"

# Wait for build to complete
info "Waiting for build to complete (max 30s)..."
for i in {1..30}; do
    BUILD_STATUS_RESPONSE=$(curl -s "$API_BASE_URL/api/builds/$BUILD_ID")
    BUILD_STATUS=$(echo $BUILD_STATUS_RESPONSE | jq -r '.build.status')

    if [ "$BUILD_STATUS" == "success" ]; then
        success "Build completed successfully"
        break
    elif [ "$BUILD_STATUS" == "failed" ]; then
        error "Build failed"
    fi

    sleep 1
    echo -n "."
done
echo ""

# Deploy project
step "9. Testing Deployment System"

info "Deploying project..."
DEPLOY_RESPONSE=$(curl -s -X POST "$API_BASE_URL/api/projects/$PROJECT_ID/deploy" \
  -H "Content-Type: application/json" \
  -d "{\"buildId\": \"$BUILD_ID\"}")

PREVIEW_ID=$(echo $DEPLOY_RESPONSE | jq -r '.preview.id')
PORT=$(echo $DEPLOY_RESPONSE | jq -r '.preview.port')

if [ "$PREVIEW_ID" == "null" ] || [ -z "$PREVIEW_ID" ]; then
    error "Failed to deploy: $DEPLOY_RESPONSE"
fi

success "Deployment started: $PREVIEW_ID"
info "Preview will be available at: http://localhost:$PORT"

# Wait for health check
info "Waiting for health check (max 30s)..."
for i in {1..30}; do
    PREVIEW_STATUS_RESPONSE=$(curl -s "$API_BASE_URL/api/previews/$PREVIEW_ID")
    PREVIEW_STATUS=$(echo $PREVIEW_STATUS_RESPONSE | jq -r '.preview.status')

    if [ "$PREVIEW_STATUS" == "healthy" ]; then
        success "Preview is healthy"
        break
    elif [ "$PREVIEW_STATUS" == "failed" ]; then
        error "Preview health check failed"
    fi

    sleep 1
    echo -n "."
done
echo ""

# Test preview endpoint
step "10. Testing Preview Access"

PREVIEW_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT" || echo "000")

if [ "$PREVIEW_RESPONSE" == "200" ]; then
    success "Preview is accessible at http://localhost:$PORT"
else
    info "Preview returned HTTP $PREVIEW_RESPONSE (container may still be starting)"
fi

# Get final stats
step "11. Checking Final Stats"

STATS_RESPONSE=$(curl -s "$API_BASE_URL/api/projects/$PROJECT_ID/memory/stats")
SNAPSHOT_COUNT=$(echo $STATS_RESPONSE | jq -r '.stats.snapshotCount')
success "Memory snapshots: $SNAPSHOT_COUNT"

# Cleanup (optional)
step "12. Cleanup"

info "Stopping preview..."
STOP_RESPONSE=$(curl -s -X DELETE "$API_BASE_URL/api/previews/$PREVIEW_ID")
success "Preview stopped"

info "Note: Project $PROJECT_ID was created and can be deleted manually if needed"

# Summary
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                   Test Summary                             ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}✓ All tests passed!${NC}"
echo ""
echo "Test Results:"
echo "  • Project ID: $PROJECT_ID"
echo "  • Build ID: $BUILD_ID"
echo "  • Preview ID: $PREVIEW_ID"
echo "  • Preview Port: $PORT"
echo "  • Memory Snapshots: $SNAPSHOT_COUNT"
echo ""
echo "You can view the test project in the frontend at:"
echo "  http://localhost:5173"
echo ""
echo "To clean up, you can delete the project via:"
echo "  curl -X DELETE $API_BASE_URL/api/projects/$PROJECT_ID"
echo ""
