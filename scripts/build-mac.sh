#!/bin/bash
set -e

# ================================================================
# Build Call Transcript Merger for macOS
# ================================================================
# This script must be run ON a Mac.
#
# It produces a signed .app and .dmg that macOS will open without
# Gatekeeper warnings.
#
# USAGE:
#   ./scripts/build-mac.sh
#
# For notarized builds (fully trusted by macOS out of the box):
#   1. Get a free Apple Developer account at https://developer.apple.com
#   2. Create an App-Specific Password at https://appleid.apple.com
#   3. Set these env vars before running:
#        export APPLE_ID="you@icloud.com"
#        export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#        export APPLE_TEAM_ID="XXXXXXXXXX"
#   4. Run this script
# ================================================================

cd "$(dirname "$0")/.."

echo "==> Installing dependencies..."
npm install

echo "==> Running tests..."
npm test

echo ""
echo "==> Building macOS app..."

# Check if we can sign
if security find-identity -v -p codesigning 2>/dev/null | grep -q "valid identities found"; then
    echo "    Code signing identity found. App will be signed."
else
    echo "    No signing identity found. Using ad-hoc signature."
    echo "    The app will work on YOUR Mac but Gatekeeper may still"
    echo "    warn other users. For full trust, set up an Apple Developer"
    echo "    account and install its certificate in Keychain Access."
    export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

# If notarization credentials are set, enable notarization
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
    echo "    Notarization credentials found. App will be notarized."
    export APPLE_NOTARIZE=true
else
    echo "    No notarization credentials. Skipping notarization."
    echo "    (Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID to enable)"
fi

npx electron-builder --mac

echo ""
echo "==> Build complete!"
echo ""
ls -lh dist/*.dmg dist/*.zip 2>/dev/null
echo ""
echo "Your app is in the dist/ folder."
echo "  - .dmg: Drag to Applications and double-click to run"
echo "  - .zip: Share with others"
