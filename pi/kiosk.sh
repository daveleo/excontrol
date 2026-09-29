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

# cage: -d no client decorations, -s allow VT switching (Ctrl+Alt+F2 for a console).
exec cage -d -s -- chromium \
  --kiosk "$URL" \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  --noerrdialogs --disable-infobars --no-first-run \
  --disable-session-crashed-bubble --hide-crash-restore-bubble \
  --disable-features=Translate,TranslateUI \
  --overscroll-history-navigation=0 \
  --password-store=basic \
  --check-for-update-interval=31536000
