# eXcontrol on Raspberry Pi — kiosk appliance (branch `pi-kiosk`)

Goal: a self-contained, commercial-grade eXcontrol appliance on Raspberry Pi 5. It is reachable
on the network exactly like the Windows build, can drive a local monitor or touchscreen (ELO,
USB HID), and keeps running through power cuts and bad networks.

## Platform decision

**Raspberry Pi OS Lite (64-bit, Debian 13 "Trixie")**. No desktop environment.

- It has first-party support for Pi 5 firmware, the EEPROM bootloader, RP1, the RTC and
  hardware video. No other distro matches it.
- It is Debian underneath: apt, systemd, NetworkManager, and `.deb` packaging.
- For the display, **cage** (a single-app Wayland kiosk compositor) runs **Chromium** in
  `--kiosk` mode against `http://localhost:<port>`. There is no desktop, panel or login screen.
- It has a clear path to a golden image: `rpi-image-gen` / `pi-gen` build the image in CI,
  and the same image can later be used on Compute Module 5 (eMMC) for volume production.

Rejected options: Ubuntu Server/Core (weaker Pi 5 support, snaps), Yocto/Buildroot (the best
possible appliance, but months of BSP work, so revisit only at fleet scale), BalenaOS (cloud
lock-in), and Electron on Pi (not needed, because the backend is plain Node and Chromium is the UI).

The port is cheap because the backend is pure JS (fastify, ws, obs-websocket-js, fflate,
crypto-js) with no native modules, and the data directory already comes from
`EXCONTROL_DATA_DIR`.

## Recommended hardware (per unit)

- Pi 5 (4 GB is plenty; 8 GB for dev), official 27 W PSU, active cooler or passive metal case
- **RTC battery** (official ML-2020). The scheduler depends on correct time, and without
  it a site with no NTP boots at the wrong time.
- Storage: NVMe via M.2 HAT+ (preferred) or an industrial/high-endurance SD card
- Optional: PoE+ HAT (one cable per install)
- For volume production later: **CM5 with eMMC** on an industrial/DIN-rail carrier

## Roadmap

### P0 — Smoke test (today)
Run the backend + UI from source on Pi OS Lite. Point it only at test devices, never at the
showroom (the showroom's own eXcontrol is the only instance allowed against it).

### P1 — Linux platform layer
- Data dir `/var/lib/excontrol`, dedicated `excontrol` system user, logs to journald
- `excontrol.service` (systemd, `Restart=always`, hardening: `ProtectSystem=strict`,
  `NoNewPrivileges`, …)
- Bundle a pinned Node 22 arm64 runtime in `/opt/excontrol` (Debian's nodejs is too old
  for `engines >=22`, and bundling makes builds deterministic)
- `.deb` (arm64) package built in GitHub Actions on `ubuntu-24.04-arm` (nfpm)
- Make the platform-specific bits OS-aware: Setup's autostart toggle, the updater, and
  diagnostics system info

### P2 — Local display / kiosk
- `excontrol-kiosk.service`: cage + Chromium on tty1, auto-restart, hidden cursor, no
  crash/restore bubbles, no translate prompts, and a blank-screen guard
- ELO / USB touch works through libinput with no driver. Rotation and scaling are settings
  (wlr-randr/kanshi)
- A **kiosk UI mode** in the frontend: large touch targets, no hover-only affordances, and an
  on-screen keyboard for text fields (cage has no OSK)
- Display follows the power state / scheduler (panel off at night via DPMS)
- **Commissioning screen** when unconfigured: IP address, hostname, and a QR code linking to the setup URL
- Localhost-trust option: the local display skips the access password (configurable)

### P3 — Network
- NetworkManager, two profiles on `eth0`:
  1. `excontrol-dhcp`: `ipv4.method auto`, `dhcp-timeout 20`, higher autoconnect priority
  2. `excontrol-fallback`: `192.168.0.99/24`, lower priority. It activates when DHCP fails,
     and a timer retries DHCP periodically
- Setup › Network page: DHCP/static, IP/mask/gateway/DNS, hostname, NTP server
- **Apply with auto-rollback**: a new IP must be confirmed from the new address within 90 s,
  otherwise it reverts. This is a must-have so a remote change can't brick the unit.
- Changes go through a small privileged helper (polkit-scoped `nmcli`), not a root backend
- mDNS via avahi: `excontrol.local` / `<hostname>.local`
- Wi-Fi and Bluetooth off by default

### P4 — Appliance hardening
- Read-only root (overlayfs) plus a separate writable data partition. Config writes are
  already tmp+rename; add fsync of the file and directory
- Hardware watchdog (`RuntimeWatchdogSec`) and a service health check
- nftables firewall (only the eXcontrol port + mDNS; SSH closed unless enabled in the UI)
- **Factory reset**: long-press a GPIO button, or drop `excontrol-reset` on the boot partition
- Network/config seeding from the boot partition (`excontrol-network.txt`) for installers
- Branded boot: quiet kernel, Plymouth splash, no rainbow screen

### P5 — Golden image
- `rpi-image-gen` in CI produces `excontrol-pi-<ver>.img.xz`, flashed with Raspberry Pi Imager
  (optionally from a custom Imager repo JSON)
- The first boot expands the data partition, generates unique secrets and hostname
  (`excontrol-<serial4>`), and shows the commissioning screen

### P6 — Updates
- Stage A: an own apt repo (GitHub Pages) or a signed `.deb` fetched by the existing update
  checker. The UI's *Install now* calls a privileged updater
- Stage B (fleet scale): A/B rootfs with RAUC or Mender, with automatic rollback on failed boot

### P7 — Validation
72 h soak, 100× power-yank test, thermal in the target enclosure, SD vs NVMe endurance,
2+ ELO models, DHCP-less site (fallback + RTC), and a network with no internet.

## Status / known issues

- ✅ P0 done 2026-09-29 on a Pi 5 + iiyama touch monitor (Pixart "Optical Touch", USB 093a:8020):
  `pi/install.sh` → `excontrol.service` + `excontrol-kiosk.service`, survives reboot.
- ✅ Kiosk mode (`?kiosk=1`): on-screen keyboard, no cursor on touch (transparent cursor theme +
  CSS arrow for a real mouse), no pinch-zoom / overscroll / long-press menu.
- ❗ **Touch dead after a cold boot until the USB cable is re-plugged.** At boot the panel binds
  to `hid-generic` (~4.3 s), then re-binds to `hid-multitouch` (~5.2 s); cage starts at ~14 s
  and libinput lists it as `touch`, yet no touches arrive until a replug. Suspects: the panel
  needs its multitouch mode (HID feature report) set after the re-bind, or USB autosuspend.
  Candidate fixes: `usbcore.autosuspend=-1` / per-device `power/control=on`, a udev rule that
  re-binds (unbind/bind) the device once `hid-multitouch` has it, or `usbreset` in kiosk.sh.
