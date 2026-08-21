#!/bin/bash
# electron-builder expands ${productFilename} to the executable name, but a
# product name with spaces installs to /opt/Preview Browser for Agent. Ask dpkg
# where the files actually went instead of guessing.
PKG=preview-browser-for-agent
INSTALL_DIR=""

SANDBOX=$(dpkg -L "$PKG" 2>/dev/null | grep -m1 '/chrome-sandbox$')
[ -n "$SANDBOX" ] && INSTALL_DIR=$(dirname "$SANDBOX")

if [ -z "$INSTALL_DIR" ]; then
  for candidate in "/opt/Preview Browser for Agent" "/opt/${productFilename}" "/opt/$PKG"; do
    if [ -d "$candidate" ]; then INSTALL_DIR="$candidate"; break; fi
  done
fi

if [ -z "$INSTALL_DIR" ] || [ ! -x "$INSTALL_DIR/preview-browser-for-agent" ]; then
  echo "pba: could not locate the installed app; skipping sandbox and CLI setup" >&2
  exit 0
fi

# Chromium's sandbox helper has to be setuid root or the app refuses to start.
if [ -f "$INSTALL_DIR/chrome-sandbox" ]; then
  chown root:root "$INSTALL_DIR/chrome-sandbox" && chmod 4755 "$INSTALL_DIR/chrome-sandbox" \
    || echo "pba: could not set up $INSTALL_DIR/chrome-sandbox" >&2
fi

# Put the pba CLI on PATH, running it through the app's own Node.
cat > /usr/bin/pba <<EOF
#!/usr/bin/env sh
ELECTRON_RUN_AS_NODE=1 exec "$INSTALL_DIR/preview-browser-for-agent" \\
  "$INSTALL_DIR/resources/app.asar.unpacked/cli/pba.js" "\$@"
EOF
chmod 755 /usr/bin/pba
