#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

chmod +x "$0" 2>/dev/null || true

PORT="${PORT:-3456}"
URL="http://localhost:${PORT}"

EXISTING_PIDS="$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "${EXISTING_PIDS}" ]; then
  echo "Stopping previous gCut instance on port ${PORT} (PID: ${EXISTING_PIDS})..."
  echo "${EXISTING_PIDS}" | xargs kill -TERM 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      break
    fi
    sleep 0.15
  done
  STILL_RUNNING="$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "${STILL_RUNNING}" ]; then
    echo "${STILL_RUNNING}" | xargs kill -9 2>/dev/null || true
    sleep 0.2
  fi
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
