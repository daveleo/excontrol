---
name: eXcontrol
status: active
priority: 3
version: v0.3.1 (released) · pi-kiosk branch in progress
deadline:
next: Clean up the test Pi, then run the real-device test list for the pi-kiosk branch
updated: 2026-10-07
repo: daveleo/excontrol
url: https://daveleo.github.io/excontrol/
---

# eXcontrol

Free web control overlay for LED installations: NovaStar H-series / COEX, Expromo EPS power, eXview displays and OBS. Installable Windows app plus a Raspberry Pi appliance in progress. Successor of Showroom Control (archived 2026-10-07).

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
- Related: `projects\companion-eps` (standalone Companion module for EPS)
