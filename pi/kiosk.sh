#!/bin/sh
# Local display: wait for the eXcontrol backend, then run Chromium full-screen under cage.
# Started by excontrol-kiosk.service on tty1 — not meant to be run over SSH.
set -eu

CONFIG="${EXCONTROL_DATA_DIR:-$HOME/excontrol-data}/excontrol.config.json"
PORT=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.app?.httpPort??8080))}catch{process.stdout.write("8080")}' "$CONFIG")
URL="http://localhost:$PORT"
# The local screen is the customer's: the simple view (power, schedule, preset pictures).
# EXCONTROL_KIOSK_VIEW=full (e.g. a systemd drop-in) shows the installer dashboard instead.
QUERY="kiosk=1"
[ "${EXCONTROL_KIOSK_VIEW:-simple}" = "simple" ] && QUERY="$QUERY&view=simple"

# Wait for the backend however long it takes. With a time limit (it was 60 s), a backend that
# is slow or crash-looping at boot left the customer looking at Chromium's white "This site
# can't be reached — ERR_CONNECTION_REFUSED" page (measured). A dark screen until the app is
# ready is better; once the page is loaded, the app handles backend restarts itself.
i=0
until curl -fs -o /dev/null "$URL"; do
  i=$((i + 1))
  [ $((i % 30)) -eq 0 ] && echo "kiosk: still waiting for the backend at $URL (${i} s)"
  sleep 1
done

PROFILE="$HOME/.local/share/excontrol-kiosk"
mkdir -p "$PROFILE"
# A power cut mid-session marks the profile "crashed"; clear it so no restore bubble appears.
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
  "$PROFILE/Default/Preferences" 2>/dev/null || true

# Chromium takes pointer focus at start-up and shows its theme's arrow mid-screen, and Blink
# won't apply the page's `cursor: none` until a real mouse moves — which never happens on a
# touch-only screen. So cage AND Chromium get a theme whose every cursor is a 1x1 transparent
# Xcursor; when a real mouse is used, the page switches on its own CSS-image arrow, which
# Chromium draws independently of the theme (frontend/src/lib/kiosk.ts).
HIDDEN="$PROFILE/hidden-cursor"
if [ ! -s "$HIDDEN/default/cursors/default" ]; then
  mkdir -p "$HIDDEN/default/cursors"
  node -e '
    const b = Buffer.alloc(16 + 12 + 36 + 4);          // header, 1 TOC entry, image chunk, 1 px
    b.write("Xcur", 0); b.writeUInt32LE(16, 4); b.writeUInt32LE(0x10000, 8); b.writeUInt32LE(1, 12);
    b.writeUInt32LE(0xfffd0002, 16); b.writeUInt32LE(24, 20); b.writeUInt32LE(28, 24);
    [36, 0xfffd0002, 24, 1, 1, 1, 0, 0, 0].forEach((v, i) => b.writeUInt32LE(v, 28 + i * 4));
    require("fs").writeFileSync(process.argv[1], b);  // pixel stays 0x00000000 = transparent
  ' "$HIDDEN/default/cursors/default"
  ln -sf default "$HIDDEN/default/cursors/left_ptr"
fi

# cage: -d no client decorations, -s allow VT switching (Ctrl+Alt+F2 for a console).
export XCURSOR_PATH="$HIDDEN"
exec cage -d -s -- chromium \
  --kiosk "$URL/?$QUERY" \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  --noerrdialogs --disable-infobars --no-first-run \
  --disable-session-crashed-bubble --hide-crash-restore-bubble \
  --disable-features=Translate,TranslateUI \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --password-store=basic \
  --check-for-update-interval=31536000 \
  ${EXCONTROL_KIOSK_FLAGS:-}
# EXCONTROL_KIOSK_FLAGS: extra Chromium flags from a root-owned systemd drop-in — e.g. the
# test rig's --remote-debugging-port=9222 (DevTools protocol, localhost only). Never in a
# shipped image.
