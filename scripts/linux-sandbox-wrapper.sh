#!/bin/sh
# Chromium aborts if chrome-sandbox exists but is not root-owned and setuid.
# AppImage FUSE mounts are nosuid, so the helper is almost never usable there.
# Same rule as scripts/launch.js and cli/tandem.js: pass --no-sandbox only then.
DIR=$(cd "$(dirname "$0")" && pwd)
BASE=$(basename "$0")
REAL="$DIR/$BASE.real"
HELPER="$DIR/chrome-sandbox"

if [ -n "$ELECTRON_RUN_AS_NODE" ]; then
  exec "$REAL" "$@"
fi

for arg in "$@"; do
  if [ "$arg" = "--no-sandbox" ]; then
    exec "$REAL" "$@"
  fi
done

usable=0
if [ -f "$HELPER" ] && [ -u "$HELPER" ]; then
  owner=$(stat -c %u "$HELPER" 2>/dev/null) || owner=
  if [ "$owner" = 0 ]; then
    usable=1
  fi
fi

if [ "$usable" = 1 ]; then
  exec "$REAL" "$@"
fi
exec "$REAL" --no-sandbox "$@"
