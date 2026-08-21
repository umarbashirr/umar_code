#!/usr/bin/env bash
# One-time setup so Chromium can sandbox the preview pane.
set -euo pipefail
HELPER="$(node -p "require('path').dirname(require('electron'))")/chrome-sandbox"
echo "Setting up $HELPER (needs sudo)"
sudo chown root:root "$HELPER"
sudo chmod 4755 "$HELPER"
echo "Done. Run npm start again."
