#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

chmod +x "$0" 2>/dev/null || true

PORT="${PORT:-3456}"
URL="http://localhost:${PORT}"

if lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "gCut is already running on ${URL}"
  if [ "${GCUT_NO_OPEN:-0}" != "1" ]; then
    open "${URL}"
  fi
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed. Install with: brew install node"
  read -r -p "Press Enter to exit..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

(
  for _ in $(seq 1 40); do
    if curl -s "${URL}/api/system/status" >/dev/null 2>&1; then
      if [ "${GCUT_NO_OPEN:-0}" != "1" ]; then
        open "${URL}"
      fi
      break
    fi
    sleep 0.25
  done
) &

echo "Starting gCut on ${URL}..."
exec node server.js
