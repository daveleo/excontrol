#!/bin/sh
# Load a simulated setup into this unit's config: devices, groups, presets and schedule are
# replaced; the app section (port, access password, name) is kept. The previous config (and
# device cache) is backed up next to it.
#   ./pi/demo/apply.sh [dir]      dir holds excontrol.config.json (+ optional
#                                 excontrol.device-cache.json); default: this folder
#   then: sudo systemctl restart excontrol
set -eu
SRC=$(cd "${1:-$(dirname "$0")}" && pwd)
DATA="${EXCONTROL_DATA_DIR:-$HOME/excontrol-data}"
CFG="$DATA/excontrol.config.json"
CACHE="$DATA/excontrol.device-cache.json"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DATA"
[ -f "$CFG" ] && cp "$CFG" "$CFG.bak-$STAMP"
node -e '
  const fs = require("fs");
  const [demoPath, cfgPath] = process.argv.slice(1);
  const demo = JSON.parse(fs.readFileSync(demoPath, "utf8"));
  const cur = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cur, ...demo, app: cur.app ?? demo.app }, null, 2));
' "$SRC/excontrol.config.json" "$CFG"
# A copied cache gives simulated devices real preset / scene names (drivers/sim.ts).
if [ -f "$SRC/excontrol.device-cache.json" ]; then
  [ -f "$CACHE" ] && cp "$CACHE" "$CACHE.bak-$STAMP"
  cp "$SRC/excontrol.device-cache.json" "$CACHE"
fi
echo "config from $SRC written to $DATA"
