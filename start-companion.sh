#!/bin/sh
# Starts the Melvor Idle 2 Companion on macOS / Linux.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "The companion needs Node.js. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
exec node server/server.js "$@"
