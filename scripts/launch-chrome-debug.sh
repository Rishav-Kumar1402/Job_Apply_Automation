#!/usr/bin/env bash
# Start Google Chrome with remote debugging for Playwright CDP attach.
#
# Chrome 136+ requires BOTH:
#   --remote-debugging-port=9222
#   --user-data-dir=<non-default path>
# without a custom user-data-dir, debugging is disabled and port 9222 never opens.
#
# Chrome must be fully quit first.

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"

# Dedicated automation profile (recommended). Persists logins between runs.
USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$HOME/.config/job-autoapply-chrome}"

# Set USE_MAIN_PROFILE=1 to reuse your normal Chrome profile (must quit Chrome first).
if [[ "${USE_MAIN_PROFILE:-0}" == "1" ]]; then
  USER_DATA_DIR="${HOME}/.config/google-chrome"
  PROFILE_DIR="${CHROME_PROFILE_DIR:-Default}"
  PROFILE_ARGS=(--profile-directory="$PROFILE_DIR")
else
  PROFILE_ARGS=()
fi

CHROME=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CHROME="$candidate"
    break
  fi
done

if [[ -z "$CHROME" ]]; then
  echo "ERROR: google-chrome or chromium not found in PATH"
  exit 1
fi

if pgrep -f '/opt/google/chrome/chrome' >/dev/null 2>&1 || pgrep -x chrome >/dev/null 2>&1; then
  echo "Chrome is already running. Quit it completely first:"
  echo ""
  echo "  pkill -f '/opt/google/chrome/chrome'"
  echo ""
  echo "Then run this script again."
  exit 1
fi

mkdir -p "$USER_DATA_DIR"

echo "Starting Chrome for Job Auto-Apply..."
echo "  user-data-dir: $USER_DATA_DIR"
echo "  debug port:    $CDP_PORT"
echo ""

"$CHROME" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins=* \
  --user-data-dir="$USER_DATA_DIR" \
  "${PROFILE_ARGS[@]}" \
  "$@" \
  >/dev/null 2>&1 &

CHROME_PID=$!

for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    echo "Remote debugging is active on port $CDP_PORT"
    echo ""
    if [[ "${USE_MAIN_PROFILE:-0}" != "1" && ! -d "$USER_DATA_DIR/Default/Local Extension Settings" ]]; then
      echo "First time with this profile:"
      echo "  1. Log into LinkedIn / Naukri"
      echo "  2. Load the extension at chrome://extensions (Load unpacked → packages/extension/dist)"
      echo "  3. Run the native host install script if not already done"
    else
      echo "Log into LinkedIn/Naukri if needed, then start applying from the extension."
    fi
    exit 0
  fi
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "ERROR: Chrome exited immediately. Try running manually:"
    echo ""
    echo "  $CHROME --remote-debugging-port=$CDP_PORT --remote-allow-origins=* --user-data-dir=\"$USER_DATA_DIR\""
    exit 1
  fi
  sleep 1
done

echo "ERROR: Port $CDP_PORT is not responding after 30s."
echo "Check that no firewall blocks localhost, then try:"
echo ""
echo "  $CHROME --remote-debugging-port=$CDP_PORT --remote-allow-origins=* --user-data-dir=\"$USER_DATA_DIR\""
exit 1
