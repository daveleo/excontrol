#!/bin/sh
# Local display: wait for the eXcontrol backend, then run Chromium full-screen under cage.
# Started by excontrol-kiosk.service on tty1 — not meant to be run over SSH.
set -eu

CONFIG="${EXCONTROL_DATA_DIR:-$HOME/excontrol-data}/excontrol.config.json"
PORT=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.app?.httpPort??8080))}catch{process.stdout.write("8080")}' "$CONFIG")
URL="http://localhost:$PORT"

# Don't show Chromium's error page on boot — wait (up to 60 s) for the backend.
i=0
until curl -fs -o /dev/null "$URL" || [ $i -ge 60 ]; do i=$((i + 1)); sleep 1; done

PROFILE="$HOME/.local/share/excontrol-kiosk"
mkdir -p "$PROFILE"
# A power cut mid-session marks the profile "crashed"; clear it so no restore bubble appears.
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
  "$PROFILE/Default/Preferences" 2>/dev/null || true

# cage draws its own cursor until a client takes the pointer — on a touch-only screen that
# never happens, so it sits mid-screen forever. Give cage (only) a theme whose cursors are a
# 1x1 transparent Xcursor; Chromium keeps the system theme, so a real mouse still shows one
# (the page hides it again on touch — frontend/src/lib/kiosk.ts).
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
exec cage -d -s -- env -u XCURSOR_PATH chromium \
  --kiosk "$URL/?kiosk=1" \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  --noerrdialogs --disable-infobars --no-first-run \
  --disable-session-crashed-bubble --hide-crash-restore-bubble \
  --disable-features=Translate,TranslateUI \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --password-store=basic \
  --check-for-update-interval=31536000
