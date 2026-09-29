#!/bin/sh
# Dev install on a Pi running from a git checkout: installs + starts the backend service and
# the local-display kiosk. Run from anywhere:  sudo ./pi/install.sh [user]
# (P1 replaces this with a .deb that installs to /opt/excontrol with its own system user.)
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=${1:-${SUDO_USER:-$(id -un)}}
USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
DATA_DIR=${EXCONTROL_DATA_DIR:-$USER_HOME/excontrol-data}

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v cage >/dev/null && command -v chromium >/dev/null && command -v keyd >/dev/null || apt-get install -y cage chromium keyd

chmod +x "$APP_DIR/pi/kiosk.sh" "$APP_DIR/pi/touch-reset.sh"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$DATA_DIR"
# kiosk lockdown: no DevTools, no other URLs, no files/printing/downloads (keyboard at the kiosk)
install -d /etc/chromium/policies/managed
install -m 0644 "$APP_DIR/pi/chromium-policy.json" /etc/chromium/policies/managed/excontrol.json
# …and browser shortcuts from physical keyboards (Ctrl+N opened a full browser window)
install -d /etc/keyd
install -m 0644 "$APP_DIR/pi/keyd-kiosk.conf" /etc/keyd/default.conf
systemctl enable keyd >/dev/null 2>&1
systemctl restart keyd
for unit in excontrol.service excontrol-kiosk.service; do
  sed -e "s|@USER@|$USER_NAME|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    "$APP_DIR/pi/systemd/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable excontrol.service excontrol-kiosk.service
systemctl restart excontrol.service excontrol-kiosk.service
echo "installed: app=$APP_DIR user=$USER_NAME data=$DATA_DIR"
