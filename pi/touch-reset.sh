#!/bin/sh
# Re-enumerate USB touch panels once per boot — the software equivalent of re-plugging them.
#
# Why: on a cold boot the panel (seen with an iiyama / Pixart "Optical Touch" 093a:8020) is
# first bound by hid-generic, then re-bound by hid-multitouch ~1 s later, while the panel has
# only just powered up. Touch then stays dead until the USB cable is re-plugged. A replug —
# i.e. a fresh enumeration once the panel is awake, with hid-multitouch already loaded — fixes
# it, so this does exactly that: USB deauthorize → authorize.
#
# Run as root before the kiosk (excontrol-kiosk.service ExecStartPre=+…). Generic: acts on
# every USB device that provides an input with ID_INPUT_TOUCHSCREEN=1. Idempotent per boot.
set -u

FLAG=/run/excontrol-touch-reset.done
[ -e "$FLAG" ] && exit 0
: > "$FLAG"

# give the panel time to wake up and late module loads (hid-multitouch) time to finish
MIN_UPTIME=15
up=$(cut -d. -f1 /proc/uptime)
[ "$up" -lt "$MIN_UPTIME" ] && sleep $((MIN_UPTIME - up))
udevadm settle -t 10 || true

found=""
for ev in /sys/class/input/event*; do
  udevadm info -q property -p "$ev" 2>/dev/null | grep -qx 'ID_INPUT_TOUCHSCREEN=1' || continue
  p=$(readlink -f "$ev/device")
  # walk up to the USB device node (the one with idVendor + authorized)
  while [ "$p" != "/" ] && [ ! -e "$p/idVendor" ]; do p=$(dirname "$p"); done
  [ -e "$p/authorized" ] || continue
  case " $found " in *" $p "*) ;; *) found="$found $p" ;; esac
done

for dev in $found; do
  logger -t excontrol-touch "re-enumerating USB touch panel $(cat "$dev/idVendor"):$(cat "$dev/idProduct") \"$(cat "$dev/product" 2>/dev/null)\" at $dev"
  echo 0 > "$dev/authorized"
  sleep 1
  echo 1 > "$dev/authorized"
done
[ -n "$found" ] && { udevadm settle -t 10 || true; sleep 1; }
[ -z "$found" ] && logger -t excontrol-touch "no USB touch panel found"
exit 0
