#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.jobautoapply.host"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_JS="$HOST_DIR/dist/index.js"

EXTENSION_ID="${1:-${EXTENSION_ID:-}}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo "Detecting extension ID from Chrome preferences..."
  EXTENSION_ID="$(python3 <<'PY'
import json, os, glob

pref_paths = [
    os.path.expanduser("~/.config/job-autoapply-chrome/Default/Preferences"),
    os.path.expanduser("~/.config/google-chrome/Default/Preferences"),
    os.path.expanduser("~/.config/chromium/Default/Preferences"),
    os.path.expanduser("~/.config/google-chrome-beta/Default/Preferences"),
]

for path in pref_paths:
    if not os.path.isfile(path):
        continue
    try:
        with open(path) as f:
            prefs = json.load(f)
        for eid, data in prefs.get("extensions", {}).get("settings", {}).items():
            manifest = data.get("manifest", {})
            ext_path = data.get("path", "")
            name = manifest.get("name", "")
            if name == "Job Auto-Apply" or "job-autoapply" in ext_path or "load-in-chrome" in ext_path:
                print(eid)
                raise SystemExit(0)
    except (json.JSONDecodeError, OSError):
        pass
PY
)" || true
fi

if [[ -z "$EXTENSION_ID" ]]; then
  echo "ERROR: Could not detect extension ID."
  echo ""
  echo "Usage: $0 <extension-id>"
  echo "Find it at chrome://extensions → Developer mode → ID under Job Auto-Apply"
  exit 1
fi

if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
  :
elif [[ -n "${NVM_BIN:-}" && -x "${NVM_BIN}/node" ]]; then
  NODE_BIN="${NVM_BIN}/node"
elif [[ -x "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
  NODE_BIN="$(command -v node)"
else
  NODE_BIN="$(command -v node)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "ERROR: node not found. Install Node.js 20+ or set NODE_BIN=/path/to/node"
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -v)"
echo "Using Node: $NODE_BIN ($NODE_VERSION)"

echo "Building host..."
cd "$HOST_DIR/../.."
npm run build -w @job-autoapply/host

if [[ ! -f "$HOST_JS" ]]; then
  echo "ERROR: Host build missing at $HOST_JS"
  exit 1
fi

install_manifest() {
  local dir="$1"
  mkdir -p "$dir"
  local manifest="$dir/${HOST_NAME}.json"

  python3 - "$manifest" "$EXTENSION_ID" "$NODE_BIN" "$HOST_JS" "$HOST_NAME" <<'PY'
import json, os, sys

manifest_path, extension_id, node_bin, host_js, host_name = sys.argv[1:6]
origin = f"chrome-extension://{extension_id}/"

origins = [origin]
if os.path.isfile(manifest_path):
    try:
        with open(manifest_path) as f:
            existing = json.load(f)
        for o in existing.get("allowed_origins", []):
            if o not in origins:
                origins.append(o)
    except (json.JSONDecodeError, OSError):
        pass

data = {
    "name": host_name,
    "description": "Job Auto-Apply Playwright automation host",
    "path": node_bin,
    "type": "stdio",
    "allowed_origins": origins,
    "args": [host_js],
}

with open(manifest_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

  echo "  → $manifest"
}

echo ""
echo "Installing native messaging host for extension: ${EXTENSION_ID}"
echo ""

# Default Chrome + Chromium install locations
install_manifest "${CHROME_NATIVE_MESSAGING_DIR:-$HOME/.config/google-chrome/NativeMessagingHosts}"
install_manifest "$HOME/.config/chromium/NativeMessagingHosts"
install_manifest "$HOME/.config/google-chrome-beta/NativeMessagingHosts"

# Custom user-data-dir profiles (launch-chrome-debug.sh uses this)
install_manifest "$HOME/.config/job-autoapply-chrome/NativeMessagingHosts"

if [[ -n "${CHROME_USER_DATA_DIR:-}" ]]; then
  install_manifest "${CHROME_USER_DATA_DIR}/NativeMessagingHosts"
fi

echo ""
echo "Done. Reload the extension in chrome://extensions, then click Retry connection."
echo "Start automation Chrome with:"
echo "  bash scripts/launch-chrome-debug.sh"
