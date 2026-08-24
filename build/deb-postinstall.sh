#!/bin/bash
# ${productFilename} is only set while electron-builder is running, and an
# upgrade from an older package may have left the app somewhere else. Ask dpkg
# where the files actually went instead of guessing.
PKG=tandem
INSTALL_DIR=""

SANDBOX=$(dpkg -L "$PKG" 2>/dev/null | grep -m1 '/chrome-sandbox$')
[ -n "$SANDBOX" ] && INSTALL_DIR=$(dirname "$SANDBOX")

if [ -z "$INSTALL_DIR" ]; then
  for candidate in "/opt/${productFilename}" "/opt/$PKG"; do
    if [ -d "$candidate" ]; then INSTALL_DIR="$candidate"; break; fi
  done
fi

if [ -z "$INSTALL_DIR" ] || [ ! -x "$INSTALL_DIR/tandem" ]; then
  echo "tandem: could not locate the installed app; skipping sandbox and CLI setup" >&2
  exit 0
fi

# Chromium's sandbox helper has to be setuid root or the app refuses to start.
if [ -f "$INSTALL_DIR/chrome-sandbox" ]; then
  chown root:root "$INSTALL_DIR/chrome-sandbox" && chmod 4755 "$INSTALL_DIR/chrome-sandbox" \
    || echo "tandem: could not set up $INSTALL_DIR/chrome-sandbox" >&2
fi

# Put the tandem CLI on PATH, running it through the app's own Node.
cat > /usr/bin/tandem <<EOF
#!/usr/bin/env sh
ELECTRON_RUN_AS_NODE=1 exec "$INSTALL_DIR/tandem" \\
  "$INSTALL_DIR/resources/app.asar.unpacked/cli/tandem.js" "\$@"
EOF
chmod 755 /usr/bin/tandem
