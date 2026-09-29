#!/bin/sh
# Load the simulated showroom (pi/demo/excontrol.config.json) into this unit's config:
# devices, groups, presets and schedule are replaced; the app section (port, access
# password, name) is kept. The previous config is backed up next to it.
#   ./pi/demo/apply.sh            (then: sudo systemctl restart excontrol)
set -eu
DEMO="$(cd "$(dirname "$0")" && pwd)/excontrol.config.json"
CFG="${EXCONTROL_DATA_DIR:-$HOME/excontrol-data}/excontrol.config.json"
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] && cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
node -e '
  const fs = require("fs");
  const [demoPath, cfgPath] = process.argv.slice(1);
  const demo = JSON.parse(fs.readFileSync(demoPath, "utf8"));
  const cur = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cur, ...demo, app: cur.app ?? demo.app }, null, 2));
' "$DEMO" "$CFG"
echo "demo config written to $CFG"
