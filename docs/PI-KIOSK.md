# eXcontrol on Raspberry Pi: kiosk appliance (branch `pi-kiosk`)

Goal: a self-contained, commercial-grade eXcontrol appliance on a Raspberry Pi 5. It is reachable
on the network like the Windows build, can drive a local monitor or touchscreen (ELO,
iiyama, any USB-HID touch panel, mouse or keyboard), and keeps running through power cuts and
bad networks.

Related docs:
[`PRESET-VISUALIZATION.md`](PRESET-VISUALIZATION.md) (drawn preset thumbnails and the
customer view), [`SIMULATED-DEVICES.md`](SIMULATED-DEVICES.md) (demo devices), and the branch
summary with its merge plan in [`ROADMAP.md`](ROADMAP.md) → *Phase 15*.

---

## 1. Platform decision

**Raspberry Pi OS Lite (64-bit, Debian 13 "Trixie")**, with no desktop environment.

- It has first-party support for Pi 5 firmware, the EEPROM bootloader, RP1, the RTC and hardware
  video. No other distro matches it.
- It is Debian underneath: apt, systemd, NetworkManager, and `.deb` packaging.
- For the local screen, **cage** (a single-app Wayland kiosk compositor) runs **Chromium** in
  `--kiosk` mode against `http://localhost:<port>`. There is no desktop, panel or login screen.
- There is a clear path to a golden image: `rpi-image-gen` / `pi-gen` build it in CI, and the
  same image can run on a Compute Module 5 (eMMC) for volume production.

Rejected options:

| Option | Why not |
|---|---|
| Ubuntu Server/Core | weaker Pi 5 support, snaps |
| Yocto/Buildroot | best possible appliance, but months of BSP work; revisit at fleet scale |
| BalenaOS | cloud lock-in |
| Electron on the Pi | not needed: the backend is plain Node and Chromium is the UI |

The port was cheap. The backend is pure JS (fastify, ws, obs-websocket-js, fflate, crypto-js)
with **no native modules**, and the data directory already came from `EXCONTROL_DATA_DIR`. The
same `backend/dist/cli.js` that runs from source on Windows runs unchanged on arm64.

### Recommended hardware (per unit)

- Pi 5 (4 GB is plenty; 8 GB for development), official 27 W PSU, active cooler or passive
  metal case.
- **RTC battery** (official ML-2020). The scheduler depends on the correct time, and a site
  without NTP would otherwise boot at the wrong time.
- Storage: NVMe via M.2 HAT+ (preferred) or an industrial/high-endurance SD card.
- Optional: a PoE+ HAT, for one cable per install.
- For volume production later: **CM5 with eMMC** on an industrial/DIN-rail carrier.

---

## 2. What is in the repo (`pi/`)

| File | What it does |
|---|---|
| `pi/install.sh` | Development install from a git checkout: renders the two systemd units (user, app dir and data dir substituted), installs cage + Chromium if missing, enables and starts both services. `sudo ./pi/install.sh [user]` |
| `pi/systemd/excontrol.service` | The backend: `node backend/dist/cli.js`, `Restart=always` with back-off and no start limit, sandboxed (`ProtectSystem=strict`, no capabilities, syscall filter, `UMask=0077`; `systemd-analyze security` 1.6 OK) — only the data folder is writable |
| `pi/systemd/excontrol-kiosk.service` | The local display: a logind session on **tty1** (`PAMName=login`, `TTYPath=/dev/tty1`, `Conflicts=getty@tty1`), runs `pi/kiosk.sh`, restarts itself |
| `pi/kiosk.sh` | Waits for the backend (no time limit, so there's never a browser error page), prepares the Chromium profile and the invisible cursor theme, then `exec cage -- chromium --kiosk …`. `EXCONTROL_KIOSK_VIEW=full` shows the standard dashboard; `EXCONTROL_KIOSK_FLAGS` adds Chromium flags (test rig only) |
| `pi/touch-reset.sh` | Runs as root before the kiosk, once per boot: re-enumerates every USB touchscreen (a software re-plug; fixes "touch dead after a cold boot") |
| `pi/chromium-policy.json` | → `/etc/chromium/policies/managed/`: no DevTools, only `http://localhost`, no files/downloads/print/extensions/incognito/sign-in |
| `pi/keyd-kiosk.conf` | → `/etc/keyd/default.conf`: drops browser shortcuts (new window/tab, address bar, history, DevTools, zoom, close, VT switch) from physical keyboards at evdev level |
| `pi/demo/excontrol.config.json` | A generic, showroom-shaped demo: every device `simulated` |
| `pi/demo/apply.sh` | Loads a demo folder into the unit's config (keeps the `app` section, backs up config + device cache). `sh pi/demo/apply.sh [dir]` |

### Fresh unit, from zero (about 15 minutes)

1. Raspberry Pi Imager → Pi 5 → *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**.
   In the customisation step, set the hostname (`excontrol`), a user, SSH with a key, locale
   and timezone.
2. Boot on Ethernet, SSH in, then run:
   ```bash
   sudo apt update && sudo apt full-upgrade -y
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -   # Debian's Node is too old (engines >=22)
   sudo apt install -y nodejs git cage chromium
   git clone -b pi-kiosk https://github.com/daveleo/excontrol.git && cd excontrol
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build   # skip Electron's binary, the Pi doesn't use it
   sudo ./pi/install.sh
   ```
3. The dashboard appears on the HDMI screen in about 15 s, and on the network at
   `http://<pi-ip>:8080` / `http://excontrol.local:8080`.

Update a unit: `cd ~/excontrol && git pull && npm run build && sudo systemctl restart excontrol excontrol-kiosk`.

### Operations cheat-sheet

| Task | Command |
|---|---|
| Live backend log | `journalctl -u excontrol -f` |
| Reload the local screen | `sudo systemctl restart excontrol-kiosk` |
| A text console on the Pi itself | Ctrl+Alt+F2 on an attached keyboard (cage runs with `-s`) |
| Screenshot the local screen over SSH | `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim -c /tmp/s.png` (`-c` includes the cursor; `sudo apt install grim`) |
| Show the installer dashboard on the local screen | systemd drop-in for `excontrol-kiosk` with `Environment=EXCONTROL_KIOSK_VIEW=full` |

---

## 3. Lessons from bring-up (why things are the way they are)

- **A kiosk must own the local console.** Running `cage` from an SSH session (or behind a
  foreground backend) never reaches HDMI. It needs a logind session on seat0/tty1, which is
  why the kiosk is a systemd unit with `PAMName=login` + `TTYPath=/dev/tty1`.
- **Pi 5 HDMI:** the monitor was on the second port (`HDMI-A-2`); cage drives whichever is
  connected. Check `/sys/class/drm/card1-HDMI-A-*/status`.
- **Ctrl+C / SIGTERM hung the backend forever.** This is a real bug that also affected the
  Windows build (both of its fixes are platform-neutral):
  1. `ws` v8 no longer closes live clients on `wss.close()` when attached to an external
     server. An open dashboard kept `app.close()` waiting indefinitely, both on shutdown
     *and* on the port-change rebind. Fix: `backend/src/api/ws.ts` terminates clients on
     detach.
  2. `backend/src/cli.ts` now runs one shutdown at a time, with a hard 5 s cap; a second
     signal exits immediately. Measured after the fix: `systemctl restart excontrol` took 40 ms.
- **`pkill -f <pattern>` over SSH kills its own session** when the pattern also appears in
  the SSH command line. Use a bracket pattern: `pkill -f "[d]ist/cli.js"`.

---

## 4. Kiosk mode (`?kiosk=1`)

The local screen loads `http://localhost:<port>/?kiosk=1&view=simple`. `kiosk=1` switches on
touch-appliance behaviour, and `view=simple` selects the customer view (see
[`PRESET-VISUALIZATION.md`](PRESET-VISUALIZATION.md)). Browsers on the network never get
`kiosk=1`. The three port-change navigations (`SettingsSections.tsx` ×2, `SetupWizard.tsx`)
now carry `location.search`, so the flags survive a rebind.

### 4.1 On-screen keyboard (`frontend/src/components/OnScreenKeyboard.tsx`)

cage has no system OSK: it doesn't implement the layer-shell/input-method protocols
squeekboard needs. So **the page brings its own**, which also makes it identical on every
unit and brandable.

- It is mounted in `main.tsx` **next to** `<App/>`, not inside it, so it also serves the
  access-gate password field (App has early returns).
- **Opens** on `focusin` of a text-like field (`text/password/number/search/email/url/tel`,
  textarea), but only if the last pointer was not a mouse (`lastPointerType` in `lib/kiosk.ts`).
  **Closes** on focus leaving a field, on ⌄, on Done, and on any *trusted* key press (a
  physical keyboard means the OSK should step aside).
- Layouts: letters (with a digits row, `.` and `-`, so IP addresses are easy), symbols, and a
  **digits-only** keypad for `type=number`/`inputmode=numeric`. It is digits-only because
  `type=number` sanitises `"80."` or `"-"` to `""`, so one stray key would wipe the field.
- **Typing into React-controlled inputs:** the value is set through the *native* prototype
  setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`), then an
  `input` event is dispatched, so React's `onChange` fires. Caret-aware insert/backspace via
  `selectionStart/End`; `type=number` has no selection API (null), so it edits at the end.
- **Never steals focus:** `preventDefault` on the keyboard's `pointerdown` *and* `mousedown`,
  and every key is `tabIndex={-1}`.
- **Done** submits the field's form (`form.requestSubmit()`), e.g. the password prompt.
- **Layout:** it sets `--osk-h` + `.osk-open` on `<html>`. `body` gets bottom padding, and the
  full-screen layers (`.modal-scrim`, `.wizard`, `.setup`) end at the keyboard's top edge, so
  the focused field is scrolled into view above it (`scrollIntoView({block:"center"})`).

### 4.2 Cursor

On a touch-only screen, an arrow sat in the middle of the screen forever. Investigation:

1. It was **not** cage's own cursor: cage leaves the image to the focused client
   (`wlr_cursor_set_surface`). Pointing only cage at a transparent theme changed nothing.
2. It was **Chromium's**: Chromium takes pointer focus at start-up and draws its theme arrow.
   Blink won't apply the page's `cursor: none` until a real mouse event gives it a pointer
   position, which never happens on a touch-only screen.

Solution (two parts):

- `pi/kiosk.sh` generates a **1×1 fully transparent Xcursor theme** (a 68-byte file written
  by an inline Node script: header, one TOC entry, one image chunk, one ARGB pixel of 0) as
  `default` + `left_ptr`, and sets `XCURSOR_PATH` for cage **and** Chromium. Nothing drawn
  from a theme can ever be visible.
- `frontend/src/lib/kiosk.ts` toggles `kiosk-mouse` / `kiosk-no-cursor` on `<html>` from
  `pointermove`/`pointerdown` `pointerType`. In mouse mode, `styles.css` gives every element
  a **CSS image cursor** (an inline SVG arrow). Chromium renders CSS image cursors itself,
  independent of the theme, so a real mouse still gets a pointer, and touching hides it again.

Verified with `grim -c` (screenshot including the cursor layer): nothing is drawn.

### 4.3 No zoom, no page dragging

- Chromium flags: `--disable-pinch`, `--overscroll-history-navigation=0`.
- CSS on `.kiosk`: `touch-action: pan-x pan-y` (pan only, no pinch; this constrains every
  descendant), `overscroll-behavior: none`, `user-select: none` (except fields), no tap
  highlight.
- JS: ctrl+wheel prevented; `contextmenu` (long-press), `dragstart` and `gesturestart`
  prevented.

### 4.4 Keyboard lockdown (keyd + Chromium policy)

`--kiosk` covers only Chromium's first window. Tested with a kernel-level keyboard, Ctrl+N /
Ctrl+T / Alt+Home opened a normal browser window with an address bar on top of the kiosk, and
`http://localhost:8080` (the installer dashboard) was reachable from there. Page JavaScript can't
block browser shortcuts, so:
- **keyd** (`pi/keyd-kiosk.conf`) drops them at evdev level, for every physical keyboard. Typing,
  Ctrl+A/C/V, Tab and Enter still work. 16/16 tested shortcuts → no effect; positive control
  passes.
- **The Chromium policy** (`pi/chromium-policy.json`) blocks DevTools (dialog "DevTools not
  allowed"), every URL except localhost, file dialogs, downloads, printing, extensions, incognito
  and sign-in. Note: it also blocks the DevTools *protocol*; the test rig sets the policy aside
  when it needs it.

A technician uses SSH or the network dashboard, not the kiosk keyboard.

### 4.5 Two views on one screen — the presenter gesture

The kiosk opens the **customer view**. **Press and hold the brand ("eXcontrol", top left) for
2 seconds** to switch to the **standard dashboard**, and the same gesture switches back. A normal tap
does nothing, so a customer never finds it. It works with touch and mouse, and on network browsers
too.

### 4.6 Other Chromium flags (`pi/kiosk.sh`)

`--noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble
--hide-crash-restore-bubble --disable-features=Translate,TranslateUI --password-store=basic
--check-for-update-interval=31536000 --ozone-platform=wayland`, with a dedicated
`--user-data-dir`. After a power cut the profile is marked crashed; `kiosk.sh` rewrites
`exited_cleanly`/`exit_type` in `Default/Preferences` so no restore bubble appears. The
script also waits up to 60 s for the backend, so Chromium never shows an error page on boot,
and reads the port from the config (it follows a port change on the next kiosk start).

---

## 5. Remote access (Tailscale)

- The test Pi runs Tailscale as **`excontrol-pi`** (installed with the official
  `install.sh`, then `tailscale up --hostname=excontrol-pi --qr`, which prints the approval
  link and a QR code).
- **The H9 in the showroom, from the test Pi:** the showroom PC advertises exactly one subnet
  route, **the H9's own address as a `/32`** (nothing else on the showroom LAN), via
  `tailscale set --advertise-routes=<h9-ip>/32`; it had no routes before. The Pi runs
  `tailscale set --accept-routes`. Verified: `ip route get <h9-ip>` → `dev tailscale0`,
  and the H9's web UI answers. To undo: `tailscale set --advertise-routes=` on the showroom PC.
  The H9 only answers while the showroom is powered on.
- House rule: **only the showroom's own eXcontrol runs against the showroom.** The Pi therefore
  simulates the showroom ([`SIMULATED-DEVICES.md`](SIMULATED-DEVICES.md)); the one real device on
  it is the H9's **HDMI_Out** screen, added for the visualization experiment. LED_All stays
  simulated, so the Pi cannot command the main wall.

---

## 6. Roadmap for the appliance

- **P0 — Smoke test** ✅
- **P2 (part) — kiosk** ✅: services, OSK, cursor, gestures, customer view. Still open:
  commissioning screen (IP + QR when unconfigured), display off at night via DPMS following
  the power state, rotation/scaling settings, and a localhost-trust option (the local screen
  skips the access password).

### P1 — Linux platform layer
- Data dir `/var/lib/excontrol`, a dedicated `excontrol` system user, logs to journald.
- Service hardening (`ProtectSystem=strict`, `NoNewPrivileges`, …).
- Bundle a pinned Node 22 arm64 runtime in `/opt/excontrol` (deterministic builds, no NodeSource).
- A `.deb` (arm64) built in GitHub Actions on `ubuntu-24.04-arm` (nfpm).
- OS-aware platform bits: Setup's autostart toggle, the updater, and diagnostics system info.

### P3 — Network
- NetworkManager, two profiles on `eth0`: `excontrol-dhcp` (`ipv4.method auto`,
  `dhcp-timeout 20`, higher priority) and `excontrol-fallback` (**`192.168.0.99/24`**, lower
  priority, used when DHCP fails; a timer retries DHCP).
- A Setup › Network page (DHCP/static, IP/mask/gateway/DNS, hostname, NTP) with **apply and
  auto-rollback**: the new IP must be confirmed from the new address within 90 s or it reverts.
- Changes go through a small privileged helper (polkit-scoped `nmcli`), not a root backend.
- mDNS (`excontrol.local`); Wi-Fi and Bluetooth off by default.

### P4 — Appliance hardening
Read-only root (overlayfs) plus a writable data partition (add fsync to the tmp+rename config
writes), hardware watchdog, nftables firewall (only the eXcontrol port and mDNS, SSH off unless
enabled), factory reset (GPIO long-press or an `excontrol-reset` file on the boot partition),
config seeding from the boot partition, and a branded quiet boot.

### P5 — Golden image
`rpi-image-gen` in CI produces `excontrol-pi-<ver>.img.xz`. First boot expands the data
partition, generates unique secrets and hostname (`excontrol-<serial4>`), and shows the
commissioning screen.

### P6 — Updates
Stage A: a signed `.deb` / own apt repo behind the existing *Install now*. Stage B (fleet
scale): A/B rootfs with RAUC or Mender, with automatic rollback.

### P7 — Validation
72 h soak test, 100 power pulls, heat test in the target enclosure, SD vs NVMe endurance,
2+ touch-panel models, a site without DHCP (fallback + RTC), and a site without internet.

---

## 7. Known issues

- 🔧 **Touch after a cold boot — fix in place, awaiting a human touch.** `pi/touch-reset.sh`
  re-enumerates the panel once per boot; the new HID instance is bound directly by
  `hid-multitouch`, exactly as after a physical re-plug (verified in 16+ reboots). The original
  analysis follows.
- **Originally: touch dead after a cold boot until the USB cable is re-plugged** (iiyama, Pixart
  "Optical Touch" `093a:8020`). At boot the panel binds to `hid-generic` (~4.3 s), then
  re-binds to `hid-multitouch` (~5.2 s). cage starts at ~14 s and libinput lists the device as
  `touch` (event1), yet no touches arrive until a replug. The panel also exposes a "Mouse"
  interface that libinput classifies as a *tablet*, which cage ignores. cage logs "cannot be
  mapped to an output device" (harmless with one screen). Suspects: the panel needs its
  multitouch mode (HID feature report) set after the re-bind, or USB autosuspend. Candidate
  fixes: `usbcore.autosuspend=-1` / per-device `power/control=on`, a udev rule that unbinds and
  rebinds the device once `hid-multitouch` has it, or a `usbreset` in `kiosk.sh`, which does
  what the replug does.
- Kiosk port changes are only picked up on the next kiosk start (`kiosk.sh` reads the port
  once).
