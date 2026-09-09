#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or later is required. Install Node, then open this file again."
  read -r -p "Press Enter to close."
  exit 1
fi
exec node scripts/launch.mjs
