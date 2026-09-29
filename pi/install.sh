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
command -v cage >/dev/null && command -v chromium >/dev/null || apt-get install -y cage chromium

chmod +x "$APP_DIR/pi/kiosk.sh"
install -d -o "$USER_NAME" -g "$USER_NAME" "$DATA_DIR"
for unit in excontrol.service excontrol-kiosk.service; do
  sed -e "s|@USER@|$USER_NAME|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    "$APP_DIR/pi/systemd/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable excontrol.service excontrol-kiosk.service
systemctl restart excontrol.service excontrol-kiosk.service
echo "installed: app=$APP_DIR user=$USER_NAME data=$DATA_DIR"
