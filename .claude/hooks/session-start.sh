#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install ffmpeg if not present (required by fluent-ffmpeg, integration tests, SFX pipeline)
if ! command -v ffmpeg &>/dev/null; then
  echo "Installing ffmpeg..."
  apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null 2>&1
  echo "ffmpeg installed: $(ffmpeg -version 2>&1 | head -1)"
fi

# Install Node.js dependencies
cd "$CLAUDE_PROJECT_DIR"
if [ ! -d "node_modules" ]; then
  echo "Installing npm dependencies..."
  npm install
else
  echo "node_modules exists, running npm install for any updates..."
  npm install
fi
