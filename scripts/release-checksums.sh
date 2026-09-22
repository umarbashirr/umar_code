#!/bin/sh
# SHA256SUMS for the installers in a dist directory.
set -eu
dir=${1:-dist}
cd "$dir"
found=0
set --
for f in tandem-*.exe tandem-*.deb tandem-*.AppImage tandem-*.dmg; do
  [ -f "$f" ] || continue
  found=1
  set -- "$@" "$f"
done
if [ "$found" -eq 0 ]; then
  echo "no release artifacts in $dir" >&2
  exit 1
fi
sha256sum "$@" > SHA256SUMS
echo "wrote $dir/SHA256SUMS"
