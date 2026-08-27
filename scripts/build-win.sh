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
set -euo pipefail

OUT=${1:-dist}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/$OUT"

# The electron and electron-builder caches are shared with the host so a second
# run does not pull another 100MB of electron.
docker run --rm \
  -v "$ROOT":/project \
  -v "$ROOT/$OUT":/out \
  -v "${HOME}/.cache/electron":/root/.cache/electron \
  -v "${HOME}/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder:wine \
  /bin/bash -c "cd /project && npx electron-builder --win nsis -c.npmRebuild=false -c.directories.output=/out"

# The container runs as root, so anything it wrote is root-owned on the host.
if [ "$(id -u)" != "0" ]; then
  docker run --rm -v "$ROOT/$OUT":/out alpine chown -R "$(id -u):$(id -g)" /out || true
fi

echo "built:"
ls -1 "$ROOT/$OUT"/*.exe 2>/dev/null || echo "  no .exe produced"
