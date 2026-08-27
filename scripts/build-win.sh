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
# The installer does carry node-pty's linux build/ and bin/, which are dead
# weight on Windows. That is deliberate. Excluding them needs a files list on
# the win target, and a platform files list replaces the top-level allowlist
# rather than adding to it, so a negation-only one turns the build into
# "everything except", packs dist/ into the asar and produces a 1.7GB
# installer. node-pty's loader tries build/Release first, fails the require on
# a linux binary, and falls through to prebuilds/win32-x64 by design, so the
# megabyte is cheaper than the footgun.
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
