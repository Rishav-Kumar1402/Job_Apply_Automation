#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.jobautoapply.host"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_PATH="$HOST_DIR/install/host-launcher.sh"
chmod +x "$HOST_PATH"

echo "Building host..."
cd "$HOST_DIR/../.."
npm run build -w @job-autoapply/host

CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$CHROME_DIR"

MANIFEST="$CHROME_DIR/${HOST_NAME}.json"

cat > "$MANIFEST" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Job Auto-Apply Playwright automation host",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://REPLACE_WITH_EXTENSION_ID/"
  ]
}
EOF

echo "Installed to $MANIFEST"
echo "Replace REPLACE_WITH_EXTENSION_ID with your extension ID."
