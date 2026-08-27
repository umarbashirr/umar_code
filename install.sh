#!/bin/sh
# One command to put Tandem on a Linux machine:
#
#   curl -fsSL https://raw.githubusercontent.com/umarbashirr/umar_code/main/install.sh | sh
#
# It asks GitHub for the newest release over the public API, so there is no gh
# CLI to install and no account to log into. Debian and Ubuntu get the .deb,
# because that build sets up Chromium's setuid sandbox helper. Every other
# distro gets the AppImage unpacked into /opt/tandem, which lands in the layout
# the .deb produces: same binary path, same `tandem` on PATH, same desktop
# entry, same sandbox. Without root it all goes under ~/.local instead.
#
# The app ships this file and runs it with --file to install an update it has
# already downloaded, so there is one set of install steps rather than two.
#
# Flags, when piping:  ... | sh -s -- --user
set -eu

REPO=umarbashirr/umar_code
API=https://api.github.com/repos/$REPO/releases

VERSION=
LOCAL=
KIND=auto
FORCE=no
MODIFY_PATH=yes
ACTION=install

say()  { printf '%s\n' "$*"; }
step() { printf '\n> %s\n' "$*"; }
warn() { printf 'tandem: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<EOF
Install Tandem.

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh

Options:
  --user             install under ~/.local, no root, no password
  --system           unpack the AppImage into /opt even where a .deb would fit
  --deb              install the .deb (Debian, Ubuntu, and their relatives)
  --version X.Y.Z    install that release instead of the newest one
  --file PATH        install a .deb or AppImage already on disk
  --force            reinstall even if this version is already here
  --no-modify-path   do not touch shell startup files
  --uninstall        remove Tandem
  -h, --help         this
EOF
}

while [ $# -gt 0 ]; do
  case $1 in
    --user)           KIND=user ;;
    --system)         KIND=system ;;
    --deb)            KIND=deb ;;
    --version)        VERSION=${2:-}; shift ;;
    --version=*)      VERSION=${1#*=} ;;
    --file)           LOCAL=${2:-}; shift ;;
    --file=*)         LOCAL=${1#*=} ;;
    --force)          FORCE=yes ;;
    --no-modify-path) MODIFY_PATH=no ;;
    --uninstall)      ACTION=uninstall ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown option $1 (try --help)" ;;
  esac
  shift
done

if [ "$(uname -s)" != Linux ]; then
  die "this installer is for Linux. On macOS or Windows, take the build from https://github.com/$REPO/releases/latest"
fi

# ---------------------------------------------------------------- fetching

fetch() {
  if have curl; then curl -fsSL "$1"
  elif have wget; then wget -qO- "$1"
  else die "need curl or wget"
  fi
}

download() {
  if have curl; then curl -fL --progress-bar -o "$2" "$1"
  else wget -O "$2" "$1"
  fi
}

# ------------------------------------------------------------------- root
#
# Asked for once, up front, rather than in the middle of a 250MB download.
SUDO=
ROOT=no
if [ "$(id -u)" = 0 ]; then
  ROOT=yes
elif [ "$KIND" != user ] && have sudo; then
  say "Tandem installs system-wide, so this asks for your password once."
  if sudo -v 2>/dev/null; then
    SUDO=sudo
    ROOT=yes
  else
    warn "no root here, so this goes under ~/.local instead"
  fi
fi

PREFIX=/opt/tandem
BIN=/usr/bin/tandem
DESKTOP=/usr/share/applications/tandem.desktop
ICON=/usr/share/icons/hicolor/512x512/apps/tandem.png
if [ "$ROOT" = no ]; then
  PREFIX=$HOME/.local/lib/tandem
  BIN=$HOME/.local/bin/tandem
  DESKTOP=$HOME/.local/share/applications/tandem.desktop
  ICON=$HOME/.local/share/icons/hicolor/512x512/apps/tandem.png
fi

# --------------------------------------------------------------- uninstall

if [ "$ACTION" = uninstall ]; then
  step "Removing Tandem"
  # The system copy needs root to go; the one under ~/.local never does. Asking
  # for a password to delete files in a home directory would be theatre.
  if [ "$ROOT" = yes ]; then
    if have dpkg-query && dpkg-query -W -f='${Status}' tandem 2>/dev/null | grep -q 'install ok'; then
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get remove -y tandem
    fi
    for p in /opt/tandem /usr/bin/tandem /usr/share/applications/tandem.desktop \
             /usr/share/icons/hicolor/512x512/apps/tandem.png; do
      if [ -e "$p" ]; then $SUDO rm -rf "$p"; fi
    done
  elif [ -e /opt/tandem ] || [ -e /usr/bin/tandem ]; then
    warn "there is a system-wide Tandem in /opt, and this run has no root to remove it"
  fi
  rm -rf "$HOME/.local/lib/tandem" "$HOME/.local/bin/tandem" \
         "$HOME/.local/share/applications/tandem.desktop" \
         "$HOME/.local/share/icons/hicolor/512x512/apps/tandem.png"
  say "Gone. ~/.tandem still holds your settings and open-project state; delete it too if you want none of it back."
  exit 0
fi

# ----------------------------------------------------------------- install

install_deb() {
  step "Installing the package"
  if $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$FILE"; then return 0; fi
  # apt older than 1.1 will not take a path, and a dependency it cannot see yet
  # leaves dpkg half done. Both of those end in the same place.
  $SUDO dpkg -i "$FILE" || true
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get -f install -y
}

# The AppImage unpacks itself with its own runtime, so this works on a machine
# with no FUSE, and what comes out is the tree the .deb puts in /opt.
install_tree() {
  # dpkg would go on believing it owns /opt/tandem while these files sit on top
  # of its own, so the package goes first when there is one.
  if [ "$ROOT" = yes ] && have dpkg-query \
     && dpkg-query -W -f='${Status}' tandem 2>/dev/null | grep -q 'install ok'; then
    step "Removing the tandem package first"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get remove -y tandem || true
  fi

  step "Unpacking"
  # A file we downloaded can be unpacked where it lies. One handed to us with
  # --file belongs to whoever downloaded it, so it gets copied rather than
  # chmod +x'd in place.
  IMG=$FILE
  case "$FILE" in
    "$TMP"/*) ;;
    *) IMG=$TMP/tandem.AppImage; cp -f "$FILE" "$IMG" ;;
  esac
  chmod +x "$IMG"
  ( cd "$TMP" && "$IMG" --appimage-extract >/dev/null ) || die "could not unpack the AppImage"
  SRC=$TMP/squashfs-root
  [ -x "$SRC/tandem" ] || die "the AppImage did not hold what was expected"
  printf '%s' "$LATEST" > "$SRC/.tandem-version"

  step "Installing to $PREFIX"
  $SUDO rm -rf "$PREFIX.old"
  if [ -d "$PREFIX" ]; then $SUDO mv "$PREFIX" "$PREFIX.old"; fi
  $SUDO mkdir -p "$(dirname "$PREFIX")"
  $SUDO mv "$SRC" "$PREFIX"
  # squashfs carries its own modes, and some of those directories come out
  # readable only by whoever unpacked them.
  $SUDO chmod -R a+rX "$PREFIX"
  if [ "$ROOT" = yes ]; then
    $SUDO chown -R root:root "$PREFIX"
    # Chromium aborts unless its sandbox helper is root-owned and setuid, which
    # is the one part of this only root can arrange.
    if [ -f "$PREFIX/chrome-sandbox" ]; then $SUDO chmod 4755 "$PREFIX/chrome-sandbox"; fi
  fi

  # The CLI runs on the app's own Node, so a machine with no node installed
  # still gets a working `tandem`.
  $SUDO mkdir -p "$(dirname "$BIN")"
  printf '#!/usr/bin/env sh\nELECTRON_RUN_AS_NODE=1 exec "%s/tandem" \\\n  "%s/resources/app.asar.unpacked/cli/tandem.js" "$@"\n' \
    "$PREFIX" "$PREFIX" | $SUDO tee "$BIN" >/dev/null
  $SUDO chmod 755 "$BIN"

  EXEC="$PREFIX/tandem %U"
  if [ "$ROOT" = no ]; then EXEC="$PREFIX/tandem --no-sandbox %U"; fi
  $SUDO mkdir -p "$(dirname "$DESKTOP")" "$(dirname "$ICON")"
  $SUDO cp "$PREFIX/usr/share/icons/hicolor/512x512/apps/tandem.png" "$ICON" 2>/dev/null || true
  printf '%s\n' \
    '[Desktop Entry]' \
    'Name=Tandem' \
    'Comment=A terminal with an agent and a browser it can drive' \
    "Exec=$EXEC" \
    "Icon=$ICON" \
    'Terminal=false' \
    'Type=Application' \
    'StartupWMClass=tandem' \
    'Keywords=terminal;agent;browser;preview;claude;' \
    'Categories=Development;TerminalEmulator;' | $SUDO tee "$DESKTOP" >/dev/null
  $SUDO chmod 644 "$DESKTOP"
  if have update-desktop-database; then
    $SUDO update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true
  fi
  $SUDO rm -rf "$PREFIX.old"
}

# ------------------------------------------------------------- loose ends

finish() {
  # ~/.local/bin is on PATH on most desktops and on none of the small images.
  if [ "$KIND" = user ] && [ "$MODIFY_PATH" = yes ]; then
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *)
        case "${SHELL:-}" in
          */zsh)  RC=$HOME/.zshrc ;;
          */bash) RC=$HOME/.bashrc ;;
          *)      RC=$HOME/.profile ;;
        esac
        if ! grep -qs 'added by the tandem installer' "$RC"; then
          printf '\n# added by the tandem installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"
          say "Put ~/.local/bin on PATH in $RC. Open a new terminal, or run: export PATH=\"\$HOME/.local/bin:\$PATH\""
        fi
        ;;
    esac
  fi

  # A missing shared library shows up as a wordless crash at launch, so say which.
  BINARY=$PREFIX/tandem
  if [ "$KIND" = deb ]; then BINARY=/opt/tandem/tandem; fi
  MISSING=$(ldd "$BINARY" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ') || true
  if [ -n "${MISSING% }" ]; then
    warn "these libraries are missing: ${MISSING% }"
    if have dnf; then
      warn "try: sudo dnf install nss atk at-spi2-atk cups-libs libdrm mesa-libgbm gtk3 alsa-lib libsecret libnotify libXScrnSaver"
    elif have pacman; then
      warn "try: sudo pacman -S --needed nss atk at-spi2-atk libcups libdrm mesa gtk3 alsa-lib libsecret libnotify libxss"
    elif have zypper; then
      warn "try: sudo zypper install mozilla-nss libatk-1_0-0 cups-libs libdrm2 libgbm1 gtk3 libasound2 libsecret-1-0 libnotify4"
    fi
  fi

  if [ "$KIND" = user ]; then
    warn "installed without root, so Chromium's sandbox helper is not setuid and Tandem runs with --no-sandbox."
    warn "run this installer again where sudo works to get the sandboxed install."
  fi

  step "Tandem $LATEST is installed"
  cat <<EOF

  tandem .            open the folder you are in
  tandem ~/code/shop  open another one
  tandem go 3000      point the preview at a port

The agent runs the claude on your PATH, with the login you already have. If
\`claude --version\` answers in your terminal, the panel works. If nothing is
there yet: npm install -g @anthropic-ai/claude-code
EOF
}

scratch() {
  # /tmp is a RAM disk on many systems and unpacking needs about a gigabyte.
  TMP=$(mktemp -d "${TMPDIR:-/var/tmp}/tandem-install.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT INT TERM
  chmod 755 "$TMP"
}

# ------------------------------------------------------ a file already here
#
# How the app installs an update it has already downloaded: same steps, no
# second trip to GitHub.

if [ -n "$LOCAL" ]; then
  [ -f "$LOCAL" ] || die "no such file: $LOCAL"
  case "$(printf '%s' "$LOCAL" | tr 'A-Z' 'a-z')" in
    *.deb)      KIND=deb ;;
    *.appimage) if [ "$KIND" = auto ] || [ "$KIND" = deb ]; then KIND=system; fi ;;
    *) die "$LOCAL is neither a .deb nor an AppImage" ;;
  esac
  if [ "$KIND" != user ] && [ "$ROOT" = no ]; then die "installing $LOCAL needs root"; fi
  LATEST=$(basename "$LOCAL" | sed -n 's/^[^0-9]*\([0-9][0-9.]*[0-9]\).*/\1/p')
  [ -n "$LATEST" ] || LATEST=unknown
  FILE=$LOCAL
  scratch
  say "Installing Tandem $LATEST from $LOCAL"
  case $KIND in
    deb) install_deb ;;
    *)   install_tree ;;
  esac
  finish
  exit 0
fi

# ------------------------------------------------------- release and asset

case "$(uname -m)" in
  x86_64|amd64)  ARCH_WORDS='x86_64 amd64 x64' ;;
  aarch64|arm64) ARCH_WORDS='aarch64 arm64' ;;
  *) die "no build for $(uname -m)" ;;
esac

if [ "$KIND" = auto ]; then
  if [ "$ROOT" = yes ] && have dpkg && have apt-get; then KIND=deb
  elif [ "$ROOT" = yes ]; then KIND=system
  else KIND=user
  fi
fi
if [ "$KIND" = deb ] && ! have apt-get; then die "--deb needs apt-get; try --system"; fi
if [ "$KIND" != user ] && [ "$ROOT" = no ]; then die "--$KIND needs root; try --user"; fi

step "Looking up the release"
if [ -n "$VERSION" ]; then
  JSON=$(fetch "$API/tags/v${VERSION#v}") || die "there is no release v${VERSION#v}"
else
  JSON=$(fetch "$API/latest") || die "could not reach GitHub. Are you online?"
fi

TAG=$(printf '%s\n' "$JSON" | grep -m1 '"tag_name"' | sed 's/.*: *"//; s/".*//') || true
[ -n "$TAG" ] || die "GitHub answered with a release that has no tag"
LATEST=${TAG#v}
URLS=$(printf '%s\n' "$JSON" | grep '"browser_download_url"' | sed 's/.*: *"//; s/".*//') || true

# Releases were once named pba-* and are now tandem-*, so the asset is found by
# its extension and the architecture in its name, never by the product name.
pick() {
  want=$1
  for u in $URLS; do
    name=$(printf '%s' "${u##*/}" | tr 'A-Z' 'a-z')
    case "$name" in *"$want") ;; *) continue ;; esac
    for w in $ARCH_WORDS; do
      case "$name" in *"$w"*) printf '%s' "$u"; return 0 ;; esac
    done
  done
  return 1
}

if [ "$KIND" = deb ]; then WANT=.deb; else WANT=.appimage; fi
ASSET=$(pick "$WANT") || die "release $TAG has no $WANT build for $(uname -m)"
say "Tandem $LATEST, $(basename "$ASSET")"

# Already here? A quarter of a gigabyte is worth one version check first.
if [ "$FORCE" = no ]; then
  if [ "$KIND" = deb ] && have dpkg-query; then
    HERE=$(dpkg-query -W -f='${Version}' tandem 2>/dev/null || true)
  else
    HERE=$(cat "$PREFIX/.tandem-version" 2>/dev/null || true)
  fi
  if [ "$HERE" = "$LATEST" ]; then
    say "Already on $LATEST. Nothing to do, and --force if you disagree."
    exit 0
  fi
fi

scratch
FILE=$TMP/$(basename "$ASSET")

step "Downloading"
download "$ASSET" "$FILE" || die "the download failed"
chmod 644 "$FILE"

case $KIND in
  deb) install_deb ;;
  *)   install_tree ;;
esac

finish
