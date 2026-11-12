#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 20+ required. Install from https://nodejs.org/en/download'
  exit 1
fi
node server.js
