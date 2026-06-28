#!/usr/bin/env bash
#
# Control Center - one-click starter.
#   • Double-click in Finder, or run:  ./start.command
#   • Installs deps on first run, starts the server, opens the browser when it's ready.
#   • Ctrl-C stops the server. Set a different port with:  PORT=4000 ./start.command
#
set -euo pipefail

# Always run from the project directory (works when double-clicked, too).
cd "$(dirname "$0")"

PORT="${PORT:-3137}"
export PORT
URL="http://127.0.0.1:${PORT}"

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"            # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"  # Linux
  else echo "→ Open $1 in your browser."; fi
}

# If a dashboard is already running on this port, just open it.
if curl -fs "$URL/api/health" >/dev/null 2>&1; then
  echo "Control Center already running at $URL"
  open_url "$URL"
  exit 0
fi

# Check prerequisites early with a friendly message.
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required but was not found on your PATH. Install Node 18+ and retry." >&2
  exit 1
fi

# Install dependencies on first run.
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

# Open the browser once the server is actually responding (in the background).
(
  for _ in $(seq 1 60); do
    if curl -fs "$URL/api/health" >/dev/null 2>&1; then
      open_url "$URL"
      exit 0
    fi
    sleep 0.5
  done
  echo "Open $URL manually if the browser did not open."
) &

echo "Starting Control Center on $URL  (press Ctrl-C to stop)"
exec node server.js
