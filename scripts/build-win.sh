#!/usr/bin/env bash
# The Windows installer, built on Linux.
#
# electron-builder needs wine to make an NSIS installer, and this machine is
# unlikely to have it, so the build happens inside the image that does. The
# renderer is already built by the npm script that calls this.
#
# What makes the cross-build honest rather than a Linux binary in a .exe:
# node-pty 1.1.0 ships N-API prebuilds for win32-x64 in its own npm package.
# N-API is ABI-stable across node and electron versions, so nothing needs to
# compile on Windows. --npmRebuild=false is what keeps it that way; a rebuild
# here would overwrite the win32 prebuild with one built for this machine.
#
# The other half is in package.json, under build.win.files: node-pty's build/
# and bin/ hold linux binaries on a linux host, and its loader checks
# build/Release before prebuilds. Windows survives them by failing the require
# and falling through, which is a fallback rather than a plan, so the win
# target leaves both out. electron-builder rejects unknown keys in its config,
# so that exclusion cannot carry its own comment.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# An absolute argument is taken as given; a relative one hangs off the repo, so
# the bare `npm run dist:win:docker` still writes to dist/ like the others.
case "${1:-dist}" in
  /*) OUT=$1 ;;
  *)  OUT=$ROOT/${1:-dist} ;;
esac
mkdir -p "$OUT"

# The container runs as root, so a previous run left root-owned files behind
# and electron-builder cannot clear them. Take them back before starting
# rather than after, which is the half that only helps the run that succeeded.
own() {
  [ "$(id -u)" = "0" ] && return 0
  docker run --rm -v "$OUT":/out alpine chown -R "$(id -u):$(id -g)" /out 2>/dev/null || true
}
own

# The electron and electron-builder caches are shared with the host so a second
# run does not pull another 100MB of electron.
docker run --rm \
  -v "$ROOT":/project \
  -v "$OUT":/out \
  -v "${HOME}/.cache/electron":/root/.cache/electron \
  -v "${HOME}/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder:wine \
  /bin/bash -c "cd /project && npx electron-builder --win nsis -c.npmRebuild=false -c.directories.output=/out"

own

echo "built:"
ls -1 "$OUT"/*.exe 2>/dev/null || echo "  no .exe produced"
