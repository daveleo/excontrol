# Test report: eXcontrol on Raspberry Pi, overnight robustness, security and UX run

**Date:** 2026-09-29 18:10 → 2026-09-30 04:30 · **Branch:** `pi-kiosk` · **Tester:** Claude
(autonomous, remote) · **Method:** strict. Every claim below was measured on the unit or proven
with a reproduction *before* fixing, and every fix was re-tested the same way. Where a test was
invalid (rig error), it says so and was repeated.

## 1. Test object

| | |
|---|---|
| Hardware | Raspberry Pi 5 8 GB, 64 GB SD card (UHS-I), iiyama touch monitor (Pixart "Optical Touch" USB `093a:8020`) |
| OS | Raspberry Pi OS Lite 64-bit (Debian 13 trixie), kernel 6.18, systemd 257 |
| Stack | Node 22.23, Chromium 154, cage 0.3.1 (wlroots 0.20), keyd 2.5 |
| eXcontrol | branch `pi-kiosk` (0.3.1 + Pi work), `pi/install.sh` → `excontrol` + `excontrol-kiosk` services |

**Phase 1 (18:10–23:40), isolated:** every device simulated, Tailscale `accept-routes` off, the H9
verified unreachable (HTTP 000). No real hardware contacted.
**Phase 2 (23:40–04:30), real showroom devices, with the owner's approval:**
- The Pi ran the real showroom config with **its schedule disabled and no automatic power-on
  scene**, so it only acts when someone presses a button on it.
- Reach: OBS via the playout PC's own Tailscale address; the H9 via an approved `/32` route.
- COEX, EPS and eXview need their `/32` routes approved in the Tailscale admin console; that
  approval was still pending (see §6).

**Test rig (not shipped):**
- **DevTools:** Chromium's DevTools protocol on `127.0.0.1:9222`, via a root-only drop-in using the
  new `EXCONTROL_KIOSK_FLAGS`; used for page state and injected touch.
- **Virtual input devices:** a kernel-level (uinput) **keyboard** and **multitouch screen**. These
  take the same path as real USB hardware: evdev → keyd/libinput → cage → Chromium.
- **Tooling:** a write-load generator, a post-boot health checker, and `grim -c` screenshots with
  pixel diffs against a reference.
- **Journal:** made persistent for the run (Pi OS defaults to `Storage=volatile`).

## 2. Findings

Severity is *for a commercial appliance*. ✅ = fixed and re-tested · 📝 = decision needed.

| # | Sev. | Finding | Evidence | Status |
|---|---|---|---|---|
| F4 | **Critical** | **A power cut during a config save destroyed the whole configuration.** After hard resets under write load, `excontrol.config.json` came back as **199 bytes of NUL**. The backend started *unconfigured*, and the empty config then made the cache clean-up delete every device's last-known state. | Series A: **2/2 resets** | ✅ durable writes (fsync file + dir), last-good copy, quarantine and restore, no cache prune with 0 devices. Series B: **16/16 clean** |
| F1 | High | A corrupt config started the system unconfigured **without saying so**: the customer screen showed "Off, nothing scheduled", and a wizard save would have overwritten the damaged file. Valid JSON that failed validation made `loadConfig` throw, a **permanent crash loop**. | truncated-config test; code | ✅ recovery + banner; 6 tests |
| F6 | High | **CSRF:** with no password (the default), any website opened by anyone on the LAN could `POST /api/power/all/off`, and scenes and raw EPS actions the same way. **WebSocket hijack:** foreign pages could read the whole live state. `GET /api/setup/scan` (a subnet sweep) was triggerable by an `<img>`. | live exploit: 200 + log "target off" | ✅ `api/crossSite.ts` on `/api/*` + `/ws`. Exploit 403, hijack 403, Companion-style 200, same-origin 200; 11 tests |
| F13 | High | **Kiosk escape with a keyboard:** `--kiosk` covers only Chromium's first window. **Ctrl+N / Ctrl+T / Alt+Home** opened a browser window/tab with an address bar over the kiosk, and `http://localhost:8080` (the installer dashboard) was allowed. Ctrl+H/J opened history/downloads; Alt+F4 closed the kiosk. | uinput keyboard, fresh kiosk per key, ≈99.6 % pixels changed | ✅ `keyd` drops browser shortcuts at evdev level: **16/16 → 0.00 %**; positive control passes (Tab still works). Plus a Chromium policy (DevTools blocked, URL allow-list, no files/print/downloads) |
| F3 | High | Files written without `fsync` come back **empty** after a power cut (rig files written ~30 s before a reset). | 0-byte files | ✅ `core/durableWrite.ts` |
| F16 | Medium | **The schedule endpoint "repaired" garbage:** a malformed request (50 000-deep nested arrays) returned 200 and **replaced the whole schedule** with an invented every-day 17:00 power-off. | live | ✅ strict validation: 400, schedule untouched (live re-test); test |
| F5 | Medium | **SD-card wear:** the device cache was rewritten every ~2 s (≈43 000/day) with no change. | stat counter | ✅ content changes only; `lastSeen` ≤ once per 5 min |
| F9 | Medium | The diagnostics zip contained the H-series **pId**, which alone authenticates when API encryption is off. | unzip + grep | ✅ redacted; test |
| F7 | Medium | Config file mode `644`: device passwords readable by every local account. | `ls -l` | ✅ `UMask=0077` → `600`, data dir `0700` |
| F10 | Medium | Backend service unconfined: `systemd-analyze security` **9.2 UNSAFE**. | systemd-analyze | ✅ sandbox → **1.6 OK**; writes outside the data dir → EROFS |
| F14 | Medium | A backend unavailable > 60 s at kiosk start left the **customer looking at Chromium's white "This site can't be reached"** page. | screenshot | ✅ unbounded wait; recovered 0.01 % from normal |
| F15 | Medium | **Clickjacking:** no anti-framing headers, so a foreign page could frame the dashboard. | code; live headers after fix | ✅ XFO DENY, CSP frame-ancestors, nosniff, no-referrer; test |
| F11 | Medium | **Cursor mid-screen on a touch-only screen:** a zero-movement "mouse" event at compositor start switched the page into mouse mode. | DevTools: `kiosk-mouse` at start | ✅ click or ≥ 10 px of travel; deterministic test |
| F17 | Medium | **Headline guessed:** with the power unit unreachable (the room was actually off), the bar said "Standby". "Starting…" screens counted as standby. | real config on the Pi | ✅ "Unknown — Can't reach Power", "Standby" only for dark screens |
| F2 | Low | The default systemd start limit could stop a restart loop for good; it was avoided only by margin. | port-held crash loop: 16 restarts, recovered | ✅ no limit + back-off |
| F8 | Design | Without a password, `GET /api/config/export` returns **all device credentials** to the LAN (by the documented trusted-LAN model). | curl | 📝 recommend requiring a password for export / at first setup |
| F12 | Design | Image defaults: SSH password login on; the service user has full sudo. | sshd config, `sudo -l` | 📝 appliance image (P4) |

## 3. Results by area

### Power cuts (hard reset = `sysrq b`, no sync, under continuous config writes)
| Series | Code | Resets | Config valid | Cache valid | Real fs errors | Backend up | Kiosk up |
|---|---|---|---|---|---|---|---|
| A | before | 2 | **0/2** (NUL bytes) | 2/2, then wiped to `{}` | 0 | 15.6 s | 18 s |
| B | durable writes + recovery (+ sandbox, keyd, policy for 108–116) | **16** | **16/16** | 16/16 | **0** | 17.6–22.3 s | 20.1–24.8 s |

Fisher's exact test A vs B: **p ≈ 0.0065**. With 0/16 failures, the 95 % upper bound on the
residual failure rate is ≈ 19 %; more cycles would tighten it. The touch reset ran on every boot.
(The checker's early "2 ext4 errors" were journald's "journal uncleanly shut down" notices,
expected after a power cut; the filter was corrected.) The last chunk was stopped by the host PC's
memory pressure, not by a failure.

### Crash recovery (SIGKILL, screen polled against a reference every 2 s)
Chromium → **5 s** · cage → **8 s** · backend (page stays loaded, reconnects) → **13 s**.
Port held by another process: 16 restarts, automatic recovery once freed.

### Full disk (0 bytes free for the service user)
Save → **HTTP 500 "Couldn't save the settings to disk (ENOSPC)…"**; config on disk untouched and
valid; backend up, 0 restarts; after freeing space, saving works (before: a silent "saved").
Rig note: a first attempt's unbounded `dd` fallback wrote 6.5 GB before being stopped (rig error,
fixed).

### Kiosk / touch
- **On-screen keyboard** (injected touch): opens on text (44 keys) and number (digits only)
  fields, types into React-controlled fields, ⌫, one-shot ⇧, Done, physical key closes it, field
  stays above the keyboard. Config untouched.
- **Zoom:** pinch and double-tap → scale 1.0; the control (lock removed) → 4.0. `--disable-pinch`
  alone did not stop an injected pinch; the CSS `touch-action` lock does.
- **Touch path end to end:** a kernel-level multitouch device drove the page (tap, 2.6 s hold).
- **Touch after a cold boot (the iiyama):** the software re-plug runs on every boot, and the new
  HID instance is bound directly by `hid-multitouch`, as on a physical re-plug. **A human touch on
  the real panel after a reboot is still the final proof.**

### Network security (from the LAN)
Anti-framing and hygiene headers ✓ · path traversal (6 variants) → 403 or app shell, no leak ✓ ·
2 MB body → 413 ✓ · deep nesting → backend alive (F16 fixed) · brute force: 5×401 then 429, also
for the correct password and with a spoofed `X-Forwarded-For` ✓ · no token → state, export,
diagnostics, power 401 ✓ · forged token 401, WebSocket without token 401 ✓. `/health` shows
version and device status unauthenticated (low; by design, for monitoring).

### Real showroom devices (phase 2)
- OBS scene switched from the Pi in **0.14 s**; the showroom PC's own 0.3.1 saw the change within
  2 s; restored to "Playback" (verified on the showroom PC).
- H9 reachable via the approved route (room powered off at night → correctly "unavailable").
- COEX, EPS, eXview: **not reachable** without the pending route approval; the UI correctly shows
  "Unknown — Can't reach Power".

## 4. Human-first UX changes (from the review of 0.3.1 and the customer view)
- **Headline:** the room name instead of "Everything"; "Partly on" replaced by what's true ("On ·
  LED wall is dark"); "Unknown" when the power unit can't be reached (F17).
- **One truth about presets:** "Live" only where the device reports it (OBS, eXview); H-series and
  COEX say **"Last chosen"**; nothing is "live" on an unpowered screen.
- **Setup › device › On the dashboard:** per-preset visibility (service/test looks hidden from both
  dashboards, still usable in scenes) and **customer input names** for the preset pictures.
- **Pictures:** preset pictures in the standard dashboard's H-series cards too.
- **Less noise:** "+1 hour" and the countdown only in the last 2 h; no schedule count badge;
  connection dot only when disconnected; OFF grey; no theme toggle in the customer view; one theme
  across both views.
- **Explanations:** the second tap explains Turn off (≈ 1 min to restart) vs Standby (back in
  seconds); ★ explained ("starts with the room").
- **Two modes, one device:** **press and hold the brand for 2 s** switches customer view ↔ standard
  dashboard (verified with the virtual touchscreen: a short tap does nothing, the hold switches,
  the round trip is pixel-identical).

## 5. Test suite
186 → **209** automated tests, all passing: config recovery (6), CSRF/headers/diagnostics/
schedule validation (13), device cache (2), dashboard settings (2).

## 6. Open items / decisions
1. **Tailscale routes** 172.22.40.15/.20/.22/.127 on `showroom-aarhus` await approval in the admin
   console; without them the Pi can't reach COEX, EPS or eXview.
2. **Touch after reboot:** touch the iiyama once after a reboot.
3. **F8** (export without a password) and **F12** (image hardening: SSH keys only, a service user
   without sudo) are product decisions.
4. **Input names** (e.g. CSE1, 2-2, 3-2) should get customer names in Setup; that needs site
   knowledge.
5. **Two controllers** (showroom PC + Pi) polling the same EPS is a known firmware risk: dropped
   connections.
