#!/bin/bash
# start.sh — Selma Boot Script
# Syncs identity files from GitHub, then starts the gateway
set -e

echo "🪐 Selma booting..."

# Create identity directory if it doesn't exist
mkdir -p /data/workspace/identity

# Clear stale OAuth state so OpenClaw uses ANTHROPIC_API_KEY env var
echo "🧹 Clearing any stale OAuth credentials..."
rm -f /data/.openclaw/auth.json /data/.openclaw/oauth.json /data/.openclaw/credentials.json 2>/dev/null || true
rm -rf /data/.openclaw/.auth /data/.openclaw/sessions 2>/dev/null || true

# Sync identity files from GitHub
echo "📥 Syncing identity files from GitHub..."
if [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_REPO" ]; then
    # Fetch IDENTITY.md
    curl -s -H "Authorization: token $GITHUB_TOKEN" \
         -H "Accept: application/vnd.github.v3.raw" \
         "https://api.github.com/repos/$GITHUB_REPO/contents/identity/IDENTITY.md" \
         -o /data/workspace/identity/IDENTITY.md && echo "  ✅ IDENTITY.md synced"

    # Fetch SOUL.md
    curl -s -H "Authorization: token $GITHUB_TOKEN" \
         -H "Accept: application/vnd.github.v3.raw" \
         "https://api.github.com/repos/$GITHUB_REPO/contents/identity/SOUL.md" \
         -o /data/workspace/identity/SOUL.md && echo "  ✅ SOUL.md synced"

    # Fetch USER.md
    curl -s -H "Authorization: token $GITHUB_TOKEN" \
         -H "Accept: application/vnd.github.v3.raw" \
         "https://api.github.com/repos/$GITHUB_REPO/contents/identity/USER.md" \
         -o /data/workspace/identity/USER.md && echo "  ✅ USER.md synced"

    echo "📂 Identity files synced from $GITHUB_REPO"
else
    echo "⚠️  GITHUB_TOKEN or GITHUB_REPO not set — using bundled identity files"
    cp -r /app/identity/* /data/workspace/identity/ 2>/dev/null || true
fi

# List what's in identity folder
echo "📁 Identity folder contents:"
ls -la /data/workspace/identity/ 2>/dev/null || echo "  (empty)"

# Start the OpenClaw gateway
echo "🚀 Starting Selma gateway..."
exec node src/server.js
