---
name: eXcontrol
status: active
priority: 3
version: v0.3.1 (released) · pi-kiosk branch in progress
deadline:
next: Clean up the test Pi, then run the real-device test list for the pi-kiosk branch
updated: 2026-11-04
repo: daveleo/excontrol
url: https://daveleo.github.io/excontrol/
---

# eXcontrol

Free web control overlay for LED installations: NovaStar H-series / COEX, Expromo EPS power, eXview displays and OBS. Installable Windows app plus a Raspberry Pi appliance in progress. Successor of Showroom Control (archived 2026-10-07).

## What it is for

One simple control screen (phone, tablet or the control PC) for an LED installation: room power on/standby/off, brightness, presets, blackout, scenes, schedules and OBS scenes across NovaStar H-series / COEX processors, Expromo EPS power units and eXview displays. Free, for showrooms, venues and customers who need operators to run the room without touching the processor software. Runs as a Windows app today; a Raspberry Pi 5 appliance is being built on branch `pi-kiosk`.

## How to run

- **Installed (normal use):** download the Windows installer from the latest GitHub Release (link on https://daveleo.github.io/excontrol/). The build is unsigned, so SmartScreen asks once: More info → Run anyway. It runs in the tray and serves the control panel on port 8080.
- **From source** (Node, version in `.nvmrc`):
  ```
  npm install
  npm run build --workspace shared   # once
  npm run dev:backend                # http://localhost:8080
  npm run dev:frontend               # http://localhost:5173, proxies to :8080
  ```
- **Tests:** `npm test` (backend), `npm run typecheck`.
- **Desktop app:** `npm run desktop:start` to run it, `npm run desktop:dist` to build the installer.
- **Release:** bump the version in every `package.json` (see CLAUDE.md), then push a `vX.Y.Z` tag; that publishes a public GitHub Release, so ask first.
- **Pi appliance** (branch `pi-kiosk`): `pi\install.sh` on a Raspberry Pi 5; details in `docs\PI-KIOSK.md`.

## How to use

1. Open `http://<control-pc>:8080` in any browser on the network.
2. On first run the setup wizard opens: add the devices (H-series needs its OpenAPI key), test each connection, done. Everything else is under **Setup** (gear icon): Devices, Groups, Scenes, System (room name, port, autostart, updates), Access (optional password), Backup.
3. Operate from the dashboard: the power bar turns the room on/off/standby (EPS units power up one at a time), group rows switch named sets of screens, scene chips apply saved looks, and each screen card has picture, brightness/volume and presets/inputs.
4. **Schedule** turns the room, a group or a power unit on/off or applies a scene daily or weekly.
5. Bitfocus Companion can drive it through its Generic HTTP module (`docs\COMPANION.md`).

The production config is `%ProgramData%\eXcontrol\excontrol.config.json`. Setup › Backup exports or imports it and downloads a redacted diagnostics zip.

## What is what

- `backend\`: Node server: device drivers (H-series, COEX, EPS, eXview, OBS), power engine, scheduler, API. Holds the tests.
- `frontend\`: the control panel (dashboard, setup, schedule).
- `shared\`: types shared by backend and frontend.
- `desktop\`: Windows tray app and installer build.
- `pi\`: Raspberry Pi kiosk install scripts, systemd units, Chromium policy, demo setup.
- `companion\`: eXcontrol's own Companion module (developer build, loaded with Companion's Import module package; see `companion\HELP.md`).
- `config\`: example config (`excontrol.config.example.json`); the real config and device cache are local only.
- `docs\`: `ROADMAP.md` (doubles as the detailed changelog), `POWER.md`, `PI-KIOSK.md`, `COMPANION.md`, `NETWORK.md`, `SECURITY.md`, `SIMULATED-DEVICES.md`, `PRESET-VISUALIZATION.md`, test reports.
- `.github\workflows\`: `ci.yml` (tests on push) and `release.yml` (Windows installer, triggered by `v*` tags).
- `.worktrees\gh-pages\`: the product website (gh-pages branch, served at daveleo.github.io/excontrol).
- Private infrastructure notes are in `projects\excontrol-private`, never here.

## Current state

v0.3.1 is released and running on the showroom PC: power engine with groups (On/Standby/Off, highest-wins), rebuilt EPS driver, eXview 3-state control, calm dashboard, phone layout. 186 backend tests pass.

Branch `pi-kiosk`: port to a Raspberry Pi 5 as a commercial-grade appliance. The first real-device test session (2026-09-30) did not get to the device tests; see docs/TEST-REPORT-PI-2026-09-30.md. The Pi is off the network and needs cleaning up before the next session.

Private infrastructure notes (hosts, access, showroom layout) are in `projects\excontrol-private`, never in this public repo.

## Milestones

- [x] 2026-09-23 — v0.3.0 power engine
- [x] 2026-09-24 — v0.3.1 calm dashboard, deployed to the showroom
- [ ] Pi kiosk: clean up test Pi, run real-device test list
- [ ] Companion module: EPS live retest
- [ ] Merge pi-kiosk into main and release

## Links

- Website (gh-pages): checked out at `.worktrees\gh-pages`
- Roadmap: docs/ROADMAP.md · Pi: docs/PI-KIOSK.md · Power: docs/POWER.md
- Private notes (infra, access, showroom layout): [[projects/excontrol-private/PROJECT|eXcontrol — private notes]]
- Related: [[projects/companion-eps/PROJECT|companion-eps]] (standalone Companion module for EPS), [[projects/EPS/PROJECT|EPS firmware]] (the power units it drives), [[projects/exview-control/PROJECT|eXview Control]] (eXview protocol work)
