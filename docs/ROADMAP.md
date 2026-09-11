# Roadmap

## Phase 1 — generalised core  ✅ (v0.1.0)

- Config v2: any number of devices of any type, per-screen **zones**, `poweredBy` power
  domains, presets + schedule in the one config file.
- Per-zone drivers (H-series, COEX), per-EPS **power domains** with independent
  off → starting → on and power-on presets.
- **Presets** replace the fixed "startup defaults": named cross-device configurations,
  applied on demand or as a power-on default.
- Scheduler actions: `power_on` / `power_off` / `apply_preset`, per power unit or all.
- Front-end renders whatever is configured; light + dark themes.

## Phase 2 — Electron shell  ✅

- `desktop/` workspace; server runs in the Electron main process.
- Tray icon (Open control panel / Check for updates / Quit), normal resizable window,
  single-instance lock.
- `electron-builder` → NSIS installer (`eXcontrol-Setup-<version>.exe`), per-machine;
  `build/installer.nsh` writes `HKLM\…\Run\eXcontrol` (auto-launch at any user login)
  and an inbound Windows Firewall rule for the app — both removed on uninstall.
  Config in `%ProgramData%\eXcontrol\`. Replaces the pm2 / scheduled-task deployment.
- Validated on CBLATest (Win10 1607): silent `/S` install → Run key + firewall rule
  present, app serves all four showroom devices from `C:\Program Files\eXcontrol\`.
- Open: custom app icon (still the default Electron icon); unsigned → SmartScreen.

## Phase 3 — setup wizard  ✅

- First-run web wizard (full-screen when unconfigured, re-openable as the **Devices**
  toolbar button): add/remove devices and zones, per-device **Test** button with inline
  decoded results, "use detected zones", inline OpenAPI-key instructions.
- Each driver has a static `probe(cfg)` — one-shot, no polling — decoding real errors:
  H-series `15` (OpenAPI entry disabled) / `13` (project not set up) / `912` (booting) /
  `5xx` (secret or encryption mismatch); COEX `404` (not a COEX box); EPS TCP refused vs.
  no reply vs. non-EPS banner; OBS `4009`/`4008` auth vs. server-off.
- `GET /api/setup/state` (secrets redacted to a sentinel), `POST /api/setup/probe`,
  `GET /api/setup/scan` (TCP knock across this machine's /24 on 8000/8001/5000/4455),
  `POST /api/setup/save` (validates, merges kept secrets, persists, restarts drivers
  in-process — presets/schedule untouched).
- Validated on CBLATest against the showroom EPS + OBS (decoded ok/auth/unreachable);
  H/COEX success + status-code paths still to confirm against a powered-on room.
- Network discovery is a TCP port sweep, not NovaStar UDP broadcast (protocol unknown).

## Hardening (ongoing, alongside the phases)

- **Test suite**: 2 → 80 tests — schedule math, config validation + secret redaction,
  the power-domain state machine (every branch) incl. multi-EPS, preset application, the
  settings-password/auth routes end-to-end (Fastify `.inject()`), and every driver's
  `probe()` error decoding against fake servers. Test files are type-checked.
- **Fixed** (found by hardware + review): power domain now shows "starting up" (not a
  fault) when eXcontrol boots next to an already-on wall; `deletePreset` disables schedule
  entries that referenced it; wizard re-points `poweredBy` on an EPS rename; brightness
  slider debounces keyboard input.
- **Multi-device — validated on real hardware**: the showroom now runs **two H-series
  controllers** simultaneously (`h9` on the power domain, a second always-on `H-2`) plus
  MX40 and EPS, confirmed via CBLATest. Multi-EPS is still simulation-tested only.
- **Settings password**: an optional shared password (Devices → App settings) gates
  device setup and preset/schedule *editing* only — zone control, power and preset
  *apply* stay open to any phone on the LAN. Salted-hash storage, bearer tokens
  (in-memory, 30-day TTL), `POST /api/auth/{login,verify,set-password}`. Forgotten
  password recovers by deleting the hash/salt from the config file.
- **Configurable port**: settable from the same App settings section; the backend rebinds
  its HTTP listener live (`registerHttpRestarter`/`restartHttpServer`) and the browser
  follows automatically. Devices don't restart for a pure port change.
- **Bitfocus Companion**: works today via its Generic HTTP module against eXcontrol's
  existing control endpoints — no eXcontrol changes needed. See
  [`COMPANION.md`](COMPANION.md). A native `@companion-module` package (dropdowns, live
  feedback) is future work, not started.

## Phase 4 — update checker

- `electron-updater` against public GitHub Releases (no token, `autoDownload: false`).
  Needs a release process first (tag + CI or `electron-builder --publish` to attach the
  installer **and** `latest.yml` to a GitHub Release).
- On launch + manual "Check for updates": **Install now / Skip this version / Remind me
  later**. Unsigned build → SmartScreen "More info → Run anyway" (documented).

## Known gaps / decisions pending

- Default Electron icon everywhere (taskbar, tray, installer) — needs artwork.
- Subnet scan sweeps every LAN interface incl. Tailscale/virtual adapters (harmless, just
  slower and noisier than scoping to real LANs only).
- TLS: deliberately not done — plain HTTP on a trusted LAN, per the network-model note in
  the README.
- Multi-EPS: covered by simulation tests, never run on real multi-unit hardware.

## Phase 5 — portability & support

- Config export / import (one file — pre-stage installs, survive PC swaps).
- "Export diagnostics" — logs + redacted config + last probe results, as a zip.

## Not planned

- Per-EPS-output control (no protocol yet — the schema leaves room).
- Code signing (later).
- Remote-support tooling.
- Multi-site in one process.
